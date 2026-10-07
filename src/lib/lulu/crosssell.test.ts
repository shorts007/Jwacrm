import { describe, expect, it } from "vitest";
import { validateTemplatePayload } from "@/lib/whatsapp/template-validators";
import {
  CROSS_SELL_TEMPLATE_DEFS,
  DEFAULT_CAMPAIGN_ROWS,
  DEFAULT_POLICY,
  buildParamsForKind,
  campaignFromRow,
  decideNextBestAction,
  parseCrossSell,
  type CampaignRow,
  type CustomerProfile,
} from "./index";

const NOW = new Date("2026-10-07T12:00:00Z");
const camp = (code: string) => {
  const r = DEFAULT_CAMPAIGN_ROWS.find((x) => x.campaign_code === code)!;
  return campaignFromRow({ id: code, campaign_code: r.campaign_code, name: r.name, campaign_type: r.campaign_type,
    rule_params: JSON.parse(JSON.stringify(r.rule_params)), offer_id: null, active: true, priority: r.priority } as CampaignRow);
};
const xs = { anchor: "Almarai Fresh Milk Full Fat 2.85 Litre", product: "Lusine Sliced Milk Bread 600 g", confidence: 0.18, lift: 2.4 };
const cust = (o: Partial<CustomerProfile> = {}): CustomerProfile => ({
  customerId: "c", mobile: "+966500000000", language: "ar", lastOrderDate: "2026-09-30", totalOrders: 12, totalSales: 2000,
  medianIntervalDays: 9, vipFlag: false, marketingOptIn: true, activeComplaint: false, itemsAsOf: "2026-10-06", crossSell: xs, ...o,
});
const run = (p: CustomerProfile, codes = ["CROSS_SELL"]) =>
  decideNextBestAction({ profile: p, campaigns: codes.map(camp), policy: DEFAULT_POLICY, history: [], now: NOW });

describe("Cross-sell", () => {
  it("suggests the product to an active customer, before their next shop", () => {
    const r = run(cust());
    expect(r.action?.campaignCode).toBe("CROSS_SELL");
    expect(r.action?.reason).toMatch(/Often bought with Almarai/);
  });
  it("not right after an order, not for lapsed customers, not without item coverage", () => {
    expect(run(cust({ lastOrderDate: "2026-10-04" })).action).toBeNull();
    expect(run(cust({ lastOrderDate: "2026-06-01" })).action).toBeNull();
    expect(run(cust({ lastOrderDate: "2026-10-03", itemsAsOf: "2026-09-30" })).action).toBeNull();
    expect(run(cust({ crossSell: null })).action).toBeNull();
  });
  it("Replenishment wins over Cross-sell when both apply", () => {
    const p = cust({ usualItems: [{ name: "Banana Ecuador 1 kg", times: 6, last: "2026-09-30", every: 7 }] });
    expect(run(p, ["CROSS_SELL", "REPLENISHMENT"]).action?.campaignCode).toBe("REPLENISHMENT");
  });
  it("parses BigQuery JSON and builds params", () => {
    expect(parseCrossSell(JSON.stringify(xs))).toEqual(xs);
    expect(parseCrossSell('{"anchor":"A","product":"A"}')).toBeNull();
    expect(parseCrossSell("x")).toBeNull();
    expect(buildParamsForKind("en", "CROSS_SELL", { name: "Sara Ali", items: [xs.anchor], product: xs.product })).toEqual([
      "Sara", xs.anchor, xs.product,
    ]);
  });
  it("templates pass WACRM's Meta-rule validator and are brand-neutral", () => {
    for (const d of CROSS_SELL_TEMPLATE_DEFS) {
      expect(() => validateTemplatePayload(d), d.name).not.toThrow();
      expect(d.body_text).not.toMatch(/lulu|لولو/i);
    }
    expect(CROSS_SELL_TEMPLATE_DEFS.find((d) => d.name === "cross_sell_bi")!.body_text).toContain("Hi {{4}}, customers who buy {{5}} often add {{6}}");
  });
});
