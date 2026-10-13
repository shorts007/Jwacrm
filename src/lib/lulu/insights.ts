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

const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Retention cohorts: cohort month → [share active at offset 0..N].
 * `partialMonth` (YYYY-MM, the month-to-date) is dropped so the newest diagonal
 * isn't mistaken for a retention collapse.
 */
export function cohortMatrix(rows: InsightRow[], partialMonth: string | null = null) {
  const idx = indexGroup(rows, "cohort");
  return [...idx.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, byOff]) => {
      const size = byOff.get("0")?.customers ?? 0;
      let maxOff = Math.max(...[...byOff.keys()].map(Number));
      while (maxOff > 0 && partialMonth && addMonths(cohort, maxOff) >= partialMonth) maxOff--;
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

// ------------------------------------------------------------------ month-on-month (departments / products)

export type MomMetric = "orders" | "customers" | "revenue";

/** Months where fewer orders than this have picking detail are not shown (Apr 2026: picking feed started). */
export const MIN_PICKING_COVERAGE = 0.5;

/** The month-to-date (YYYY-MM) and how many of its days have data, in Riyadh time. */
export function currentPeriod(asOf: string | null): { month: string | null; day: number | null } {
  const t = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(t)) return { month: null, day: null };
  const d = new Date(t + 3 * 3600_000).toISOString(); // Riyadh = UTC+3, no DST
  return { month: d.slice(0, 7), day: Number(d.slice(8, 10)) };
}

type Cov = Map<string, { full: number | null; td: number | null }>;

/** Share of each month's orders that have picking (item) detail — full month and first N days. */
export function pickingCoverage(rows: InsightRow[]): Cov {
  const out: Cov = new Map();
  for (const [month, byDim] of indexGroup(rows, "picking_coverage")) {
    const m = byDim.get("all") ?? {};
    out.set(month, {
      full: m.orders ? (m.picked_orders ?? 0) / m.orders : null,
      td: m.orders_td ? (m.picked_orders_td ?? 0) / m.orders_td : null,
    });
  }
  return out;
}

export interface ComparePair {
  key: "full" | "td";
  cur: string;
  prev: string;
  /** true = first N days of both months (the current month is not finished). */
  partial: boolean;
}

/** The comparisons worth showing: last complete month vs the one before, and month-to-date vs the same days last month. */
export function comparePairs(rows: InsightRow[], grp: string, asOf: string | null): ComparePair[] {
  const months = new Set(indexGroup(rows, grp).keys());
  const { month: current } = currentPeriod(asOf);
  const complete = [...months].filter((m) => m !== current).sort();
  const out: ComparePair[] = [];
  const last = complete.at(-1);
  if (last && months.has(addMonths(last, -1))) out.push({ key: "full", cur: last, prev: addMonths(last, -1), partial: false });
  if (current && months.has(current) && months.has(addMonths(current, -1))) {
    out.push({ key: "td", cur: current, prev: addMonths(current, -1), partial: true });
  }
  return out;
}

/**
 * One value, scaled up for orders without picking detail (`adjust`). `partial` = first N days only
 * (`<metric>_td`; for the month-to-date itself that is the whole month so far). null = not measurable.
 */
function momValue(
  idx: Map<string, Map<string, Record<string, number>>>,
  cov: Cov | null,
  month: string,
  dim: string,
  metric: MomMetric,
  partial: boolean,
  current: string | null,
): number | null {
  const byDim = idx.get(month);
  if (!byDim) return null;
  const rec = byDim.get(dim);
  const raw = partial ? (rec?.[`${metric}_td`] ?? (month === current ? rec?.[metric] : undefined)) : rec?.[metric];
  if (partial && raw === undefined && rec && month !== current) return null; // no like-for-like figure for this month
  const v = raw ?? 0;
  if (!cov || cov.size === 0) return v;
  const c = partial ? cov.get(month)?.td : cov.get(month)?.full;
  if (c === undefined || c === null || c < MIN_PICKING_COVERAGE) return null;
  return v / c;
}

export interface MomCell {
  month: string;
  value: number | null;
  /** vs the previous month; for the month-to-date: vs the same days of the previous month. */
  change: number | null;
}

export interface MomRow {
  dim: string;
  cells: MomCell[];
}

/**
 * Month-on-month table for `dept` / `product_monthly`: last `n` months, each value with its change
 * vs the previous month. Values are scaled by picking coverage so gaps in the picking feed do not
 * show as drops. `total` = all orders (from picking_coverage), the yardstick for "better / worse than overall".
 */
export function momTable(rows: InsightRow[], grp: string, metric: MomMetric, asOf: string | null, n = 6) {
  const idx = indexGroup(rows, grp);
  const cov = pickingCoverage(rows);
  const { month: current, day } = currentPeriod(asOf);
  const months = [...idx.keys()]
    .sort()
    .filter((m) => cov.size === 0 || (cov.get(m)?.full ?? 0) >= MIN_PICKING_COVERAGE)
    .slice(-n);

  const cellsFor = (ix: typeof idx, c: Cov | null, dim: string): MomCell[] =>
    months.map((m) => {
      const partial = m === current;
      const value = momValue(ix, c, m, dim, metric, false, current);
      const now = momValue(ix, c, m, dim, metric, partial, current);
      const before = ix.has(addMonths(m, -1)) ? momValue(ix, c, addMonths(m, -1), dim, metric, partial, current) : null;
      return { month: m, value, change: now !== null && before !== null ? pctChange(now, before) : null };
    });

  const dims = new Set<string>();
  for (const m of months) for (const d of idx.get(m)?.keys() ?? []) dims.add(d);
  const table: MomRow[] = [...dims].map((dim) => ({ dim, cells: cellsFor(idx, cov, dim) }));
  const lastComplete = months.filter((m) => m !== current).at(-1);
  const li = lastComplete ? months.indexOf(lastComplete) : months.length - 1;
  table.sort((a, b) => (b.cells[li]?.value ?? 0) - (a.cells[li]?.value ?? 0));

  const covIdx = indexGroup(rows, "picking_coverage");
  const total: MomRow | null = covIdx.size ? { dim: "all", cells: cellsFor(covIdx, null, "all") } : null;
  return { months, current, day, rows: table, total, adjusted: cov.size > 0 };
}

export interface Mover {
  dim: string;
  before: number;
  now: number;
  delta: number;
  change: number | null;
}

/** Biggest risers and fallers between two months (scaled by picking coverage), sorted by change in value. */
export function movers(rows: InsightRow[], grp: string, metric: MomMetric, pair: ComparePair, asOf: string | null) {
  const idx = indexGroup(rows, grp);
  const cov = pickingCoverage(rows);
  const { month: current } = currentPeriod(asOf);
  const dims = new Set([...(idx.get(pair.cur)?.keys() ?? []), ...(idx.get(pair.prev)?.keys() ?? [])]);
  const list: Mover[] = [];
  for (const dim of dims) {
    const now = momValue(idx, cov, pair.cur, dim, metric, pair.partial, current);
    const before = momValue(idx, cov, pair.prev, dim, metric, pair.partial, current);
    if (now === null || before === null) continue;
    list.push({ dim, before, now, delta: now - before, change: pctChange(now, before) });
  }
  list.sort((a, b) => b.delta - a.delta);
  const covIdx = indexGroup(rows, "picking_coverage");
  const tNow = covIdx.size ? momValue(covIdx, null, pair.cur, "all", metric, pair.partial, current) : null;
  const tBefore = covIdx.size ? momValue(covIdx, null, pair.prev, "all", metric, pair.partial, current) : null;
  const total = tNow !== null && tBefore !== null ? { before: tBefore, now: tNow, delta: tNow - tBefore, change: pctChange(tNow, tBefore) } : null;
  return {
    up: list.filter((m) => m.delta > 0),
    down: list.filter((m) => m.delta < 0).reverse(),
    total,
  };
}
