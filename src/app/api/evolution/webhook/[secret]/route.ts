// ============================================================
// POST /api/evolution/webhook/<secret>  — receiver for Evolution API events.
//
// The secret in the URL identifies the account (Evolution webhooks are not signed).
// Phase 1 handles the connection lifecycle (CONNECTION_UPDATE, QRCODE_UPDATED) and
// records every other event (redacted) in evolution_event_log. Message handling
// (MESSAGES_UPSERT / MESSAGES_UPDATE / SEND_MESSAGE) is added in phase 3.
// Always answers 200 quickly so Evolution does not retry.
// ============================================================
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { jidDigits } from '@/lib/evolution/client';
import { logEvolutionEvent } from '@/lib/evolution/server';

interface Delivery {
  event?: string;
  instance?: string;
  data?: Record<string, unknown>;
}

const norm = (e: string | undefined) => (e ?? '').toLowerCase().replace(/_/g, '.');

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  if (!/^[a-f0-9]{48}$/.test(secret)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const db = supabaseAdmin();
  const { data: cfg } = await db
    .from('evolution_config')
    .select('account_id, instance_name, connected_number')
    .eq('webhook_secret', secret)
    .maybeSingle();
  if (!cfg) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: Delivery;
  try {
    body = (await request.json()) as Delivery;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const accountId = cfg.account_id as string;
  const event = norm(body.event);
  if (body.instance && body.instance !== cfg.instance_name) {
    await logEvolutionEvent(accountId, event, 'ignored_other_instance', { instance: body.instance });
    return NextResponse.json({ ok: true });
  }

  const now = new Date().toISOString();
  try {
    if (event === 'connection.update') {
      const d = body.data ?? {};
      const state = typeof d.state === 'string' ? d.state : 'unknown';
      const number = typeof d.wuid === 'string' ? jidDigits(d.wuid) : null;
      await db
        .from('evolution_config')
        .update({
          state: ['open', 'connecting', 'close'].includes(state) ? state : 'unknown',
          last_event_at: now,
          ...(state === 'open' ? { qr_code: null } : {}),
          ...(number ? { connected_number: number } : {}),
          ...(typeof d.profileName === 'string' ? { profile_name: d.profileName } : {}),
          // a dropped connection must stop Evolution being used for new sends
          ...(state === 'close' ? { is_default_outbound: false } : {}),
        })
        .eq('account_id', accountId);
      await logEvolutionEvent(accountId, event, state, body.data);
    } else if (event === 'qrcode.updated') {
      const q = (body.data?.qrcode ?? body.data) as Record<string, unknown> | undefined;
      const qr = typeof q?.base64 === 'string' ? q.base64 : null;
      await db.from('evolution_config').update({ qr_code: qr, qr_updated_at: now, last_event_at: now }).eq('account_id', accountId);
      await logEvolutionEvent(accountId, event, qr ? 'qr_updated' : 'no_qr');
    } else {
      await db.from('evolution_config').update({ last_event_at: now }).eq('account_id', accountId);
      // Phase 3 will route these into the inbox; for now keep samples for diagnostics.
      await logEvolutionEvent(accountId, event, 'recorded', body);
    }
  } catch (err) {
    await logEvolutionEvent(accountId, event, 'error', { error: err instanceof Error ? err.message : String(err) });
  }
  return NextResponse.json({ ok: true });
}
