import { describe, expect, it } from "vitest";
import {
  cohortMatrix,
  comparePairs,
  currentPeriod,
  dataAsOf,
  momTable,
  movers,
  dimMonthTable,
  dowHourGrid,
  monthlySeries,
  parseInsightRows,
  pctChange,
  rateTable,
  type InsightRow,
} from "./index";

const r = (grp: string, period: string, dim: string, dim_value: string, metric: string, value: number): InsightRow => ({
  grp, period, dim, dim_value, metric, value,
});

const rows: InsightRow[] = [
  r("monthly", "2026-08", "all", "all", "orders", 100),
  r("monthly", "2026-08", "all", "all", "customers", 80),
  r("monthly", "2026-08", "all", "all", "revenue", 15000),
  r("monthly", "2026-08", "all", "all", "new_customers", 20),
  r("monthly", "2026-08", "all", "all", "orders_with_discount_data", 50),
  r("monthly", "2026-08", "all", "all", "discounted_orders", 10),
  r("monthly", "2026-07", "all", "all", "orders", 50),
  r("store_monthly", "2026-08", "store", "3810", "orders", 70),
  r("store_monthly", "2026-08", "store", "3805", "orders", 30),
  r("store_monthly", "2026-07", "store", "3810", "orders", 40),
  r("return30", "all", "discounted", "yes", "orders", 200),
  r("return30", "all", "discounted", "yes", "returned", 50),
  r("return30", "all", "discounted", "no", "orders", 100),
  r("return30", "all", "discounted", "no", "returned", 40),
  r("cohort", "2026-01", "month_offset", "0", "customers", 100),
  r("cohort", "2026-01", "month_offset", "1", "customers", 30),
  r("cohort", "2026-01", "month_offset", "2", "customers", 20),
  r("dow_hour", "last180", "dow_hour", "6-19", "orders", 42),
  r("meta", "all", "data_as_of", "2026-10-05T15:08:06Z", "orders_in_base", 1),
];

describe("insights helpers", () => {
  it("parses and rejects bad rows", () => {
    const p = parseInsightRows([{ grp: "monthly", metric: "orders", value: "12", period: "2026-08" }, { grp: "x" }, null, { grp: "a", metric: "b", value: "NaN" }]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ value: 12, dim: "all", dim_value: "all" });
    expect(p.rejected).toBe(3);
  });
  it("builds the monthly series", () => {
    const s = monthlySeries(rows);
    expect(s.map((x) => x.month)).toEqual(["2026-07", "2026-08"]);
    expect(s[1]).toMatchObject({ orders: 100, aov: 150, newCustomers: 20, repeatCustomers: 60, repeatShare: 0.75, discountShare: 0.2 });
    expect(s[0].discountShare).toBeNull();
    expect(pctChange(100, 50)).toBe(1);
    expect(pctChange(1, 0)).toBeNull();
  });
  it("store × month table sorted by latest month", () => {
    const t = dimMonthTable(rows, "store_monthly", "orders");
    expect(t.months).toEqual(["2026-07", "2026-08"]);
    expect(t.table[0]).toEqual({ dim: "3810", values: [40, 70] });
    expect(t.table[1]).toEqual({ dim: "3805", values: [0, 30] });
  });
  it("rate tables, cohorts, weekday grid, as-of", () => {
    const rt = rateTable(rows, "return30", "returned", "orders").get("discounted")!;
    expect(rt.find((x) => x.dim_value === "yes")!.rate).toBe(0.25);
    expect(rt.find((x) => x.dim_value === "no")!.rate).toBe(0.4);
    expect(cohortMatrix(rows)[0]).toEqual({ cohort: "2026-01", size: 100, shares: [1, 0.3, 0.2] });
    // 2026-03 is month-to-date → offset 2 dropped
    expect(cohortMatrix(rows, "2026-03")[0].shares).toEqual([1, 0.3]);
    expect(dowHourGrid(rows)[5][19]).toBe(42);
    expect(dataAsOf(rows)).toBe("2026-10-05T15:08:06Z");
  });
});

describe("month-on-month (departments / product groups)", () => {
  const asOf = "2026-10-12T15:13:57Z"; // 12 Oct Riyadh
  const mm: InsightRow[] = [
    // all orders + picking coverage (Sep: 90% of orders have picking detail, Aug: 100%)
    r("picking_coverage", "2026-08", "all", "all", "orders", 1000),
    r("picking_coverage", "2026-08", "all", "all", "picked_orders", 1000),
    r("picking_coverage", "2026-08", "all", "all", "orders_td", 400),
    r("picking_coverage", "2026-08", "all", "all", "picked_orders_td", 400),
    r("picking_coverage", "2026-09", "all", "all", "orders", 1000),
    r("picking_coverage", "2026-09", "all", "all", "picked_orders", 900),
    r("picking_coverage", "2026-09", "all", "all", "orders_td", 400),
    r("picking_coverage", "2026-09", "all", "all", "picked_orders_td", 400),
    r("picking_coverage", "2026-10", "all", "all", "orders", 300),
    r("picking_coverage", "2026-10", "all", "all", "picked_orders", 300),
    r("picking_coverage", "2026-10", "all", "all", "orders_td", 300),
    r("picking_coverage", "2026-10", "all", "all", "picked_orders_td", 300),
    // Apr: picking feed barely started — hidden
    r("picking_coverage", "2026-04", "all", "all", "orders", 1000),
    r("picking_coverage", "2026-04", "all", "all", "picked_orders", 200),
    r("dept", "2026-04", "dept", "001", "orders", 100),
    r("dept", "2026-08", "dept", "001", "orders", 500),
    r("dept", "2026-08", "dept", "001", "orders_td", 200),
    r("dept", "2026-09", "dept", "001", "orders", 450), // 450 / 0.9 = 500 → flat, not -10%
    r("dept", "2026-09", "dept", "001", "orders_td", 200),
    r("dept", "2026-10", "dept", "001", "orders", 150),
    r("dept", "2026-10", "dept", "001", "orders_td", 150),
    r("dept", "2026-08", "dept", "011", "orders", 100),
    r("dept", "2026-09", "dept", "011", "orders", 180), // 200 adjusted → +100
    r("dept", "2026-09", "dept", "011", "orders_td", 80),
    r("dept", "2026-10", "dept", "011", "orders", 40),
  ];

  it("reads the month-to-date and day in Riyadh time", () => {
    expect(currentPeriod(asOf)).toEqual({ month: "2026-10", day: 12 });
    expect(currentPeriod("2026-09-30T22:30:00Z")).toEqual({ month: "2026-10", day: 1 });
    expect(currentPeriod(null)).toEqual({ month: null, day: null });
  });

  it("scales by picking coverage, hides months without picking data, compares MTD like-for-like", () => {
    const t = momTable(mm, "dept", "orders", asOf);
    expect(t.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    const g = t.rows.find((x) => x.dim === "001")!;
    expect(g.cells[1].value).toBeCloseTo(500);
    expect(g.cells[1].change).toBeCloseTo(0);
    // Oct 1–12: 150 vs Sep 1–12: 200 → -25%
    expect(g.cells[2].change).toBeCloseTo(-0.25);
    // all orders: Oct 300 vs Sep 1–12 400 → -25%
    expect(t.total!.cells[2].change).toBeCloseTo(-0.25);
    expect(t.total!.cells[1].change).toBeCloseTo(0);
  });

  it("offers last-complete and month-to-date comparisons and ranks movers by change", () => {
    const pairs = comparePairs(mm, "dept", asOf);
    expect(pairs.map((p) => [p.key, p.cur, p.prev])).toEqual([
      ["full", "2026-09", "2026-08"],
      ["td", "2026-10", "2026-09"],
    ]);
    const m = movers(mm, "dept", "orders", pairs[0], asOf);
    expect(m.up.map((x) => x.dim)).toEqual(["011"]);
    expect(m.up[0].delta).toBeCloseTo(100);
    expect(m.down).toEqual([]); // 001 is flat once the coverage gap is accounted for
    const td = movers(mm, "dept", "orders", pairs[1], asOf);
    expect(td.down.map((x) => x.dim)).toEqual(["001", "011"]); // -50 before -40
    expect(td.total!.change).toBeCloseTo(-0.25);
  });
});
