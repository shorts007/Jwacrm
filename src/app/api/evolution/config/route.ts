// GET  /api/evolution/config  — Evolution channel status for the account (admin+). Never returns the API key.
// POST /api/evolution/config  — save { baseUrl, instance, apiKey? }   (apiKey optional when updating)
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { normalizeBaseUrl } from '@/lib/evolution/client';
import { loadEvolutionConfig, newWebhookSecret, webhookUrl, evolutionSetupError } from '@/lib/evolution/server';
import { encrypt } from '@/lib/whatsapp/encryption';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ configured: false });
    const { data: events } = await supabaseAdmin()
      .from('evolution_event_log')
      .select('received_at, event, outcome')
      .eq('account_id', ctx.accountId)
      .order('id', { ascending: false })
      .limit(15);
    return NextResponse.json({
      configured: true,
      baseUrl: row.base_url,
      instance: row.instance_name,
      state: row.state,
      connectedNumber: row.connected_number,
      profileName: row.profile_name,
      qr: row.state === 'open' ? null : row.qr_code,
      qrUpdatedAt: row.qr_updated_at,
      lastEventAt: row.last_event_at,
      isDefaultOutbound: row.is_default_outbound,
      webhookUrl: webhookUrl(request, row.webhook_secret).replace(/[a-f0-9]{48}$/, '••••'),
      events: events ?? [],
    });
  } catch (err) {
    const setup = evolutionSetupError(err);
    if (setup) return NextResponse.json({ error: setup }, { status: 500 });
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as { baseUrl?: string; instance?: string; apiKey?: string } | null;
    const baseUrl = normalizeBaseUrl(body?.baseUrl ?? '');
    const instance = (body?.instance ?? '').trim();
    const apiKey = (body?.apiKey ?? '').trim();
    if (!baseUrl) return NextResponse.json({ error: 'Enter the Evolution server address, e.g. https://evo.yourdomain.com' }, { status: 400 });
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(instance))
      return NextResponse.json({ error: 'Instance name: 3–40 letters, digits, - or _ (e.g. wacrm-lulu).' }, { status: 400 });

    const db = supabaseAdmin();
    const existing = await loadEvolutionConfig(ctx.accountId);
    if (!existing && !apiKey) return NextResponse.json({ error: 'Enter the Evolution API key.' }, { status: 400 });

    const row = {
      account_id: ctx.accountId,
      base_url: baseUrl,
      instance_name: instance,
      ...(apiKey ? { api_key: encrypt(apiKey) } : {}),
      ...(existing ? {} : { webhook_secret: newWebhookSecret(), created_by: ctx.userId }),
      // instance changed → forget the old connection details
      ...(existing && existing.instance_name !== instance ? { state: 'unknown', connected_number: null, profile_name: null, qr_code: null } : {}),
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    };
    const { error } = existing
      ? await db.from('evolution_config').update(row).eq('account_id', ctx.accountId)
      : await db.from('evolution_config').insert(row);
    if (error) {
      return NextResponse.json(
        { error: evolutionSetupError(error) ?? error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      warning: baseUrl.startsWith('http://')
        ? 'This address is not HTTPS — the API key travels unencrypted. Put Evolution behind an HTTPS domain before going live.'
        : null,
    });
  } catch (err) {
    const setup = evolutionSetupError(err);
    if (setup) return NextResponse.json({ error: setup }, { status: 500 });
    return toErrorResponse(err);
  }
}
