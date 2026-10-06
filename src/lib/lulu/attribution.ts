/**
 * Holdout (control group) assignment and order attribution — pure.
 */

/** FNV-1a 32-bit. Deterministic, so a customer stays in (or out of) a campaign's control group. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** True when this customer belongs to the campaign's holdout (not messaged) group. */
export function isHoldout(customerId: string, campaignCode: string, holdoutPct: number): boolean {
  if (!(holdoutPct > 0)) return false;
  return fnv1a(`${campaignCode}:${customerId}`) % 1000 < Math.min(1000, Math.round(holdoutPct * 10));
}

export interface Touch {
  actionId: string;
  campaignId: string;
  customerId: string; // phone digits
  at: Date; // sent_at (message) or created_at (holdout)
  windowDays: number;
  control: boolean;
}

export interface OrderIn {
  orderId: string;
  digits: string;
  placedAt: Date;
  amount: number;
  discount: number;
}

export interface Attributed {
  orderId: string;
  actionId: string;
  campaignId: string;
  customerId: string;
  kind: "ORDER_ATTRIBUTED" | "CONTROL_ORDER";
  value: number;
  discount: number;
  placedAt: Date;
}

/**
 * Last-touch attribution: an order belongs to the most recent message sent to that phone
 * within the campaign's window before the order. Orders by holdout customers inside the
 * same kind of window become CONTROL_ORDER (used to estimate what would have happened anyway).
 * A real message always wins over a holdout record.
 */
export function attributeOrders(orders: OrderIn[], touches: Touch[]): Attributed[] {
  const byPhone = new Map<string, Touch[]>();
  for (const t of touches) {
    if (!byPhone.has(t.customerId)) byPhone.set(t.customerId, []);
    byPhone.get(t.customerId)!.push(t);
  }
  const out: Attributed[] = [];
  for (const o of orders) {
    const list = byPhone.get(o.digits);
    if (!list) continue;
    const inWindow = list.filter(
      (t) => t.at.getTime() <= o.placedAt.getTime() && o.placedAt.getTime() <= t.at.getTime() + t.windowDays * 86_400_000,
    );
    if (inWindow.length === 0) continue;
    const pick = (ts: Touch[]) => ts.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    const sent = inWindow.filter((t) => !t.control);
    const t = sent.length ? pick(sent) : pick(inWindow);
    out.push({
      orderId: o.orderId,
      actionId: t.actionId,
      campaignId: t.campaignId,
      customerId: t.customerId,
      kind: t.control ? "CONTROL_ORDER" : "ORDER_ATTRIBUTED",
      value: o.amount,
      discount: o.discount,
      placedAt: o.placedAt,
    });
  }
  return out;
}

/** Conversion lift vs the control group, with a flag when the control group is too small to trust. */
export function lift(sent: number, converted: number, holdout: number, controlConverted: number) {
  const conv = sent ? converted / sent : null;
  const ctrl = holdout ? controlConverted / holdout : null;
  return {
    conversion: conv,
    controlConversion: ctrl,
    liftPoints: conv !== null && ctrl !== null ? conv - ctrl : null,
    incrementalCustomers: conv !== null && ctrl !== null ? Math.round((conv - ctrl) * sent) : null,
    reliable: holdout >= 100 && sent >= 300,
  };
}
