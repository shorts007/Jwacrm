import type { TemplatePayload } from "@/lib/whatsapp/template-validators";

/**
 * The LuLu marketing templates (EN + AR). Texts mirror docs/lulu/templates.md.
 * Positional variables: {{1}} = first name, {{2}} = offer, {{3}} = expiry date.
 * Submitted to Meta through WACRM's own /api/whatsapp/templates/submit route.
 */
const FOOTER = { en: "Reply STOP to opt out", ar: "للإلغاء أرسل STOP" } as const;

const NAME = { en: "Ahmed", ar: "أحمد" } as const;
const OFFER = { en: "free delivery", ar: "توصيل مجاني" } as const;
const EXPIRY = { en: "12 Oct 2026", ar: "12 أكتوبر 2026" } as const;

type Lang = "en" | "ar";

function def(
  name: string,
  language: Lang,
  body_text: string,
  samples: ("name" | "offer" | "expiry")[],
): TemplatePayload {
  const pick = { name: NAME, offer: OFFER, expiry: EXPIRY };
  return {
    name,
    category: "Marketing",
    language,
    body_text,
    footer_text: FOOTER[language],
    sample_values: { body: samples.map((s) => pick[s][language]) },
  };
}

const BI_FOOTER = "Reply STOP to opt out | للإلغاء أرسل STOP";
const LANGUAGE_BUTTONS: TemplatePayload["buttons"] = [
  { type: "QUICK_REPLY", text: "العربية" },
  { type: "QUICK_REPLY", text: "English" },
];

/** Arabic block first, then English; the English block's variables continue the numbering. */
function biDef(name: string, ar: string, en: string, samples: ("name" | "offer" | "expiry")[]): TemplatePayload {
  const pick = { name: NAME, offer: OFFER, expiry: EXPIRY };
  const shift = samples.length;
  const enShifted = en.replace(/\{\{(\d+)\}\}/g, (_, d: string) => `{{${Number(d) + shift}}}`);
  return {
    name,
    category: "Marketing",
    language: "ar",
    body_text: `${ar}\n\n${enShifted}`,
    footer_text: BI_FOOTER,
    buttons: LANGUAGE_BUTTONS,
    sample_values: { body: [...samples.map((s) => pick[s].ar), ...samples.map((s) => pick[s].en)] },
  };
}

export const LULU_TEMPLATE_DEFS: TemplatePayload[] = [
  def(
    "lulu_inactive_15_en",
    "en",
    "Hi {{1}}, it has been a little while since your last LuLu Online order. Your favourite groceries are just a few taps away, delivered to your door. Ready to order again?",
    ["name"],
  ),
  def(
    "lulu_inactive_15_ar",
    "ar",
    "مرحباً {{1}}، مرّ وقت منذ آخر طلب لك من لولو أونلاين. منتجاتك المفضلة على بعد نقرات قليلة وتصلك حتى باب بيتك. هل أنت مستعد لطلب جديد؟",
    ["name"],
  ),
  def(
    "lulu_winback_30_en",
    "en",
    "Hi {{1}}, we miss you at LuLu Online! Come back and enjoy {{2}} on your next order. This offer is valid until {{3}}. See you soon!",
    ["name", "offer", "expiry"],
  ),
  def(
    "lulu_winback_30_ar",
    "ar",
    "مرحباً {{1}}، اشتقنا لك في لولو أونلاين! عُد إلينا واستمتع بـ {{2}} على طلبك القادم. العرض ساري حتى {{3}}. بانتظارك!",
    ["name", "offer", "expiry"],
  ),
  def(
    "lulu_lost_60_en",
    "en",
    "Hi {{1}}, it has been a while! There is a lot that is new at LuLu Online, from fresh produce to weekly offers. Come and see what you have been missing.",
    ["name"],
  ),
  def(
    "lulu_lost_60_ar",
    "ar",
    "مرحباً {{1}}، طال غيابك! هناك الكثير من الجديد في لولو أونلاين، من الخضار والفواكه الطازجة إلى العروض الأسبوعية. تفضّل لترى ما فاتك.",
    ["name"],
  ),
  def(
    "lulu_second_order_en",
    "en",
    "Hi {{1}}, thank you for shopping with LuLu Online! Ready for your next order? Your groceries are only a few taps away.",
    ["name"],
  ),
  def(
    "lulu_second_order_ar",
    "ar",
    "مرحباً {{1}}، شكراً لتسوقك من لولو أونلاين! هل أنت مستعد لطلبك القادم؟ مستلزماتك على بعد نقرات قليلة.",
    ["name"],
  ),
  def(
    "lulu_vip_care_en",
    "en",
    "Hi {{1}}, you are one of our most valued customers and we have missed you. Enjoy {{2}} on your next order as our way of saying thank you.",
    ["name", "offer"],
  ),
  def(
    "lulu_vip_care_ar",
    "ar",
    "مرحباً {{1}}، أنت من عملائنا المميزين ونفتقدك كثيراً. استمتع بـ {{2}} على طلبك القادم كتقدير منّا لك.",
    ["name", "offer"],
  ),
];

/** Bilingual versions (sent to customers who have not chosen a language). */
export const LULU_BILINGUAL_TEMPLATE_DEFS: TemplatePayload[] = (
  [
    ["lulu_inactive_15", ["name"]],
    ["lulu_winback_30", ["name", "offer", "expiry"]],
    ["lulu_lost_60", ["name"]],
    ["lulu_second_order", ["name"]],
    ["lulu_vip_care", ["name", "offer"]],
  ] as const
).map(([base, samples]) => {
  const ar = LULU_TEMPLATE_DEFS.find((d) => d.name === `${base}_ar`)!.body_text;
  const en = LULU_TEMPLATE_DEFS.find((d) => d.name === `${base}_en`)!.body_text;
  return biDef(`${base}_bi`, ar, en, [...samples]);
});

export const ALL_LULU_TEMPLATE_DEFS: TemplatePayload[] = [...LULU_TEMPLATE_DEFS, ...LULU_BILINGUAL_TEMPLATE_DEFS];

