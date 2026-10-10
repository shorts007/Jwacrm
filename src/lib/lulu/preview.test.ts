import { describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_ROWS, DEFAULT_POLICY, campaignFromRow, maskPhone, previewAudience, type CampaignRow, type DryRunProfileRow } from "./index";

const NOW = new Date("2026-09-24T12:00:00Z");
const camp = (code: string, id: string) =>
  campaignFromRow({
    id,
    campaign_code: code,
    name: code,
    campaign_type: code,
    rule_params: { ...DEFAULT_CAMPAIGN_ROWS.find((r) => r.campaign_code === code)!.rule_params },
    offer_id: null,
    active: false,
  } as CampaignRow);
const secondOrder = camp("SECOND_ORDER", "so");

const row = (o: Partial<DryRunProfileRow>): DryRunProfileRow => ({
  customer_id: "c", mobile: "+966500000000", name: "N", language: "ar", birthday: null,
  last_order_date: "2026-09-10", total_orders: 1, total_sales: 100, median_interval_days: null,
  vip_flag: false, marketing_opt_in: true, active_complaint: false, suspect_reason: null,
  preferred_store: null, price_sensitivity: null, ...o,
});
const base = { otherLive: [], policy: DEFAULT_POLICY, now: NOW, history: new Map(), receivedCodes: new Map(), stopDigits: new Set<string>() };

describe("previewAudience", () => {
  it("previews an inactive campaign as if it were live, with reasons for everyone left out", () => {
    const rows = [
      row({ customer_id: "a", mobile: "+966500000001" }),
      row({ customer_id: "stop", mobile: "+966511111111" }),
      row({ customer_id: "got", mobile: "+966500000002" }),
      row({ customer_id: "sus", suspect_reason: "many_names:9" }),
      row({ customer_id: "nomatch", total_orders: 5 }),
    ];
    const p = previewAudience({
      ...base,
      rows,
      target: secondOrder,
      stopDigits: new Set(["966511111111"]),
      receivedCodes: new Map([["got", new Set(["SECOND_ORDER"])]]),
    });
    expect(p.recipients).toEqual(["a"]);
    expect(p.matched).toBe(3);
    expect(p.exclusions).toEqual({ replied_stop: 1, already_received_campaign: 1 });
    expect(p.suspects).toBe(1);
  });

  it("applies the per-customer check and the holdout", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ customer_id: `c${i}`, mobile: `+9665000${String(i).padStart(5, "0")}` }));
    const p = previewAudience({ ...base, rows, target: { ...secondOrder, holdoutPct: 10 }, customerCheck: (r) => (r.customer_id === "c0" ? "offer_not_for_segment" : null) });
    expect(p.exclusions.offer_not_for_segment).toBe(1);
    expect(p.holdout).toBeGreaterThan(5);
    expect(p.holdout).toBeLessThan(40);
    expect(p.recipients.length + p.holdout + 1).toBe(200);
  });

  it("maskPhone hides the middle digits", () => {
    expect(maskPhone("+966546182300")).toBe("9665•••••300");
  });
});
