import { describe, expect, it } from "vitest";
import { validateTemplatePayload } from "@/lib/whatsapp/template-validators";
import {
  DEFAULT_CAMPAIGN_ROWS,
  DEFAULT_POLICY,
  PERSONAL_TEMPLATE_DEFS,
  buildParamsForKind,
  campaignFromRow,
  decideNextBestAction,
  dueItems,
  itemsText,
  parseUsualItems,
  type CampaignRow,
  type CustomerProfile,
  type UsualItem,
} from "./index";

const NOW = new Date("2026-10-07T12:00:00Z");
const camp = (code: string) => {
  const r = DEFAULT_CAMPAIGN_ROWS.find((x) => x.campaign_code === code)!;
  return campaignFromRow({ id: code, campaign_code: r.campaign_code, name: r.name, campaign_type: r.campaign_type,
    rule_params: JSON.parse(JSON.stringify(r.rule_params)), offer_id: null, active: true, priority: r.priority } as CampaignRow);
};
const items: UsualItem[] = [
  { name: "Banana Ecuador 1 kg", times: 8, last: "2026-09-30", every: 7 }, // 7 d ago → due (ratio 1.0)
  { name: "LuLu White Eggs Large 30 pcs", times: 5, last: "2026-09-24", every: 10 }, // 13 d → overdue but < 2×
  { name: "Basmati Rice 5 kg", times: 3, last: "2026-09-27", every: 30 }, // 10 d → not yet
  { name: "Old habit", times: 2, last: "2026-07-01", every: 14 }, // 98 d → lapsed
];
const cust = (o: Partial<CustomerProfile> = {}): CustomerProfile => ({
  customerId: "c", mobile: "+966500000000", language: "ar", lastOrderDate: "2026-09-30", totalOrders: 12, totalSales: 2000,
  medianIntervalDays: 7, vipFlag: false, marketingOptIn: true, activeComplaint: false, usualItems: items, itemsAsOf: "2026-10-06", ...o,
});

describe("dueItems", () => {
  it("returns items in their restock window, most overdue first; ignores lapsed and not-yet", () => {
    expect(dueItems(items, NOW).map((i) => i.name)).toEqual(["LuLu White Eggs Large 30 pcs", "Banana Ecuador 1 kg"]);
    expect(dueItems(undefined, NOW)).toEqual([]);
  });
});

describe("Replenishment & Buy Again campaigns", () => {
  const campaigns = ["REPLENISHMENT", "BUY_AGAIN", "INACTIVE_15", "WINBACK_30", "SECOND_ORDER", "VIP_PROTECTION", "LOST_60"].map(camp);
  const run = (p: CustomerProfile) => decideNextBestAction({ profile: p, campaigns, policy: DEFAULT_POLICY, history: [], now: NOW });

  it("active customer with a due item gets Replenishment", () => {
    const r = run(cust());
    expect(r.action?.campaignCode).toBe("REPLENISHMENT");
    expect(r.action?.reason).toMatch(/Restock due: LuLu White Eggs/);
  });
  it("at-risk customer with usual items gets Buy Again instead of the generic 15-day message", () => {
    const r = run(cust({ lastOrderDate: "2026-09-25", medianIntervalDays: 5, usualItems: items.map((i) => ({ ...i, last: "2026-06-01" })) }));
    expect(r.action?.campaignCode).toBe("BUY_AGAIN");
    expect(r.skipped).toContainEqual({ campaignCode: "INACTIVE_15", reason: "lower_priority" });
  });
  it("stays silent when the latest order is newer than the item data (could have just bought it)", () => {
    const r = run(cust({ lastOrderDate: "2026-10-03", itemsAsOf: "2026-09-30" }));
    expect(r.action?.campaignCode).not.toBe("REPLENISHMENT");
    expect(run(cust({ itemsAsOf: null })).action?.campaignCode).not.toBe("REPLENISHMENT");
  });
  it("waits 2 days after any order before a restock reminder", () => {
    expect(run(cust({ lastOrderDate: "2026-10-06" })).action?.campaignCode).not.toBe("REPLENISHMENT");
  });
  it("no usual items → normal lifecycle campaigns", () => {
    const r = run(cust({ lastOrderDate: "2026-09-25", medianIntervalDays: 5, usualItems: undefined }));
    expect(r.action?.campaignCode).toBe("INACTIVE_15");
  });
});

describe("wording & parsing", () => {
  it("names up to 3 products per language", () => {
    expect(itemsText(["A", "B", "C", "D"], "en")).toBe("A, B and C");
    expect(itemsText(["A", "B"], "ar")).toBe("A و B");
    expect(itemsText(["A"], "en")).toBe("A");
    expect(buildParamsForKind("bi", "REPLENISHMENT", { name: "Sara Ali", items: ["Banana", "Eggs"] })).toEqual(["Sara", "Banana و Eggs", "Sara", "Banana and Eggs"]);
  });
  it("parses BigQuery's JSON string and drops bad entries", () => {
    expect(parseUsualItems('[{"name":"Banana","times":4,"last":"2026-09-30","every":7},{"name":"","last":"x"}]')).toEqual([
      { name: "Banana", times: 4, last: "2026-09-30", every: 7 },
    ]);
    expect(parseUsualItems("not json")).toBeNull();
    expect(parseUsualItems(null)).toBeNull();
  });
  it("templates pass WACRM's Meta-rule validator and are brand-neutral", () => {
    for (const d of PERSONAL_TEMPLATE_DEFS) {
      expect(() => validateTemplatePayload(d), d.name).not.toThrow();
      expect(d.body_text).not.toMatch(/lulu|لولو/i);
    }
    expect(PERSONAL_TEMPLATE_DEFS.map((d) => d.name)).toEqual(["restock_ar", "restock_en", "restock_bi", "buy_again_ar", "buy_again_en", "buy_again_bi"]);
  });
});
