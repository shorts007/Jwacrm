import type { CampaignType } from "./types";

export type MessageLanguage = "ar" | "en";

/** Meta template language codes used for LuLu templates. */
export const TEMPLATE_LANGUAGE: Record<MessageLanguage, string> = { ar: "ar", en: "en" };

/** Default (suggested) Meta template names per campaign type — see docs/lulu/templates.md. */
export const DEFAULT_TEMPLATE_NAMES: Partial<Record<CampaignType, { ar: string; en: string; bi: string }>> = {
  INACTIVE_15: { ar: "lulu_inactive_15_ar", en: "lulu_inactive_15_en", bi: "lulu_inactive_15_bi" },
  WINBACK_30: { ar: "lulu_winback_30_ar", en: "lulu_winback_30_en", bi: "lulu_winback_30_bi" },
  LOST_60: { ar: "lulu_lost_60_ar", en: "lulu_lost_60_en", bi: "lulu_lost_60_bi" },
  SECOND_ORDER: { ar: "lulu_second_order_ar", en: "lulu_second_order_en", bi: "lulu_second_order_bi" },
  VIP_PROTECTION: { ar: "lulu_vip_care_ar", en: "lulu_vip_care_en", bi: "lulu_vip_care_bi" },
  NEW_OFFER: { ar: "promo_image_ar", en: "promo_image_en", bi: "promo_image_bi" },
  REPLENISHMENT: { ar: "restock_ar", en: "restock_en", bi: "restock_bi" },
  BUY_AGAIN: { ar: "buy_again_ar", en: "buy_again_en", bi: "buy_again_bi" },
  CROSS_SELL: { ar: "cross_sell_ar", en: "cross_sell_en", bi: "cross_sell_bi" },
};

/** Number of positional body variables each campaign's template takes: {{1}}=name, {{2}}=offer, {{3}}=expiry. */
const VARIABLES: Partial<Record<CampaignType, ("name" | "offer" | "expiry" | "promo" | "items" | "product")[]>> = {
  CROSS_SELL: ["name", "items", "product"],
  NEW_OFFER: ["name", "promo", "expiry"],
  REPLENISHMENT: ["name", "items"],
  BUY_AGAIN: ["name", "items"],
  INACTIVE_15: ["name"],
  WINBACK_30: ["name", "offer", "expiry"],
  LOST_60: ["name"],
  SECOND_ORDER: ["name"],
  VIP_PROTECTION: ["name", "offer"],
};

export interface MessageContext {
  name?: string | null;
  language: MessageLanguage;
  offerText?: string | null;
  /** YYYY-MM-DD */
  expiryDate?: string | null;
  /** Promotion text (NEW_OFFER). */
  promoText?: string | null;
  /** Product names for REPLENISHMENT / BUY_AGAIN (CROSS_SELL: [anchor]). */
  items?: string[] | null;
  /** CROSS_SELL: the suggested product. */
  product?: string | null;
}

/** "A, B and C" / "A، B و C" — product names stay as in the catalogue (English). Max 3, each ≤ 40 chars. */
export function itemsText(items: string[] | null | undefined, language: MessageLanguage): string {
  const list = (items ?? []).map((n) => cleanVariable(n)).filter(Boolean).slice(0, 3).map((n) => (n.length > 40 ? `${n.slice(0, 39)}…` : n));
  if (list.length <= 1) return list[0] ?? "";
  const head = list.slice(0, -1).join(language === "ar" ? "، " : ", ");
  // Product names are Latin script, so keep "و" as a separate word in Arabic.
  return language === "ar" ? `${head} و ${list.at(-1)}` : `${head} and ${list.at(-1)}`;
}

const FALLBACK_NAME: Record<MessageLanguage, string> = { ar: "عزيزنا العميل", en: "there" };

/** Meta forbids newlines/tabs and 4+ spaces inside a template variable. */
export function cleanVariable(v: string): string {
  return v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** First name only, cleaned; a customer without a usable name gets a polite fallback. */
export function displayName(name: string | null | undefined, language: MessageLanguage): string {
  const first = cleanVariable(name ?? "").split(" ")[0] ?? "";
  return first && first.length <= 30 ? first : FALLBACK_NAME[language];
}

/** "2026-10-12" -> "12 Oct 2026" (en) / "12 أكتوبر 2026" (ar). Gregorian calendar, Latin digits. */
export function formatExpiry(iso: string, language: MessageLanguage): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const locale = language === "ar" ? "ar-u-ca-gregory-nu-latn" : "en-GB";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** Positional body params for the campaign's template, in {{1}}, {{2}}… order. */
export function buildTemplateParams(type: CampaignType, ctx: MessageContext): string[] {
  const vars = VARIABLES[type] ?? ["name"];
  return vars.map((v) => {
    if (v === "name") return displayName(ctx.name, ctx.language);
    // No default offer wording: a message must never promise an offer that does not exist.
    if (v === "offer") return cleanVariable(ctx.offerText ?? "");
    if (v === "promo") return cleanVariable(ctx.promoText ?? "");
    if (v === "items") return itemsText(ctx.items, ctx.language);
    if (v === "product") return itemsText(ctx.product ? [ctx.product] : [], ctx.language);
    return ctx.expiryDate ? formatExpiry(ctx.expiryDate, ctx.language) : "";
  });
}

/** Template name for the customer's language; falls back to the other language if unset. */
export function pickTemplate(
  names: { ar?: string | null; en?: string | null },
  language: MessageLanguage,
): { name: string; language: MessageLanguage } | null {
  const primary = names[language];
  if (primary) return { name: primary, language };
  const other: MessageLanguage = language === "ar" ? "en" : "ar";
  return names[other] ? { name: names[other]!, language: other } : null;
}

export const asMessageLanguage = (l: string | null | undefined): MessageLanguage =>
  l && l.toLowerCase().startsWith("en") ? "en" : "ar";

/**
 * Params for a BILINGUAL template: the Arabic block's variables first, then the
 * English block's (e.g. {{1}} name-ar … {{4}} name-en), each formatted for its language.
 */
export function buildBilingualParams(type: CampaignType, ctx: Omit<MessageContext, "language">): string[] {
  return [...buildTemplateParams(type, { ...ctx, language: "ar" }), ...buildTemplateParams(type, { ...ctx, language: "en" })];
}

export type TemplateChoiceKind = "ar" | "en" | "bi";

/**
 * Which template to send:
 *  - customer chose a language → that language (falls back to bilingual, then the other language)
 *  - no choice yet → bilingual (falls back to Arabic, then English)
 * `isApproved` lets the caller restrict to approved templates.
 */
export function chooseTemplateKind(
  names: { ar?: string | null; en?: string | null; bi?: string | null },
  preference: "ar" | "en" | null,
  isApproved: (name: string) => boolean = () => true,
): { kind: TemplateChoiceKind; name: string } | null {
  const order: TemplateChoiceKind[] =
    preference === "en" ? ["en", "bi", "ar"] : preference === "ar" ? ["ar", "bi", "en"] : ["bi", "ar", "en"];
  for (const k of order) {
    const n = names[k];
    if (n && isApproved(n)) return { kind: k, name: n };
  }
  return null;
}

/**
 * Params for the chosen template kind, with the offer wording in the right language(s).
 * `offer` must come from a real, usable offer for campaigns that mention one.
 */
export function buildParamsForKind(
  kind: TemplateChoiceKind,
  type: CampaignType,
  ctx: {
    name?: string | null;
    expiryDate?: string | null;
    offer?: { ar: string; en: string } | null;
    promo?: { ar: string; en: string } | null;
    items?: string[] | null;
    product?: string | null;
  },
): string[] {
  const one = (language: MessageLanguage) =>
    buildTemplateParams(type, {
      name: ctx.name,
      language,
      expiryDate: ctx.expiryDate ?? null,
      offerText: ctx.offer?.[language] ?? null,
      promoText: ctx.promo?.[language] ?? null,
      items: ctx.items ?? null,
      product: ctx.product ?? null,
    });
  return kind === "bi" ? [...one("ar"), ...one("en")] : one(kind);
}
