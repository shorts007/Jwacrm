import { describe, expect, it } from "vitest";
import { validateTemplatePayload } from "@/lib/whatsapp/template-validators";
import {
  DEFAULT_POLICY,
  buildParamsForKind,
  decideNextBestAction,
  promoTemplateDefs,
  type CampaignConfig,
  type CustomerProfile,
} from "./index";

const NOW = new Date("2026-10-07T12:00:00Z");
const promo = (audience: CampaignConfig["params"]["audience"]): CampaignConfig => ({
  id: "p", code: "PROMO_FRUIT", name: "Fruit week", type: "NEW_OFFER", priorityClass: "GENERAL_PROMOTION", active: true, params: { audience },
});
const cust = (o: Partial<CustomerProfile> = {}): CustomerProfile => ({
  customerId: "c", mobile: "+966500000000", language: "ar", lastOrderDate: "2026-10-01", totalOrders: 5, totalSales: 500,
  medianIntervalDays: 7, vipFlag: false, marketingOptIn: true, activeComplaint: false, priceBehaviour: "Mixed", preferredStoreId: 3810, ...o,
});
const run = (c: CampaignConfig, p: CustomerProfile) =>
  decideNextBestAction({ profile: p, campaigns: [c], policy: DEFAULT_POLICY, history: [], now: NOW });

describe("promotion audience", () => {
  it("matches everyone when no filters are set", () => {
    expect(run(promo(undefined), cust()).action?.reason).toBe("Promotion: Fruit week");
  });
  it("filters by price behaviour, store, VIP, orders and recency", () => {
    expect(run(promo({ priceBehaviour: ["Offer-driven"] }), cust()).action).toBeNull();
    expect(run(promo({ priceBehaviour: ["Unknown"] }), cust({ priceBehaviour: null })).action).not.toBeNull();
    expect(run(promo({ stores: ["3805"] }), cust()).action).toBeNull();
    expect(run(promo({ stores: ["3810"] }), cust()).action).not.toBeNull();
    expect(run(promo({ vipOnly: true }), cust()).action).toBeNull();
    expect(run(promo({ minOrders: 6 }), cust()).action).toBeNull();
    expect(run(promo({ orderedWithinDays: 3 }), cust()).action).toBeNull();
    expect(run(promo({ orderedWithinDays: 30 }), cust()).action).not.toBeNull();
  });
  it("filters by lifecycle stage", () => {
    const lost = cust({ lastOrderDate: "2026-06-01", medianIntervalDays: 7 });
    expect(run(promo({ stages: ["ACTIVE"] }), lost).action).toBeNull();
    expect(run(promo({ stages: ["LOST"] }), lost).action).not.toBeNull();
  });
  it("still respects opt-out", () => {
    expect(run(promo(undefined), cust({ marketingOptIn: false })).action).toBeNull();
  });
});

describe("promo templates", () => {
  const defs = promoTemplateDefs("https://example.com/lulu/promo-sample.png");
  it("pass WACRM's Meta-rule validator, image header, brand-neutral", () => {
    for (const d of defs) {
      expect(() => validateTemplatePayload(d), d.name).not.toThrow();
      expect(d.header_type).toBe("image");
      expect(d.body_text).not.toMatch(/lulu|لولو/i);
    }
    expect(defs.find((d) => d.name === "promo_image_bi")!.body_text).toContain("Hi {{4}}");
  });
  it("params carry the promotion text per language", () => {
    expect(buildParamsForKind("bi", "NEW_OFFER", {
      name: "Sara", expiryDate: "2026-10-12", promo: { ar: "خصم 20%\nعلى الفواكه", en: "20% off fruit" },
    })).toEqual(["Sara", "خصم 20% على الفواكه", expect.stringMatching(/2026$/), "Sara", "20% off fruit", "12 Oct 2026"]);
  });
});
