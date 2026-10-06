/**
 * Opt-out / opt-in keyword detection for inbound WhatsApp replies.
 * Matches the WHOLE message (after normalising), so "please stop sending"
 * in a support chat is NOT treated as an unsubscribe — only a clear
 * keyword reply (or the template's quick-reply button text) is.
 */

export type KeywordIntent = "stop" | "start";

/** Lower-case, strip punctuation/emoji/diacritics/tatweel, unify Arabic letter forms, collapse spaces. */
export function normalizeReply(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // harakat, superscript alef, tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(
  [
    "stop", "unsubscribe", "stop messages", "stop promotions", "stop all", "opt out", "optout",
    "ايقاف", "ايقاف الرسائل", "ايقاف العروض", "الغاء", "الغاء الاشتراك", "توقف", "وقف", "لا ترسل",
  ].map(normalizeReply),
);
const START = new Set(["start", "subscribe", "opt in", "ابدا", "اشتراك", "اشترك"].map(normalizeReply));

export function classifyReply(text: string | null | undefined): KeywordIntent | null {
  if (!text) return null;
  const t = normalizeReply(text);
  if (!t || t.length > 40) return null;
  if (STOP.has(t)) return "stop";
  if (START.has(t)) return "start";
  return null;
}

// Brand-neutral on purpose: offers from other brands will use the same opt-out.
export const OPT_OUT_CONFIRMATION =
  "You have been unsubscribed from online offers. Reply START to subscribe again.\n" +
  "تم إلغاء اشتراكك في العروض الإلكترونية. أرسل START للاشتراك مجدداً.";

export const OPT_IN_CONFIRMATION =
  "You are subscribed to online offers again. Reply STOP at any time to unsubscribe.\n" +
  "تم تفعيل اشتراكك في العروض الإلكترونية. أرسل STOP في أي وقت لإلغاء الاشتراك.";

const LANG_EN = new Set(["english", "en", "eng", "انجليزي", "انجليزيه", "الانجليزيه", "اللغه الانجليزيه"].map(normalizeReply));
const LANG_AR = new Set(["arabic", "ar", "عربي", "عربيه", "العربيه", "اللغه العربيه"].map(normalizeReply));

/**
 * Language choice from a reply: the quick-reply buttons on bilingual messages
 * ("العربية" / "English") or a keyword the customer types at any time.
 * Whole-message match only, like STOP.
 */
export function classifyLanguage(text: string | null | undefined): "ar" | "en" | null {
  if (!text) return null;
  const t = normalizeReply(text);
  if (!t || t.length > 30) return null;
  if (LANG_EN.has(t)) return "en";
  if (LANG_AR.has(t)) return "ar";
  return null;
}

export const LANGUAGE_CONFIRMATION: Record<"ar" | "en", string> = {
  en: "Done — we will message you in English from now on. Send العربية any time to switch to Arabic.",
  ar: "تم — سنراسلك باللغة العربية من الآن. أرسل English في أي وقت للتبديل إلى الإنجليزية.",
};

/** Meta delivery status → LuLu campaign event type (null = not tracked). */
export function statusToEvent(status: string | null | undefined): "DELIVERED" | "READ" | "FAILED" | null {
  switch ((status ?? "").toLowerCase()) {
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}
