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
import { encrypt } from '@/lib/whatsapp/encryption';

const PATH = '/api/lulu/hooks/wacrm';
const EVENTS = ['message.received', 'message.status_updated'];

function receiverUrl(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '');
  const base = site && site.startsWith('https://') ? site : new URL(request.url).origin;
  return `${base}${PATH}`;
}

async function status(accountId: string, url: string) {
  const db = supabaseAdmin();
  const [{ data: rows }, { count }] = await Promise.all([
    db.from('webhook_endpoints').select('id, url, events, is_active').eq('account_id', accountId).like('url', `%${PATH}`),
    db.from('lulu_opt_outs').select('phone_digits', { count: 'exact', head: true }).eq('account_id', accountId),
  ]);
  const active = (rows ?? []).find((r) => r.is_active && r.url === url);
  return { configured: !!active, url, endpoints: rows ?? [], optOuts: count ?? 0 };
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
