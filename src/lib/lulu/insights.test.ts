import { describe, expect, it } from "vitest";
import {
  cohortMatrix,
  dataAsOf,
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
