import type { CampaignType } from "./types";

export type MessageLanguage = "ar" | "en";

/** Meta template language codes used for LuLu templates. */
export const TEMPLATE_LANGUAGE: Record<MessageLanguage, string> = { ar: "ar", en: "en" };

/** Default (suggested) Meta template names per campaign type — see docs/lulu/templates.md. */
export const DEFAULT_TEMPLATE_NAMES: Partial<Record<CampaignType, { ar: string; en: string }>> = {
  INACTIVE_15: { ar: "lulu_inactive_15_ar", en: "lulu_inactive_15_en" },
  WINBACK_30: { ar: "lulu_winback_30_ar", en: "lulu_winback_30_en" },
  LOST_60: { ar: "lulu_lost_60_ar", en: "lulu_lost_60_en" },
  SECOND_ORDER: { ar: "lulu_second_order_ar", en: "lulu_second_order_en" },
  VIP_PROTECTION: { ar: "lulu_vip_care_ar", en: "lulu_vip_care_en" },
};

/** Number of positional body variables each campaign's template takes: {{1}}=name, {{2}}=offer, {{3}}=expiry. */
const VARIABLES: Partial<Record<CampaignType, ("name" | "offer" | "expiry")[]>> = {
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
    if (v === "offer") return cleanVariable(ctx.offerText ?? "") || (ctx.language === "ar" ? "توصيل مجاني" : "free delivery");
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
