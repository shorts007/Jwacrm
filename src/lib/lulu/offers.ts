/**
 * Offer engine (pure). An offer is attached to a campaign; campaigns whose message
 * contains an offer ({{offer}}) can only send with a usable offer — never a made-up one.
 */
import type { CampaignType } from "./types";

export type OfferType = "FREE_DELIVERY" | "FIXED_VOUCHER" | "PERCENT_DISCOUNT" | "CATEGORY_DISCOUNT" | "NONE";
export type PriceBehaviour = "Offer-driven" | "Mixed" | "Full-price" | "Unknown";

export interface Offer {
  id: string;
  offerCode: string;
  name: string;
  offerType: OfferType;
  value: number;
  minimumOrder: number;
  textAr: string | null;
  textEn: string | null;
  validityDays: number;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  budgetSar: number | null;
  eligibleSegments: string[];
  eligibleStores: string[]; // store ids as strings, e.g. "3810"
  eligiblePriceBehaviour: PriceBehaviour[];
  active: boolean;
}

/** Campaign templates that contain the offer variable. */
export const OFFER_CAMPAIGNS: ReadonlySet<CampaignType> = new Set<CampaignType>(["WINBACK_30", "VIP_PROTECTION"]);
export const campaignNeedsOffer = (t: CampaignType) => OFFER_CAMPAIGNS.has(t);

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ""));

/** Wording inserted in the message. Uses the custom text if set, else generated from type/value/code. */
export function offerText(o: Offer, lang: "ar" | "en"): string {
  const custom = lang === "ar" ? o.textAr : o.textEn;
  if (custom && custom.trim()) return custom.trim();
  const v = num(o.value);
  const base =
    o.offerType === "FREE_DELIVERY"
      ? lang === "ar" ? "توصيل مجاني" : "free delivery"
      : o.offerType === "FIXED_VOUCHER"
        ? lang === "ar" ? `خصم ${v} ريال` : `SAR ${v} off`
        : o.offerType === "PERCENT_DISCOUNT" || o.offerType === "CATEGORY_DISCOUNT"
          ? lang === "ar" ? `خصم ${v}%` : `${v}% off`
          : "";
  if (!base) return "";
  const code = o.offerCode?.trim();
  return code ? (lang === "ar" ? `${base} بالكود ${code}` : `${base} with code ${code}`) : base;
}

/** Expiry shown to the customer: send date + validity days, never after the offer's end date. */
export function offerExpiry(o: Offer, now: Date): string {
  const byValidity = new Date(now.getTime() + Math.max(1, o.validityDays) * 86_400_000).toISOString().slice(0, 10);
  return o.endDate && o.endDate < byValidity ? o.endDate : byValidity;
}

/** Can this offer be sent today? Returns null when usable, else the reason. */
export function offerBlockReason(o: Offer | null | undefined, now: Date, discountUsed = 0): string | null {
  if (!o) return "no offer attached";
  if (!o.active) return `offer ${o.offerCode} is inactive`;
  if (o.offerType === "NONE") return `offer ${o.offerCode} has type NONE`;
  const today = now.toISOString().slice(0, 10);
  if (o.startDate && today < o.startDate) return `offer ${o.offerCode} starts ${o.startDate}`;
  if (o.endDate && today > o.endDate) return `offer ${o.offerCode} ended ${o.endDate}`;
  if (o.budgetSar !== null && o.budgetSar > 0 && discountUsed >= o.budgetSar)
    return `offer ${o.offerCode} budget used up (SAR ${Math.round(discountUsed)} of ${Math.round(o.budgetSar)})`;
  if (!offerText(o, "ar") || !offerText(o, "en")) return `offer ${o.offerCode} has no wording`;
  return null;
}

/** Customer-level eligibility (PRD §54/§85). Empty lists mean "everyone". */
export function customerOfferReason(
  o: Offer,
  c: { customerSegment?: string | null; preferredStoreId?: number | null; priceBehaviour?: string | null },
): string | null {
  if (o.eligibleSegments.length && !o.eligibleSegments.includes(c.customerSegment ?? "")) return "offer_segment";
  if (o.eligibleStores.length && !o.eligibleStores.includes(c.preferredStoreId == null ? "" : String(c.preferredStoreId)))
    return "offer_store";
  if (o.eligiblePriceBehaviour.length) {
    const b = (c.priceBehaviour ?? "Unknown") as PriceBehaviour;
    if (!o.eligiblePriceBehaviour.includes(b)) return "offer_price_behaviour";
  }
  return null;
}

export interface OfferRow {
  id: string;
  offer_code: string;
  name: string;
  offer_type: OfferType;
  value: number | string;
  minimum_order: number | string | null;
  text_ar: string | null;
  text_en: string | null;
  validity_days: number | null;
  start_date: string | null;
  end_date: string | null;
  budget_sar: number | string | null;
  eligible_segments: string[] | null;
  eligible_stores: string[] | null;
  eligible_price_behaviour: string[] | null;
  active: boolean;
}

export function offerFromRow(r: OfferRow): Offer {
  return {
    id: r.id,
    offerCode: r.offer_code,
    name: r.name,
    offerType: r.offer_type,
    value: Number(r.value ?? 0),
    minimumOrder: Number(r.minimum_order ?? 0),
    textAr: r.text_ar,
    textEn: r.text_en,
    validityDays: r.validity_days ?? 7,
    startDate: r.start_date,
    endDate: r.end_date,
    budgetSar: r.budget_sar == null ? null : Number(r.budget_sar),
    eligibleSegments: r.eligible_segments ?? [],
    eligibleStores: r.eligible_stores ?? [],
    eligiblePriceBehaviour: (r.eligible_price_behaviour ?? []) as PriceBehaviour[],
    active: r.active,
  };
}

export const OFFER_COLUMNS =
  "id, offer_code, name, offer_type, value, minimum_order, text_ar, text_en, validity_days, start_date, end_date, budget_sar, eligible_segments, eligible_stores, eligible_price_behaviour, active";
