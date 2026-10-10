// POST /api/evolution/default  (admin+)  { on: boolean }
// "Send through this number": when on, campaigns, broadcasts and new conversations go out through
// the Evolution (WhatsApp app) number; chats keep replying on the number the customer wrote to.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { evolutionSetupError, loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as { on?: unknown };
    if (typeof body.on !== 'boolean') return NextResponse.json({ error: 'Send { on: true | false }.' }, { status: 400 });
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Connect the WhatsApp app number first.' }, { status: 400 });
    if (body.on && row.state !== 'open') {
      return NextResponse.json({ error: 'The number is not connected — connect it (scan the QR code) before making it the default sender.' }, { status: 400 });
    }
    const { error } = await supabaseAdmin()
      .from('evolution_config')
      .update({
        is_default_outbound: body.on,
        updated_by: ctx.userId,
        updated_at: new Date().toISOString(),
        // The warm-up ramp starts the first time the number becomes the default sender.
        ...(body.on && !row.warmup_started_at ? { warmup_started_at: new Date().toISOString() } : {}),
      })
      .eq('account_id', ctx.accountId);
    if (error) throw error;
    await logEvolutionEvent(ctx.accountId, 'default_sender', body.on ? 'on' : 'off');
    return NextResponse.json({ ok: true, isDefaultOutbound: body.on });
  } catch (err) {
    const setup = evolutionSetupError(err);
    if (setup) return NextResponse.json({ error: setup }, { status: 500 });
    return toErrorResponse(err);
  }
}
