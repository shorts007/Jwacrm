import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMPAIGN_ROWS,
  DEFAULT_POLICY,
  campaignFromRow,
  gapBeforeNext,
  isPauseWorthyError,
  planSends,
  riyadhDayStart,
  totalDuration,
  type CampaignRow,
  type DryRunProfileRow,
} from "./index";

const NOW = new Date("2026-09-24T12:00:00Z");
const secondOrder = campaignFromRow({
  id: "so", campaign_code: "SECOND_ORDER", name: "Second Order", campaign_type: "SECOND_ORDER",
  rule_params: { ...DEFAULT_CAMPAIGN_ROWS.find((r) => r.campaign_code === "SECOND_ORDER")!.rule_params },
  offer_id: null, active: true,
} as CampaignRow);

const row = (o: Partial<DryRunProfileRow>): DryRunProfileRow => ({
  customer_id: "c", mobile: "+966500000000", name: "N", language: "ar", birthday: null,
  last_order_date: "2026-09-10", total_orders: 1, total_sales: 100, median_interval_days: null,
  vip_flag: false, marketing_opt_in: true, active_complaint: false, suspect_reason: null,
  preferred_store: null, price_sensitivity: null, ...o,
});

const base = {
  liveCampaigns: [secondOrder], policy: DEFAULT_POLICY, now: NOW, remainingCap: 100,
  history: new Map(), receivedCodes: new Map(), stopDigits: new Set<string>(), alreadyQueuedToday: new Set<string>(),
};

describe("pacing", () => {
  it("60 s, 61 s, 62 s … between messages", () => {
    expect([0, 1, 2, 99].map((n) => gapBeforeNext(n))).toEqual([60, 61, 62, 159]);
    // 100 messages: 6000 + (0+…+99) = 10,950 s ≈ 3 h 2.5 min
    expect(totalDuration(100)).toBe(10_950);
  });
  it("Riyadh day boundary", () => {
    expect(riyadhDayStart(new Date("2026-09-24T22:30:00Z")).toISOString()).toBe("2026-09-24T21:00:00.000Z");
    expect(riyadhDayStart(new Date("2026-09-24T20:30:00Z")).toISOString()).toBe("2026-09-23T21:00:00.000Z");
  });
});

describe("planSends", () => {
  it("picks one-order customers in the 7-29 day window, freshest first, within the cap", () => {
    const rows = [
      row({ customer_id: "old", last_order_date: "2026-08-30" }), // 25 d
      row({ customer_id: "fresh", last_order_date: "2026-09-16", mobile: "+966500000001" }), // 8 d
      row({ customer_id: "toosoon", last_order_date: "2026-09-20" }), // 4 d → no match
      row({ customer_id: "repeat", total_orders: 3, last_order_date: "2026-09-01" }), // not a 2nd-order case
    ];
    const r = planSends({ ...base, rows, remainingCap: 1 });
    expect(r.planned.map((p) => p.customerId)).toEqual(["fresh"]);
    expect(r.skipped.daily_cap).toBe(1);
    expect(r.planned[0].idempotencyKey).toBe("SECONDORDER_20260924_fresh");
  });
  it("respects STOP list, suspects, already-queued and already-received", () => {
    const rows = [
      row({ customer_id: "stopped", mobile: "+966511111111" }),
      row({ customer_id: "sus", suspect_reason: "many_names:9" }),
      row({ customer_id: "queued" }),
      row({ customer_id: "got_it" }),
    ];
    const r = planSends({
      ...base, rows,
      stopDigits: new Set(["966511111111"]),
      alreadyQueuedToday: new Set(["queued"]),
      receivedCodes: new Map([["got_it", new Set(["SECOND_ORDER"])]]),
    });
    expect(r.planned).toHaveLength(0);
    expect(r.skipped).toMatchObject({ opted_out: 1, already_queued_today: 1, already_received_campaign: 1 });
  });
  it("nothing is planned when no campaign is live", () => {
    expect(planSends({ ...base, rows: [row({})], liveCampaigns: [] }).planned).toHaveLength(0);
  });
});

describe("isPauseWorthyError", () => {
  it("pauses on rate limits / blocks, not on a single bad recipient", () => {
    expect(isPauseWorthyError("Meta API error: (#131048) Spam rate limit hit")).toBe(true);
    expect(isPauseWorthyError("(#131056) pair rate limit")).toBe(true);
    expect(isPauseWorthyError("(#368) Temporarily blocked for policies violations")).toBe(true);
    expect(isPauseWorthyError("(#131026) Message undeliverable")).toBe(false);
    expect(isPauseWorthyError("(#132001) Template name does not exist")).toBe(false);
  });
});
