import { describe, expect, it } from "vitest";
import { attributeOrders, isHoldout, lift, type Touch } from "./index";

const d = (s: string) => new Date(s);

describe("holdout", () => {
  it("is deterministic and close to the requested share", () => {
    expect(isHoldout("966500000001", "SECOND_ORDER", 10)).toBe(isHoldout("966500000001", "SECOND_ORDER", 10));
    const n = 20_000;
    let h = 0;
    for (let i = 0; i < n; i++) if (isHoldout(`9665${String(i).padStart(8, "0")}`, "SECOND_ORDER", 10)) h++;
    expect(h / n).toBeGreaterThan(0.085);
    expect(h / n).toBeLessThan(0.115);
    expect(isHoldout("x", "Y", 0)).toBe(false);
  });
});

describe("attributeOrders", () => {
  const touches: Touch[] = [
    { actionId: "a1", campaignId: "c", customerId: "9661", at: d("2026-10-01T15:00:00Z"), windowDays: 7, control: false },
    { actionId: "a2", campaignId: "c", customerId: "9661", at: d("2026-10-04T15:00:00Z"), windowDays: 7, control: false },
    { actionId: "h1", campaignId: "c", customerId: "9662", at: d("2026-10-01T15:00:00Z"), windowDays: 7, control: true },
  ];
  it("last touch within the window wins; holdout orders become control orders", () => {
    const r = attributeOrders(
      [
        { orderId: "o1", digits: "9661", placedAt: d("2026-10-05T10:00:00Z"), amount: 150, discount: 0 },
        { orderId: "o2", digits: "9661", placedAt: d("2026-09-30T10:00:00Z"), amount: 90, discount: 0 }, // before any message
        { orderId: "o3", digits: "9661", placedAt: d("2026-10-20T10:00:00Z"), amount: 90, discount: 0 }, // after window
        { orderId: "o4", digits: "9662", placedAt: d("2026-10-03T10:00:00Z"), amount: 120, discount: 10 },
        { orderId: "o5", digits: "9669", placedAt: d("2026-10-03T10:00:00Z"), amount: 50, discount: 0 }, // never touched
      ],
      touches,
    );
    expect(r.map((x) => [x.orderId, x.actionId, x.kind])).toEqual([
      ["o1", "a2", "ORDER_ATTRIBUTED"],
      ["o4", "h1", "CONTROL_ORDER"],
    ]);
  });
});

describe("lift", () => {
  it("compares with the control group", () => {
    const l = lift(1000, 120, 120, 9);
    expect(l.conversion).toBe(0.12);
    expect(l.controlConversion).toBe(0.075);
    expect(l.incrementalCustomers).toBe(45);
    expect(l.reliable).toBe(true);
    expect(lift(50, 5, 5, 1).reliable).toBe(false);
  });
});
