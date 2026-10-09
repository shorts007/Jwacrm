// POST /api/evolution/connect  (admin+)
// Makes sure the instance exists (creates a Baileys instance if not), points its webhook at
// WACRM, and returns the current state plus a QR code to scan when not yet linked.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { EvolutionError, connect, connectionState, createInstance, fetchInstance, findWebhookUrl, jidDigits, setWebhook } from '@/lib/evolution/client';
import { connFromRow, loadEvolutionConfig, logEvolutionEvent, webhookUrl, evolutionSetupError } from '@/lib/evolution/server';
import { encrypt } from '@/lib/whatsapp/encryption';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as { takeOver?: boolean };
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Save the Evolution settings first.' }, { status: 400 });
    const db = supabaseAdmin();
    let conn = connFromRow(row);
    const steps: string[] = [];

    try {
      let info = await fetchInstance(conn);
      if (!info) {
        const created = await createInstance(conn);
        steps.push(`created instance ${conn.instance}`);
        if (created.token) {
          // Keep only the instance's own token: it cannot touch other instances (e.g. your stock-alert one).
          await db.from('evolution_config').update({ api_key: encrypt(created.token) }).eq('account_id', ctx.accountId);
          conn = { ...conn, apiKey: created.token };
          steps.push('stored the instance token instead of the global key');
        }
        info = await fetchInstance(conn).catch(() => null);
      } else {
        steps.push(`instance ${conn.instance} found`);
      }

      const ourHook = webhookUrl(request, row.webhook_secret);
      if (info && !steps.some((s) => s.startsWith('created'))) {
        // Guard: an instance that already exists and is not wired to WACRM probably belongs to
        // something else on the same server (e.g. stock alerts). Taking it over would redirect its
        // webhook and mix its number into CRM traffic, so ask for explicit confirmation first.
        const current = await findWebhookUrl(conn).catch(() => null);
        if (current !== ourHook && !body.takeOver) {
          await logEvolutionEvent(ctx.accountId, 'connect', 'needs_confirmation', { steps, currentWebhook: current ? 'other' : 'none' });
          return NextResponse.json(
            {
              needsConfirmation: true,
              error:
                `Instance "${conn.instance}" already exists on the Evolution server and is not linked to WACRM` +
                (current ? ' (its webhook points to another app)' : '') +
                '. If another app uses it (e.g. stock alerts), choose a new instance name instead.',
              steps,
            },
            { status: 409 },
          );
        }
        if (current !== ourHook) steps.push('took over existing instance (confirmed)');
      }

      await setWebhook(conn, ourHook);
      steps.push('webhook set');

      const state = await connectionState(conn);
      let qr: string | null = null;
      let pairingCode: string | null = null;
      if (state !== 'open') {
        const c = await connect(conn);
        qr = c.qr;
        pairingCode = c.pairingCode;
      }
      const number = info?.ownerJid ? jidDigits(info.ownerJid) : null;
      await db
        .from('evolution_config')
        .update({
          state,
          qr_code: qr,
          qr_updated_at: qr ? new Date().toISOString() : row.qr_updated_at,
          ...(number ? { connected_number: number } : {}),
          ...(info?.profileName ? { profile_name: info.profileName } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', ctx.accountId);
      await logEvolutionEvent(ctx.accountId, 'connect', state, { steps });
      return NextResponse.json({ state, qr, pairingCode, connectedNumber: number, steps });
    } catch (e) {
      const msg = e instanceof EvolutionError ? e.message : e instanceof Error ? e.message : String(e);
      await logEvolutionEvent(ctx.accountId, 'connect', 'error', { steps, error: msg });
      const hint =
        e instanceof EvolutionError && e.status === 401
          ? ' — the API key was rejected (use the server key AUTHENTICATION_API_KEY, or this instance\'s token).'
          : e instanceof EvolutionError && e.status === 0
            ? ' — check the address is reachable from the internet over HTTPS.'
            : '';
      return NextResponse.json({ error: msg + hint, steps }, { status: 502 });
    }
  } catch (err) {
    const setup = evolutionSetupError(err);
    if (setup) return NextResponse.json({ error: setup }, { status: 500 });
    return toErrorResponse(err);
  }
}
