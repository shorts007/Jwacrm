import { describe, expect, it } from "vitest";
import { validateTemplatePayload } from "@/lib/whatsapp/template-validators";
import { ALL_LULU_TEMPLATE_DEFS, DEFAULT_TEMPLATE_NAMES, LULU_BILINGUAL_TEMPLATE_DEFS, LULU_TEMPLATE_DEFS, buildBilingualParams, buildParamsForKind } from "./index";

describe("LULU_TEMPLATE_DEFS", () => {
  it("every template passes WACRM's own Meta-rule validator", () => {
    for (const d of ALL_LULU_TEMPLATE_DEFS) expect(() => validateTemplatePayload(d), d.name).not.toThrow();
  });
  it("has an EN and AR template for each default campaign name", () => {
    const names = new Set(ALL_LULU_TEMPLATE_DEFS.map((d) => d.name));
    for (const set of Object.values(DEFAULT_TEMPLATE_NAMES)) {
      expect(names.has(set!.ar)).toBe(true);
      expect(names.has(set!.en)).toBe(true);
      expect(names.has(set!.bi)).toBe(true);
    }
  });
  it("sample value count matches the variable count", () => {
    for (const d of ALL_LULU_TEMPLATE_DEFS) {
      const vars = new Set([...d.body_text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
      expect(d.sample_values?.body?.length, d.name).toBe(vars);
    }
  });
});

describe("bilingual templates", () => {
  it("Arabic first, English second, numbering continues, language buttons", () => {
    const w = LULU_BILINGUAL_TEMPLATE_DEFS.find((d) => d.name === "lulu_winback_30_bi")!;
    expect(w.language).toBe("ar");
    expect(w.body_text.indexOf("مرحباً {{1}}")).toBe(0);
    expect(w.body_text).toContain("Hi {{4}}, we miss you");
    expect(w.body_text).toContain("valid until {{6}}");
    expect(w.buttons?.map((b) => b.text)).toEqual(["العربية", "English"]);
    expect(w.sample_values?.body).toEqual(["أحمد", "توصيل مجاني", "12 أكتوبر 2026", "Ahmed", "free delivery", "12 Oct 2026"]);
    expect(LULU_TEMPLATE_DEFS).toHaveLength(10);
  });
  it("bilingual params match the template's variable order", () => {
    expect(buildBilingualParams("WINBACK_30", { name: "Sara Ali", offerText: null, expiryDate: "2026-10-12" })).toEqual([
      "Sara", "", expect.stringMatching(/^12 .+ 2026$/), "Sara", "", "12 Oct 2026",
    ]);
    expect(buildBilingualParams("SECOND_ORDER", { name: null })).toEqual(["عزيزنا العميل", "there"]);
  });
});

describe("buildParamsForKind", () => {
  it("puts the offer wording in each language", () => {
    expect(buildParamsForKind("bi", "VIP_PROTECTION", { name: "Sara", offer: { ar: "خصم 20 ريال", en: "SAR 20 off" } })).toEqual([
      "Sara", "خصم 20 ريال", "Sara", "SAR 20 off",
    ]);
    expect(buildParamsForKind("en", "SECOND_ORDER", { name: "Sara Ali" })).toEqual(["Sara"]);
  });
});
