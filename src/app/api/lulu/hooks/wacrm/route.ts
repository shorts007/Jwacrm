// ============================================================
// POST /api/lulu/hooks/wacrm  — receiver for WACRM's own outbound webhooks
//
// Registered by /api/lulu/hooks/setup as a normal WACRM webhook endpoint
// (events: message.received, message.status_updated), so no WACRM core code
// is modified. Every delivery is verified with the endpoint's HMAC secret
// (X-Wacrm-Signature), looked up via X-Wacrm-Webhook-Id.
//
//   message.received        STOP / إيقاف …  → opt the phone out (lulu_opt_outs +
//                                              profile marketing_opt_in = false), confirm
//                           START / ابدأ …   → opt back in, confirm
//   message.status_updated  delivered / read / failed for messages the LuLu
//                           engine sent → lulu_campaign_events
// Always answers 200 for verified deliveries so WACRM doesn't retry storms.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { verifySignatureHeader } from '@/lib/webhooks/sign';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import {
  OPT_IN_CONFIRMATION,
  OPT_OUT_CONFIRMATION,
  classifyReply,
  statusToEvent,
} from '@/lib/lulu/opt-out';

interface Envelope {
  id?: string;
  event?: string;
  account_id?: string;
  data?: Record<string, unknown>;
}

export async function POST(request: Request) {
  const raw = await request.text();
  const webhookId = request.headers.get('x-wacrm-webhook-id') ?? '';
  const signature = request.headers.get('x-wacrm-signature') ?? '';
  if (!webhookId || !signature) return NextResponse.json({ error: 'unsigned' }, { status: 401 });

  const db = supabaseAdmin();
  const { data: endpoint } = await db
    .from('webhook_endpoints')
    .select('id, account_id, secret, is_active')
    .eq('id', webhookId)
    .maybeSingle();
  if (!endpoint || !endpoint.is_active) return NextResponse.json({ error: 'unknown endpoint' }, { status: 401 });

  let secret: string;
  try {
    secret = decrypt(endpoint.secret as string);
  } catch {
    return NextResponse.json({ error: 'bad secret' }, { status: 401 });
  }
  if (!verifySignatureHeader(signature, raw, secret, Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const accountId = endpoint.account_id as string;
  if (env.account_id && env.account_id !== accountId) {
    return NextResponse.json({ error: 'account mismatch' }, { status: 401 });
  }

  try {
    if (env.event === 'message.received') await handleInbound(db, accountId, env.data ?? {});
    else if (env.event === 'message.status_updated') await handleStatus(db, accountId, env.data ?? {});
  } catch (err) {
    console.error('[lulu/hooks/wacrm] handler error:', err);
  }
  return NextResponse.json({ ok: true });
}

type Db = ReturnType<typeof supabaseAdmin>;

async function handleInbound(db: Db, accountId: string, data: Record<string, unknown>) {
  const intent = classifyReply(typeof data.text === 'string' ? data.text : null);
  if (!intent || typeof data.contact_id !== 'string') return;

  const { data: contact } = await db
    .from('contacts')
    .select('phone_normalized')
    .eq('id', data.contact_id)
    .eq('account_id', accountId)
    .maybeSingle();
  const digits = (contact?.phone_normalized as string | null) ?? null;
  if (!digits) return;
  const mobile = `+${digits}`;

  const { data: profile } = await db
    .from('lulu_customer_profiles')
    .select('customer_id')
    .eq('account_id', accountId)
    .eq('mobile', mobile)
    .maybeSingle();

  if (intent === 'stop') {
    await db.from('lulu_opt_outs').upsert(
      { account_id: accountId, phone_digits: digits, source: 'whatsapp_reply', keyword: String(data.text).slice(0, 40) },
      { onConflict: 'account_id,phone_digits' }
    );
    await db.from('lulu_customer_profiles').update({ marketing_opt_in: false }).eq('account_id', accountId).eq('mobile', mobile);
  } else {
    await db.from('lulu_opt_outs').delete().eq('account_id', accountId).eq('phone_digits', digits);
    await db.from('lulu_customer_profiles').update({ marketing_opt_in: true }).eq('account_id', accountId).eq('mobile', mobile);
  }

  await db.from('lulu_campaign_events').insert({
    account_id: accountId,
    customer_id: (profile?.customer_id as string | undefined) ?? digits,
    event_type: 'OPT_OUT',
    meta: { intent, keyword: String(data.text).slice(0, 40), conversation_id: data.conversation_id ?? null },
  });

  // Confirm inside the 24-hour window the customer's own reply just opened.
  if (typeof data.conversation_id === 'string') {
    try {
      await sendMessageToConversation(db, accountId, {
        conversationId: data.conversation_id,
        messageType: 'text',
        contentText: intent === 'stop' ? OPT_OUT_CONFIRMATION : OPT_IN_CONFIRMATION,
      });
    } catch (err) {
      console.error('[lulu/hooks/wacrm] confirmation send failed:', err);
    }
  }
}

async function handleStatus(db: Db, accountId: string, data: Record<string, unknown>) {
  const eventType = statusToEvent(typeof data.status === 'string' ? data.status : null);
  const wamid = typeof data.whatsapp_message_id === 'string' ? data.whatsapp_message_id : null;
  if (!eventType || !wamid) return;

  // Only messages the LuLu engine sent are tracked.
  const { data: action } = await db
    .from('lulu_customer_next_actions')
    .select('id, campaign_id, customer_id, offer_id')
    .eq('account_id', accountId)
    .eq('wa_message_id', wamid)
    .maybeSingle();
  if (!action) return;

  await db.from('lulu_campaign_events').upsert(
    {
      account_id: accountId,
      action_id: action.id,
      campaign_id: action.campaign_id,
      customer_id: action.customer_id,
      offer_id: action.offer_id,
      wa_message_id: wamid,
      event_type: eventType,
    },
    { onConflict: 'account_id,wa_message_id,event_type', ignoreDuplicates: true }
  );
}
