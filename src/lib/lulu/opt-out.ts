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

export const OPT_OUT_CONFIRMATION =
  "You have been unsubscribed from LuLu Online offers. Reply START to subscribe again.\n" +
  "تم إلغاء اشتراكك في عروض لولو أونلاين. أرسل START للاشتراك مجدداً.";

export const OPT_IN_CONFIRMATION =
  "You are subscribed to LuLu Online offers again. Reply STOP at any time to unsubscribe.\n" +
  "تم تفعيل اشتراكك في عروض لولو أونلاين. أرسل STOP في أي وقت لإلغاء الاشتراك.";

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
