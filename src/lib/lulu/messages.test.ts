import { describe, expect, it } from "vitest";
import { asMessageLanguage, buildTemplateParams, cleanVariable, displayName, formatExpiry, pickTemplate } from "./index";

describe("template params", () => {
  it("uses first name, offer and expiry in order", () => {
    expect(buildTemplateParams("WINBACK_30", { name: "Ahmed Ali", language: "en", offerText: "free delivery", expiryDate: "2026-10-12" }))
      .toEqual(["Ahmed", "free delivery", "12 Oct 2026"]);
    expect(buildTemplateParams("INACTIVE_15", { name: "Ahmed Ali", language: "en" })).toEqual(["Ahmed"]);
  });
  it("falls back politely for a missing name, but never invents an offer", () => {
    expect(displayName(null, "ar")).toBe("عزيزنا العميل");
    expect(displayName("   ", "en")).toBe("there");
    expect(buildTemplateParams("VIP_PROTECTION", { name: "سارة", language: "ar" })).toEqual(["سارة", ""]);
    expect(buildTemplateParams("VIP_PROTECTION", { name: "Sara", language: "en", offerText: "SAR 20 off" })).toEqual(["Sara", "SAR 20 off"]);
  });
  it("strips newlines and repeated spaces (Meta rejects them)", () => {
    expect(cleanVariable("a\nb\t c   d")).toBe("a b c d");
  });
});

describe("template selection", () => {
  it("prefers the customer's language and falls back to the other", () => {
    expect(pickTemplate({ ar: "x_ar", en: "x_en" }, "en")).toEqual({ name: "x_en", language: "en" });
    expect(pickTemplate({ ar: "x_ar" }, "en")).toEqual({ name: "x_ar", language: "ar" });
    expect(pickTemplate({}, "ar")).toBeNull();
  });
  it("maps language codes", () => {
    expect(asMessageLanguage("en-US")).toBe("en");
    expect(asMessageLanguage("ar")).toBe("ar");
    expect(asMessageLanguage(null)).toBe("ar");
  });
});

describe("formatExpiry", () => {
  it("formats Gregorian dates for each language", () => {
    expect(formatExpiry("2026-10-12", "en")).toBe("12 Oct 2026");
    expect(formatExpiry("2026-10-12", "ar")).toMatch(/^12 .+ 2026$/);
    expect(formatExpiry("2026-10-12", "ar")).not.toMatch(/[٠-٩]/);
    expect(formatExpiry("garbage", "en")).toBe("garbage");
  });
});
