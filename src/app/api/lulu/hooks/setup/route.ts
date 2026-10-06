// ============================================================
// /api/lulu/hooks/setup   (admin+, cookie session)
//   GET  → is the LuLu receiver registered? + opt-out count
//   POST → register it as a WACRM webhook endpoint (idempotent)
// The endpoint points back at this same deployment:
//   <site>/api/lulu/hooks/wacrm   events: message.received, message.status_updated
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { generateWebhookSecret } from '@/lib/webhooks/endpoints';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

const PATH = '/api/lulu/hooks/wacrm';
const EVENTS = ['message.received', 'message.status_updated'];

function receiverUrl(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '');
  const base = site && site.startsWith('https://') ? site : new URL(request.url).origin;
  return `${base}${PATH}`;
}

async function status(accountId: string, url: string) {
  const db = supabaseAdmin();
  const [{ data: rows }, { count }, { data: logRows }, { data: optOutRows }] = await Promise.all([
    db
      .from('webhook_endpoints')
      .select('id, url, events, is_active, failure_count, last_delivery_at')
      .eq('account_id', accountId)
      .like('url', `%${PATH}`),
    db.from('lulu_opt_outs').select('phone_digits', { count: 'exact', head: true }).eq('account_id', accountId),
    db
      .from('lulu_hook_log')
      .select('received_at, event, outcome, detail')
      .eq('account_id', accountId)
      .order('received_at', { ascending: false })
      .limit(15),
    db
      .from('lulu_opt_outs')
      .select('phone_digits, opted_out_at, keyword')
      .eq('account_id', accountId)
      .order('opted_out_at', { ascending: false })
      .limit(10),
  ]);
  const active = (rows ?? []).find((r) => r.is_active && r.url === url);
  return {
    configured: !!active,
    url,
    endpoint: active ?? (rows ?? [])[0] ?? null,
    optOuts: count ?? 0,
    recentOptOuts: optOutRows ?? [],
    log: logRows ?? [],
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    return NextResponse.json(await status(ctx.accountId, receiverUrl(request)));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const url = receiverUrl(request);
    const action = new URL(request.url).searchParams.get('action');

    if (action === 'ping') {
      // Sign a synthetic delivery exactly like WACRM does and POST it to the receiver.
      const { data: ep } = await supabaseAdmin()
        .from('webhook_endpoints')
        .select('id, secret')
        .eq('account_id', ctx.accountId)
        .eq('url', url)
        .eq('is_active', true)
        .maybeSingle();
      if (!ep) return NextResponse.json({ error: 'Not enabled yet — click Enable first.' }, { status: 400 });
      const payload = JSON.stringify({ id: crypto.randomUUID(), event: 'lulu.ping', occurred_at: new Date().toISOString(), account_id: ctx.accountId, data: {} });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wacrm-Event': 'lulu.ping',
          'X-Wacrm-Webhook-Id': ep.id as string,
          'X-Wacrm-Signature': buildSignatureHeader(payload, decrypt(ep.secret as string), Math.floor(Date.now() / 1000)),
        },
        body: payload,
        redirect: 'manual',
      }).catch((e: unknown) => ({ ok: false, status: 0, statusText: e instanceof Error ? e.message : 'fetch failed' }) as Response);
      return NextResponse.json({
        ping: res.ok ? 'ok' : `failed (HTTP ${res.status} ${res.statusText ?? ''})`.trim(),
        ...(await status(ctx.accountId, url)),
      });
    }

    if (!url.startsWith('https://')) {
      return NextResponse.json({ error: `Webhooks need a public https URL; got ${url}. Set NEXT_PUBLIC_SITE_URL.` }, { status: 400 });
    }
    const current = await status(ctx.accountId, url);
    if (current.configured) return NextResponse.json(current);

    const { error } = await supabaseAdmin().from('webhook_endpoints').insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      url,
      secret: encrypt(generateWebhookSecret()),
      events: EVENTS,
    });
    if (error) {
      console.error('[lulu/hooks/setup] insert error:', error);
      return NextResponse.json({ error: 'Failed to register the webhook' }, { status: 500 });
    }
    return NextResponse.json(await status(ctx.accountId, url));
  } catch (err) {
    return toErrorResponse(err);
  }
}
