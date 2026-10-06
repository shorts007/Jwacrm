import { describe, expect, it } from "vitest";
import { campaignNeedsOffer, customerOfferReason, offerBlockReason, offerExpiry, offerText, type Offer } from "./index";

const NOW = new Date("2026-10-07T12:00:00Z");
const base: Offer = {
  id: "o", offerCode: "WB20", name: "Win-back SAR 20", offerType: "FIXED_VOUCHER", value: 20, minimumOrder: 100,
  textAr: null, textEn: null, validityDays: 7, startDate: null, endDate: null, budgetSar: 5000,
  eligibleSegments: [], eligibleStores: [], eligiblePriceBehaviour: [], active: true,
};

describe("offer wording", () => {
  it("generates bilingual text with the code, or uses custom text", () => {
    expect(offerText(base, "en")).toBe("SAR 20 off with code WB20");
    expect(offerText(base, "ar")).toBe("خصم 20 ريال بالكود WB20");
    expect(offerText({ ...base, offerType: "FREE_DELIVERY", offerCode: "" }, "en")).toBe("free delivery");
    expect(offerText({ ...base, offerType: "PERCENT_DISCOUNT", value: 15 }, "en")).toBe("15% off with code WB20");
    expect(offerText({ ...base, textEn: "a free gift" }, "en")).toBe("a free gift");
  });
  it("expiry = send date + validity, capped by end date", () => {
    expect(offerExpiry(base, NOW)).toBe("2026-10-14");
    expect(offerExpiry({ ...base, endDate: "2026-10-10" }, NOW)).toBe("2026-10-10");
  });
});

describe("offer usability", () => {
  it("blocks missing / inactive / out-of-date / over-budget offers", () => {
    expect(offerBlockReason(null, NOW)).toMatch(/no offer/);
    expect(offerBlockReason({ ...base, active: false }, NOW)).toMatch(/inactive/);
    expect(offerBlockReason({ ...base, startDate: "2026-10-08" }, NOW)).toMatch(/starts/);
    expect(offerBlockReason({ ...base, endDate: "2026-10-06" }, NOW)).toMatch(/ended/);
    expect(offerBlockReason(base, NOW, 5000)).toMatch(/budget used up/);
    expect(offerBlockReason(base, NOW, 4999)).toBeNull();
    expect(offerBlockReason({ ...base, budgetSar: null }, NOW, 99999)).toBeNull();
  });
  it("only the offer campaigns need one", () => {
    expect(campaignNeedsOffer("WINBACK_30")).toBe(true);
    expect(campaignNeedsOffer("VIP_PROTECTION")).toBe(true);
    expect(campaignNeedsOffer("SECOND_ORDER")).toBe(false);
  });
});

describe("customer eligibility", () => {
  it("keeps discounts away from full-price buyers when configured", () => {
    const o = { ...base, eligiblePriceBehaviour: ["Offer-driven", "Mixed", "Unknown"] as Offer["eligiblePriceBehaviour"] };
    expect(customerOfferReason(o, { priceBehaviour: "Full-price" })).toBe("offer_price_behaviour");
    expect(customerOfferReason(o, { priceBehaviour: null })).toBeNull();
    expect(customerOfferReason({ ...base, eligibleStores: ["3810"] }, { preferredStoreId: 3805 })).toBe("offer_store");
    expect(customerOfferReason({ ...base, eligibleSegments: ["Champions"] }, { customerSegment: "Loyal" })).toBe("offer_segment");
    expect(customerOfferReason(base, {})).toBeNull();
  });
});
