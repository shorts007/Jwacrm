/**
 * Customer-insights snapshot helpers (pure). The snapshot is a long table
 * produced by docs/lulu/bigquery/insights_metrics.sql.
 */

export interface InsightRow {
  grp: string;
  period: string;
  dim: string;
  dim_value: string;
  metric: string;
  value: number;
}

export const MAX_INSIGHT_ROWS = 50_000;

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : null);

/** Validate the rows posted by n8n. Returns cleaned rows + count of rejected ones. */
export function parseInsightRows(raw: unknown[]): { rows: InsightRow[]; rejected: number } {
  const rows: InsightRow[] = [];
  let rejected = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      rejected++;
      continue;
    }
    const o = r as Record<string, unknown>;
    const value = typeof o.value === "number" ? o.value : Number(o.value);
    const grp = str(o.grp, 40);
    const metric = str(o.metric, 60);
    if (!grp || !metric || !Number.isFinite(value)) {
      rejected++;
      continue;
    }
    rows.push({
      grp,
      period: str(o.period, 20) ?? "all",
      dim: str(o.dim, 40) ?? "all",
      dim_value: str(o.dim_value, 200) ?? "all",
      metric,
      value,
    });
  }
  return { rows, rejected };
}

/** Index rows of one group as period → dim_value → metric → value. */
export function indexGroup(rows: InsightRow[], grp: string) {
  const out = new Map<string, Map<string, Record<string, number>>>();
  for (const r of rows) {
    if (r.grp !== grp) continue;
    let byDim = out.get(r.period);
    if (!byDim) out.set(r.period, (byDim = new Map()));
    const rec = byDim.get(r.dim_value) ?? {};
    rec[r.metric] = r.value;
    byDim.set(r.dim_value, rec);
  }
  return out;
}

export interface MonthPoint {
  month: string;
  orders: number;
  customers: number;
  revenue: number;
  aov: number;
  newCustomers: number;
  repeatCustomers: number;
  repeatShare: number; // 0..1 of customers who were not new that month
  discountShare: number | null; // share of orders discounted (orders with data)
  discountCost: number;
}

/** Monthly series sorted by month. */
export function monthlySeries(rows: InsightRow[]): MonthPoint[] {
  const idx = indexGroup(rows, "monthly");
  return [...idx.entries()]
    .map(([month, byDim]) => {
      const m = byDim.get("all") ?? {};
      const orders = m.orders ?? 0;
      const customers = m.customers ?? 0;
      const newCustomers = m.new_customers ?? 0;
      const withData = m.orders_with_discount_data ?? 0;
      return {
        month,
        orders,
        customers,
        revenue: m.revenue ?? 0,
        aov: orders ? (m.revenue ?? 0) / orders : 0,
        newCustomers,
        repeatCustomers: Math.max(customers - newCustomers, 0),
        repeatShare: customers ? Math.max(customers - newCustomers, 0) / customers : 0,
        discountShare: withData ? (m.discounted_orders ?? 0) / withData : null,
        discountCost: m.discount_cost ?? 0,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Percentage change, or null when the base is zero. */
export const pctChange = (now: number, before: number) => (before ? (now - before) / before : null);

/** Month × dimension table for one metric (e.g. store_monthly / orders). Months ascending, last `n` only. */
export function dimMonthTable(rows: InsightRow[], grp: string, metric: string, n = 6) {
  const idx = indexGroup(rows, grp);
  const months = [...idx.keys()].sort().slice(-n);
  const dims = new Set<string>();
  for (const m of months) for (const d of idx.get(m)!.keys()) dims.add(d);
  const table = [...dims].map((dim) => ({
    dim,
    values: months.map((m) => idx.get(m)?.get(dim)?.[metric] ?? 0),
  }));
  table.sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
  return { months, table };
}

/** Rate table for a ratio group, e.g. return30 (returned / orders) per dim. */
export function rateTable(rows: InsightRow[], grp: string, num: string, den: string) {
  const byDim = new Map<string, { dim_value: string; den: number; num: number; rate: number }[]>();
  const idx = indexGroup(
    rows.filter((r) => r.grp === grp).map((r) => ({ ...r, period: r.dim })),
    grp,
  );
  for (const [dim, values] of idx) {
    const list = [...values.entries()].map(([dim_value, m]) => ({
      dim_value,
      den: m[den] ?? 0,
      num: m[num] ?? 0,
      rate: m[den] ? (m[num] ?? 0) / m[den] : 0,
    }));
    list.sort((a, b) => a.dim_value.localeCompare(b.dim_value));
    byDim.set(dim, list);
  }
  return byDim;
}

/** Retention cohorts: cohort month → [share active at offset 0..N]. */
export function cohortMatrix(rows: InsightRow[]) {
  const idx = indexGroup(rows, "cohort");
  return [...idx.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, byOff]) => {
      const size = byOff.get("0")?.customers ?? 0;
      const maxOff = Math.max(...[...byOff.keys()].map(Number));
      const shares = Array.from({ length: maxOff + 1 }, (_, i) =>
        size ? (byOff.get(String(i))?.customers ?? 0) / size : 0,
      );
      return { cohort, size, shares };
    });
}

/** Weekday × hour grid (dow 1=Sunday … 7=Saturday). */
export function dowHourGrid(rows: InsightRow[]) {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of rows) {
    if (r.grp !== "dow_hour") continue;
    const m = /^(\d)-(\d{2})$/.exec(r.dim_value);
    if (!m) continue;
    const d = Number(m[1]) - 1;
    const h = Number(m[2]);
    if (d >= 0 && d < 7 && h >= 0 && h < 24) grid[d][h] = r.value;
  }
  return grid;
}

export function dataAsOf(rows: InsightRow[]): string | null {
  return rows.find((r) => r.grp === "meta" && r.dim === "data_as_of")?.dim_value ?? null;
}
