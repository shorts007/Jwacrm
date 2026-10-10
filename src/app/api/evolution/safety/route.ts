// GET  /api/evolution/safety  (admin+) — warm-up, today's limit and usage, health, pause state.
// POST /api/evolution/safety  (admin+)
//   { action: 'settings', maxDaily, windowStartHour, windowEndHour, autoPause }
//   { action: 'resume' }          clear an automatic / manual pause
//   { action: 'pause' }           stop campaign sends through the app number now
//   { action: 'skip_warmup' }     number already has a long sending history
//   { action: 'restart_warmup' }  e.g. after switching to a new number
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { evolutionSetupError, loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server';
import { safetySummary } from '@/lib/evolution/safety-server';
import { WARMUP_DAYS } from '@/lib/evolution/safety';

const fail = (err: unknown) => {
  const setup = evolutionSetupError(err);
  if (setup) return NextResponse.json({ error: setup }, { status: 500 });
  return toErrorResponse(err);
};

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const summary = await safetySummary(ctx.accountId);
    if (!summary) return NextResponse.json({ configured: false });
    return NextResponse.json({ configured: true, warmupDays: WARMUP_DAYS, ...summary });
  } catch (err) {
    return fail(err);
  }
}

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Connect the WhatsApp app number first.' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const now = new Date().toISOString();
    let patch: Record<string, unknown>;
    switch (body.action) {
      case 'settings': {
        const maxDaily = int(body.maxDaily);
        const start = int(body.windowStartHour);
        const end = int(body.windowEndHour);
        if (!(maxDaily >= 1 && maxDaily <= 1000)) return NextResponse.json({ error: 'Max per day must be 1–1000.' }, { status: 400 });
        if (!(start >= 0 && start <= 23 && end >= 1 && end <= 24 && start < end)) {
          return NextResponse.json({ error: 'Sending hours: start 0–23, end 1–24, start before end.' }, { status: 400 });
        }
        patch = { max_daily: maxDaily, window_start_hour: start, window_end_hour: end, auto_pause: body.autoPause !== false };
        break;
      }
      case 'resume':
        patch = { paused_at: null, paused_reason: null };
        break;
      case 'pause':
        patch = { paused_at: now, paused_reason: 'paused by hand' };
        break;
      case 'skip_warmup':
        patch = { warmup_started_at: new Date(Date.now() - (WARMUP_DAYS + 1) * 86_400_000).toISOString() };
        break;
      case 'restart_warmup':
        patch = { warmup_started_at: now };
        break;
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
    const { error } = await supabaseAdmin()
      .from('evolution_config')
      .update({ ...patch, updated_by: ctx.userId, updated_at: now })
      .eq('account_id', ctx.accountId);
    if (error) throw error;
    await logEvolutionEvent(ctx.accountId, 'safety', String(body.action));
    return NextResponse.json({ ok: true, ...(await safetySummary(ctx.accountId)) });
  } catch (err) {
    return fail(err);
  }
}
