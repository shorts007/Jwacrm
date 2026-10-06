// ============================================================
// POST /api/v1/lulu/attribution/sync   (scope: contacts:write)
//
// Revenue attribution (PRD §59). n8n posts recent delivered orders from
// BigQuery; each order placed within a campaign's attribution window after
// a LuLu message to that phone becomes ORDER_ATTRIBUTED (last touch). Orders
// by HOLDOUT customers in the same window become CONTROL_ORDER, which is how
// the results page estimates what would have happened without the message.
// Idempotent: an order is recorded once (unique index on order_id).
//
// Body: { orders: [ { order_id, phone, placed_at, amount, discount_amount } ] }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { attributeOrders, type OrderIn, type Touch } from '@/lib/lulu/attribution';
import { normalizeMobile } from '@/lib/lulu/phone';

export const maxDuration = 60;
const MAX_ORDERS = 20_000;
const DAY = 86_400_000;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const db = ctx.supabase;
    const accountId = ctx.accountId;
    const body = (await request.json().catch(() => null)) as { orders?: unknown } | null;
    if (!body || !Array.isArray(body.orders)) return fail('bad_request', 'Body must be { orders: [...] }', 400);
    if (body.orders.length > MAX_ORDERS) return fail('bad_request', `Too many orders (max ${MAX_ORDERS})`, 400);

    const orders: OrderIn[] = [];
    let rejected = 0;
    for (const raw of body.orders as Record<string, unknown>[]) {
      const mobile = normalizeMobile(raw?.phone == null ? null : String(raw.phone));
      const placedAt = new Date(String(raw?.placed_at ?? ''));
      const orderId = raw?.order_id == null ? '' : String(raw.order_id);
      const amount = Number(raw?.amount);
      if (!mobile || !orderId || Number.isNaN(placedAt.getTime()) || !Number.isFinite(amount)) {
        rejected++;
        continue;
      }
      orders.push({ orderId, digits: mobile.replace(/\D/g, ''), placedAt, amount, discount: Number(raw?.discount_amount) || 0 });
    }
    if (orders.length === 0) return ok({ attributed: 0, control: 0, rejected });

    const earliest = Math.min(...orders.map((o) => o.placedAt.getTime()));
    const [{ data: campaigns }, { data: actions, error }] = await Promise.all([
      db.from('lulu_campaigns').select('id, attribution_days').eq('account_id', accountId),
      db
        .from('lulu_customer_next_actions')
        .select('id, campaign_id, customer_id, status, skip_reason, sent_at, created_at')
        .eq('account_id', accountId)
        .eq('is_test', false)
        .or('status.eq.SENT,skip_reason.eq.holdout')
        .gte('created_at', new Date(earliest - 31 * DAY).toISOString())
        .range(0, 99999),
    ]);
    if (error) throw error;
    const windowById = new Map((campaigns ?? []).map((c) => [c.id as string, Number(c.attribution_days ?? 7)]));
    const touches: Touch[] = (actions ?? [])
      .filter((a) => a.campaign_id)
      .map((a) => ({
        actionId: a.id as string,
        campaignId: a.campaign_id as string,
        customerId: String(a.customer_id).replace(/\D/g, ''),
        at: new Date(((a.status === 'SENT' ? a.sent_at : a.created_at) ?? a.created_at) as string),
        windowDays: windowById.get(a.campaign_id as string) ?? 7,
        control: a.status !== 'SENT',
      }));

    const matched = attributeOrders(orders, touches);
    const rows = matched.map((m) => ({
      account_id: accountId,
      action_id: m.actionId,
      campaign_id: m.campaignId,
      customer_id: m.customerId,
      event_type: m.kind,
      order_id: m.orderId,
      order_value: m.value,
      discount_cost: m.discount,
      occurred_at: m.placedAt.toISOString(),
    }));
    let saved = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error: upErr } = await db
        .from('lulu_campaign_events')
        .upsert(rows.slice(i, i + 500), { onConflict: 'account_id,event_type,order_id', ignoreDuplicates: true })
        .select('id');
      if (upErr) {
        console.error('[lulu/attribution] upsert error:', upErr);
        return fail('internal', `Failed to save attribution: ${upErr.message}`, 500);
      }
      saved += data?.length ?? 0;
    }
    return ok({
      orders_received: orders.length,
      rejected,
      attributed: matched.filter((m) => m.kind === 'ORDER_ATTRIBUTED').length,
      control: matched.filter((m) => m.kind === 'CONTROL_ORDER').length,
      newly_saved: saved,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
