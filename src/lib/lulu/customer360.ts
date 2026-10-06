/**
 * Customer 360 — loads everything the LuLu layer knows about one phone number
 * (browser client, RLS: account members). Shared by the inbox sidebar card and
 * the full customer page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { campaignFromRow, policyFromRow, type CampaignRow, type PolicyRow } from "./defaults";
import { daysSince, lifecycleStage, thresholdsFromCampaigns } from "./lifecycle";
import { decideNextBestAction } from "./next-best-action";
import { OFFER_COLUMNS, offerExpiry, offerFromRow, offerText, type Offer, type OfferRow } from "./offers";
import { profileFromRow, type DryRunProfileRow } from "./dry-run";
import type { LifecycleStage, PastSend } from "./types";

export interface Profile360 extends DryRunProfileRow {
  first_order_date: string | null;
  average_order_value: number | string | null;
  orders_30d: number | null;
  orders_90d: number | null;
  stddev_interval_days: number | string | null;
  preferred_channel: string | null;
  preferred_category: string | null;
  stores_used: number | null;
  discount_order_share: number | string | null;
  avg_discount_pct: number | string | null;
  total_discount: number | string | null;
  rfm_recency: number | null;
  rfm_frequency: number | null;
  rfm_monetary: number | null;
  lifecycle_stage: string | null;
  city: string | null;
  synced_at: string | null;
  active: boolean;
}

export interface Touch360 {
  id: string;
  campaignName: string;
  campaignType: string | null;
  status: string;
  skipReason: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  templateName: string | null;
  offer: { code: string; text: string; validUntil: string } | null;
  delivered: boolean;
  read: boolean;
  replied: boolean;
  orders: { orderId: string; value: number; at: string }[];
}

export interface Customer360 {
  digits: string;
  profile: Profile360 | null;
  stage: LifecycleStage | null;
  daysSinceOrder: number | null;
  nextExpectedOrder: string | null; // YYYY-MM-DD from personal cycle
  optedOut: { at: string; keyword: string | null } | null;
  languagePref: "ar" | "en" | null;
  touches: Touch360[];
  next: { campaign: string; reason: string; live: boolean } | null;
  nextSkipped: { campaign: string; reason: string }[];
}

const PROFILE_SELECT =
  "customer_id, mobile, name, language, birthday, first_order_date, last_order_date, total_orders, total_sales, average_order_value, orders_30d, orders_90d, median_interval_days, stddev_interval_days, vip_flag, marketing_opt_in, active_complaint, suspect_reason, preferred_store, preferred_store_id, preferred_channel, preferred_category, stores_used, price_sensitivity, discount_order_share, avg_discount_pct, total_discount, customer_segment, rfm_recency, rfm_frequency, rfm_monetary, lifecycle_stage, city, synced_at, active";

export const phoneDigits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export async function loadCustomer360(db: SupabaseClient, accountId: string, digits: string, now = new Date()): Promise<Customer360> {
  const [prof, opt, lang, acts, camps, pol] = await Promise.all([
    db.from("lulu_customer_profiles").select(PROFILE_SELECT).eq("account_id", accountId).eq("mobile", `+${digits}`).maybeSingle(),
    db.from("lulu_opt_outs").select("opted_out_at, keyword").eq("account_id", accountId).eq("phone_digits", digits).maybeSingle(),
    db.from("lulu_language_prefs").select("language").eq("account_id", accountId).eq("phone_digits", digits).maybeSingle(),
    db
      .from("lulu_customer_next_actions")
      .select("id, campaign_id, offer_id, status, skip_reason, last_error, created_at, sent_at, template_name")
      .eq("account_id", accountId)
      .eq("is_test", false)
      .eq("customer_id", digits)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("lulu_campaigns")
      .select("id, campaign_code, name, campaign_type, rule_params, offer_id, active, mode, status")
      .eq("account_id", accountId),
    db.from("lulu_contact_policy").select("*").eq("account_id", accountId).maybeSingle(),
  ]);

  const actions = acts.data ?? [];
  const actionIds = actions.map((a) => a.id as string);
  const offerIds = [...new Set(actions.map((a) => a.offer_id as string | null).filter((x): x is string => !!x))];
  const [evs, offs] = await Promise.all([
    actionIds.length
      ? db.from("lulu_campaign_events").select("action_id, event_type, order_id, order_value, occurred_at").in("action_id", actionIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    offerIds.length ? db.from("lulu_offers").select(OFFER_COLUMNS).in("id", offerIds) : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const campById = new Map((camps.data ?? []).map((c) => [c.id as string, c]));
  const offerById = new Map<string, Offer>(((offs.data ?? []) as OfferRow[]).map((o) => [o.id, offerFromRow(o)]));

  const touches: Touch360[] = actions.map((a) => {
    const e = (evs.data ?? []).filter((x) => x.action_id === a.id);
    const camp = campById.get(a.campaign_id as string);
    const offer = a.offer_id ? offerById.get(a.offer_id as string) : undefined;
    const sentAt = (a.sent_at as string | null) ?? null;
    return {
      id: a.id as string,
      campaignName: (camp?.name as string) ?? "—",
      campaignType: (camp?.campaign_type as string) ?? null,
      status: a.status as string,
      skipReason: (a.skip_reason as string | null) ?? null,
      lastError: (a.last_error as string | null) ?? null,
      createdAt: a.created_at as string,
      sentAt,
      templateName: (a.template_name as string | null) ?? null,
      offer: offer && sentAt
        ? { code: offer.offerCode, text: offerText(offer, "en"), validUntil: offerExpiry(offer, new Date(sentAt)) }
        : null,
      delivered: e.some((x) => x.event_type === "DELIVERED" || x.event_type === "READ"),
      read: e.some((x) => x.event_type === "READ"),
      replied: e.some((x) => x.event_type === "REPLIED"),
      orders: e
        .filter((x) => x.event_type === "ORDER_ATTRIBUTED")
        .map((x) => ({ orderId: String(x.order_id), value: Number(x.order_value ?? 0), at: x.occurred_at as string })),
    };
  });

  const profile = (prof.data as Profile360 | null) ?? null;
  let stage: LifecycleStage | null = null;
  let next: Customer360["next"] = null;
  let nextSkipped: Customer360["nextSkipped"] = [];
  const allCampaigns = (camps.data ?? []).map((c) => campaignFromRow(c as unknown as CampaignRow));
  if (profile) {
    const p = profileFromRow(profile);
    if (opt.data) p.marketingOptIn = false;
    stage = lifecycleStage(p, now, thresholdsFromCampaigns(allCampaigns));
    // What would the engine do for this customer today? LIVE campaigns first; else a dry-run view.
    const liveIds = new Set((camps.data ?? []).filter((c) => c.active && c.mode === "LIVE" && c.status !== "PAUSED").map((c) => c.id));
    const live = allCampaigns.filter((c) => liveIds.has(c.id));
    const pool = live.length ? live : allCampaigns.map((c) => ({ ...c, active: true }));
    const history: PastSend[] = touches
      .filter((t) => t.status === "SENT" && t.sentAt)
      .map((t) => ({ sentAt: new Date(t.sentAt!), isPromo: true }));
    const received = new Set(
      actions
        .filter((a) => a.status === "SENT" || a.skip_reason === "holdout")
        .map((a) => campById.get(a.campaign_id as string)?.campaign_code as string)
        .filter(Boolean),
    );
    const r = decideNextBestAction({
      profile: p,
      campaigns: pool,
      policy: policyFromRow(pol.data as PolicyRow | null),
      history,
      now,
      lastOrderAt: profile.last_order_date ? new Date(`${profile.last_order_date}T23:59:59+03:00`) : null,
      receivedCampaignCodes: received,
    });
    const nameOf = (code: string) => allCampaigns.find((c) => c.code === code)?.name ?? code;
    next = r.action ? { campaign: nameOf(r.action.campaignCode), reason: r.action.reason, live: live.length > 0 } : null;
    nextSkipped = r.skipped.map((s) => ({ campaign: nameOf(s.campaignCode), reason: s.reason }));
  }

  const dso = profile ? daysSince(profile.last_order_date, now) : null;
  const median = profile?.median_interval_days == null ? null : Number(profile.median_interval_days);
  const nextExpectedOrder =
    profile?.last_order_date && median && profile.total_orders >= 3
      ? new Date(Date.parse(`${profile.last_order_date}T00:00:00Z`) + Math.round(median) * 86_400_000).toISOString().slice(0, 10)
      : null;

  const l = lang.data?.language as string | undefined;
  return {
    digits,
    profile,
    stage,
    daysSinceOrder: dso,
    nextExpectedOrder,
    optedOut: opt.data ? { at: opt.data.opted_out_at as string, keyword: (opt.data.keyword as string | null) ?? null } : null,
    languagePref: l === "ar" || l === "en" ? l : null,
    touches,
    next,
    nextSkipped,
  };
}
