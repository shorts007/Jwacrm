// ============================================================
// POST /api/evolution/webhook/<secret>  — receiver for Evolution API events.
//
// The secret in the URL identifies the account (Evolution webhooks are not signed).
//   CONNECTION_UPDATE / QRCODE_UPDATED → live status + QR on Engagement → Channels
//   MESSAGES_UPSERT  → inbox (customer messages, and messages typed on the phone)
//   MESSAGES_UPDATE  → delivered / read ticks
// Every delivery is logged (redacted) in evolution_event_log for diagnostics.
// Answers 200 at once and processes in after(), so Evolution never retries.
// ============================================================
import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { jidDigits } from '@/lib/evolution/client';
import { receiveUpdates, receiveUpsert, resolveOwnerUserId } from '@/lib/evolution/receive';
import { connFromRow, logEvolutionEvent, type EvolutionConfigRow } from '@/lib/evolution/server';

export const maxDuration = 60;

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
    .select('*')
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
        })
        .eq('account_id', accountId);
      await logEvolutionEvent(accountId, event, state, body.data);
    } else if (event === 'qrcode.updated') {
      const q = (body.data?.qrcode ?? body.data) as Record<string, unknown> | undefined;
      const qr = typeof q?.base64 === 'string' ? q.base64 : null;
      await db.from('evolution_config').update({ qr_code: qr, qr_updated_at: now, last_event_at: now }).eq('account_id', accountId);
      await logEvolutionEvent(accountId, event, qr ? 'qr_updated' : 'no_qr');
    } else if (event === 'messages.upsert' || event === 'messages.update') {
      const row = cfg as EvolutionConfigRow;
      after(async () => {
        try {
          await db.from('evolution_config').update({ last_event_at: now }).eq('account_id', accountId);
          let outcome: string;
          if (event === 'messages.update') {
            outcome = await receiveUpdates(body.data);
          } else {
            const ownerUserId = await resolveOwnerUserId(accountId, row.created_by);
            outcome = ownerUserId
              ? await receiveUpsert(body.data, { accountId, ownerUserId, conn: connFromRow(row) })
              : 'no_owner_user';
          }
          await logEvolutionEvent(accountId, event, outcome, body);
        } catch (err) {
          await logEvolutionEvent(accountId, event, 'error', { error: err instanceof Error ? err.message : String(err), body });
        }
      });
    } else {
      await db.from('evolution_config').update({ last_event_at: now }).eq('account_id', accountId);
      await logEvolutionEvent(accountId, event, 'ignored', body);
    }
  } catch (err) {
    await logEvolutionEvent(accountId, event, 'error', { error: err instanceof Error ? err.message : String(err) });
  }
  return NextResponse.json({ ok: true });
}
