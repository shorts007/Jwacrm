/**
 * Server-side LuLu helpers (database I/O). Import only from route handlers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { campaignFromRow, policyFromRow, type CampaignRow, type PolicyRow } from "./defaults";
import type { DryRunProfileRow } from "./dry-run";
import { DEFAULT_SEND_SETTINGS, type SendSettings } from "./sender";
import { chooseTemplateKind, type TemplateChoiceKind } from "./messages";
import { OFFER_COLUMNS, offerFromRow, type Offer, type OfferRow } from "./offers";
import type { CampaignConfig, ContactPolicy } from "./types";

const PAGE = 1000;
const PARALLEL = 8;
export const PROFILE_COLUMNS =
  "customer_id, mobile, name, language, birthday, last_order_date, total_orders, total_sales, median_interval_days, vip_flag, marketing_opt_in, active_complaint, suspect_reason, preferred_store, price_sensitivity, customer_segment, preferred_store_id";

/** All ACTIVE synced profiles of the account (paged; PostgREST returns ≤1000 rows per call). */
export async function loadActiveProfiles(db: SupabaseClient, accountId: string): Promise<DryRunProfileRow[]> {
  const { count, error } = await db
    .from("lulu_customer_profiles")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("active", true);
  if (error) throw error;
  const pages = Math.ceil((count ?? 0) / PAGE);
  const rows: DryRunProfileRow[] = [];
  for (let start = 0; start < pages; start += PARALLEL) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(PARALLEL, pages - start) }, (_, i) => {
        const from = (start + i) * PAGE;
        return db
          .from("lulu_customer_profiles")
          .select(PROFILE_COLUMNS)
          .eq("account_id", accountId)
          .eq("active", true)
          .order("customer_id")
          .range(from, from + PAGE - 1);
      }),
    );
    for (const b of batch) {
      if (b.error) throw b.error;
      rows.push(...((b.data ?? []) as unknown as DryRunProfileRow[]));
    }
  }
  return rows;
}

export interface LiveCampaign extends CampaignConfig {
  templateAr: string | null;
  templateEn: string | null;
  templateBi: string | null;
  holdoutPct: number;
  attributionDays: number;
}

/** Campaigns allowed to send to customers right now: Live switch on, mode LIVE, not paused/stopped. */
export async function loadLiveCampaigns(db: SupabaseClient, accountId: string): Promise<LiveCampaign[]> {
  const { data, error } = await db
    .from("lulu_campaigns")
    .select("id, campaign_code, name, campaign_type, rule_params, offer_id, active, mode, status, template_name_ar, template_name_en, template_name_bilingual, holdout_pct, attribution_days")
    .eq("account_id", accountId)
    .eq("active", true)
    .eq("mode", "LIVE");
  if (error) throw error;
  return (data ?? [])
    .filter((r) => !["PAUSED", "CANCELLED", "COMPLETED", "REJECTED"].includes(r.status as string))
    .map((r) => ({
      ...campaignFromRow(r as unknown as CampaignRow),
      templateAr: (r.template_name_ar as string | null) ?? null,
      templateEn: (r.template_name_en as string | null) ?? null,
      templateBi: (r.template_name_bilingual as string | null) ?? null,
      holdoutPct: Number(r.holdout_pct ?? 0),
      attributionDays: Number(r.attribution_days ?? 7),
    }));
}

export async function loadPolicyAndSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<{ policy: ContactPolicy; settings: SendSettings }> {
  const { data } = await db.from("lulu_contact_policy").select("*").eq("account_id", accountId).maybeSingle();
  const row = data as (PolicyRow & { daily_send_cap?: number; send_gap_base_seconds?: number; send_gap_increment_seconds?: number }) | null;
  return {
    policy: policyFromRow(row),
    settings: {
      dailyCap: row?.daily_send_cap ?? DEFAULT_SEND_SETTINGS.dailyCap,
      gapBaseSeconds: row?.send_gap_base_seconds ?? DEFAULT_SEND_SETTINGS.gapBaseSeconds,
      gapIncrementSeconds: row?.send_gap_increment_seconds ?? DEFAULT_SEND_SETTINGS.gapIncrementSeconds,
    },
  };
}

export interface ApprovedTemplate {
  name: string;
  /** Language code exactly as Meta stores it (e.g. "ar", "en_US"). */
  language: string;
  lang: "ar" | "en";
  varCount: number;
}

/** Approved templates of the account, keyed by name, for the given candidate names. */
export async function loadApprovedTemplates(db: SupabaseClient, accountId: string, names: string[]) {
  const map = new Map<string, ApprovedTemplate>();
  if (names.length === 0) return map;
  const { data, error } = await db
    .from("message_templates")
    .select("name, language, status, body_text")
    .eq("account_id", accountId)
    .in("name", names);
  if (error) throw error;
  for (const t of data ?? []) {
    if (String(t.status ?? "").toUpperCase() !== "APPROVED") continue;
    const language = (t.language as string | null) ?? "ar";
    map.set(t.name as string, {
      name: t.name as string,
      language,
      lang: language.toLowerCase().startsWith("en") ? "en" : "ar",
      varCount: new Set([...String(t.body_text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size,
    });
  }
  return map;
}

/**
 * Template to send: the customer's chosen language if approved, else the bilingual
 * template, else the other language. No choice yet → bilingual first.
 */
export function chooseTemplate(
  c: LiveCampaign,
  preference: "ar" | "en" | null,
  approved: Map<string, ApprovedTemplate>,
): { template: ApprovedTemplate; kind: TemplateChoiceKind } | null {
  const pick = chooseTemplateKind({ ar: c.templateAr, en: c.templateEn, bi: c.templateBi }, preference, (n) => approved.has(n));
  return pick ? { template: approved.get(pick.name)!, kind: pick.kind } : null;
}

export const campaignTemplateNames = (c: LiveCampaign) =>
  [c.templateAr, c.templateEn, c.templateBi].filter((n): n is string => !!n);

/** Language the customer chose on WhatsApp (null = not chosen). */
export async function loadLanguagePreference(db: SupabaseClient, accountId: string, digits: string): Promise<"ar" | "en" | null> {
  const { data } = await db
    .from("lulu_language_prefs")
    .select("language")
    .eq("account_id", accountId)
    .eq("phone_digits", digits)
    .maybeSingle();
  const l = data?.language as string | undefined;
  return l === "ar" || l === "en" ? l : null;
}

/**
 * Hard gates before ANY customer message. Returns blocking reasons (empty = OK).
 *  - order data synced within 36 h (stale data = "we miss you" to someone who just ordered)
 *  - STOP handling (Step 0 webhook) active
 */
export async function liveGates(db: SupabaseClient, accountId: string, now: Date): Promise<string[]> {
  const reasons: string[] = [];
  const [{ data: sync }, { data: hooks }] = await Promise.all([
    db
      .from("lulu_customer_sync_log")
      .select("data_as_of")
      .eq("account_id", accountId)
      .not("data_as_of", "is", null)
      .order("started_at", { ascending: false })
      .limit(1),
    db.from("webhook_endpoints").select("id").eq("account_id", accountId).eq("is_active", true).like("url", "%/api/lulu/hooks/wacrm"),
  ]);
  const asOf = sync?.[0]?.data_as_of ? new Date(sync[0].data_as_of as string) : null;
  if (!asOf) reasons.push("No customer sync with a data date yet.");
  else {
    const hours = (now.getTime() - asOf.getTime()) / 3_600_000;
    if (hours > 36) reasons.push(`Order data is ${Math.floor(hours)} h old (limit 36 h) — refresh BigQuery and re-sync first.`);
  }
  if (!hooks || hooks.length === 0) reasons.push("Step 0 (STOP handling) is not enabled.");
  return reasons;
}

/** All offers of the account by id. */
export async function loadOffers(db: SupabaseClient, accountId: string): Promise<Map<string, Offer>> {
  const { data, error } = await db.from("lulu_offers").select(OFFER_COLUMNS).eq("account_id", accountId);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.id as string, offerFromRow(r as unknown as OfferRow)]));
}

/** Attributed discount cost so far per offer (budget used). */
export async function loadOfferDiscountUsed(db: SupabaseClient, accountId: string): Promise<Map<string, number>> {
  const { data, error } = await db.rpc("lulu_offer_usage", { p_account: accountId });
  if (error) throw error;
  return new Map(((data ?? []) as { offer_id: string; discount_cost: number | string }[]).map((r) => [r.offer_id, Number(r.discount_cost)]));
}
