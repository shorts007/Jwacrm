"use client";

// Building blocks for the Customer Insights page. All data comes from the
// pre-aggregated BigQuery snapshot (lulu_insights_snapshot) except the
// "customer base today" counts, which come from lulu_customer_profiles.

import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  cohortMatrix,
  comparePairs,
  currentPeriod,
  dimMonthTable,
  dowHourGrid,
  momTable,
  monthlySeries,
  movers,
  pctChange,
  rateTable,
  type InsightRow,
  type MomCell,
  type MomMetric,
  type MomRow,
  type MonthPoint,
  type Mover,
} from "@/lib/lulu/insights";
import { cn } from "@/lib/utils";

export const PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569"];

export const STORE_NAMES: Record<string, string> = {
  "3805": "Amir Fawaz",
  "3806": "Kilo 7",
  "3808": "Hamdaniya",
  "3809": "Madeena Road",
  "3810": "Al Marwa",
  "3814": "Baghdadiya",
  "3815": "Park Tabuk",
  "3817": "Yanbu",
  "3818": "AzizMall",
  "3821": "Russaifa",
  "3825": "Taif",
  "3839": "Train Mall",
};
export const storeLabel = (id: string) => (STORE_NAMES[id] ? `${STORE_NAMES[id]} (${id})` : id);

export const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
export const sar = (v: number) => `SAR ${n0(v)}`;
export const pct = (v: number | null, digits = 0) => (v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`);
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
};

export function Section({ title, hint, children, right }: { title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const good = invert ? value < 0 : value > 0;
  return (
    <span className={cn("text-xs font-medium", Math.abs(value) < 0.005 ? "text-muted-foreground" : good ? "text-emerald-600" : "text-red-600")}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"} {pct(Math.abs(value), 1)}
    </span>
  );
}

/** Last two COMPLETE months (the month of data_as_of is month-to-date). */
export function completeMonths(series: MonthPoint[], asOf: string | null) {
  const asOfMonth = asOf ? asOf.slice(0, 7) : null;
  const done = series.filter((p) => p.month !== asOfMonth);
  return { cur: done.at(-1) ?? null, prev: done.at(-2) ?? null, mtd: series.find((p) => p.month === asOfMonth) ?? null };
}

/** "12 Oct, 18:13" in Riyadh time. */
const riyadhStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Department names for the 3-digit category prefix (picking data). Inferred from the products sold
 * under each code — correct them here if LuLu's own department list uses other names.
 */
export const DEPT_NAMES: Record<string, string> = {
  "001": "Grocery (food & water)",
  "002": "Household & cleaning",
  "003": "Personal care",
  "004": "Dairy & eggs",
  "005": "Frozen food",
  "006": "Fruits & vegetables",
  "007": "Bakery",
  "008": "Nuts, dates & pulses",
  "009": "Deli & cheese",
  "010": "Hot food & snacks",
  "011": "Butchery (meat & chicken)",
  "012": "Fish & seafood",
  "014": "Laptops & tablets",
  "015": "Stationery",
  "016": "Housewares & kitchen",
  "017": "Health & grooming devices",
  "019": "Home textiles & furnishing",
  "023": "Toys",
  "034": "Charcoal & BBQ",
  "036": "Small appliances",
  "037": "Sports",
  "039": "Cosmetics & beauty",
  "040": "Perfumes",
  "044": "Mobile phones",
  "046": "Mobile & gadget accessories",
};
export const deptLabel = (code: string) => DEPT_NAMES[code] ?? (code === "unknown" ? "Unknown" : `Department ${code}`);

export function MonthKpis({ rows, asOf }: { rows: InsightRow[]; asOf: string | null }) {
  const series = monthlySeries(rows);
  const { cur, prev, mtd } = completeMonths(series, asOf);
  if (!cur) return <p className="text-sm text-muted-foreground">No monthly data yet.</p>;
  const items: { label: string; value: string; delta: number | null; invert?: boolean }[] = [
    { label: "Customers who ordered", value: n0(cur.customers), delta: prev ? pctChange(cur.customers, prev.customers) : null },
    { label: "Orders", value: n0(cur.orders), delta: prev ? pctChange(cur.orders, prev.orders) : null },
    { label: "Revenue", value: sar(cur.revenue), delta: prev ? pctChange(cur.revenue, prev.revenue) : null },
    { label: "Average basket", value: sar(cur.aov), delta: prev ? pctChange(cur.aov, prev.aov) : null },
    { label: "New customers", value: n0(cur.newCustomers), delta: prev ? pctChange(cur.newCustomers, prev.newCustomers) : null },
    { label: "Repeat customers", value: `${n0(cur.repeatCustomers)} (${pct(cur.repeatShare)})`, delta: prev ? pctChange(cur.repeatCustomers, prev.repeatCustomers) : null },
    { label: "Orders with a discount", value: pct(cur.discountShare), delta: prev && cur.discountShare !== null && prev.discountShare !== null ? pctChange(cur.discountShare, prev.discountShare) : null, invert: true },
    { label: "Discount cost", value: sar(cur.discountCost), delta: prev ? pctChange(cur.discountCost, prev.discountCost) : null, invert: true },
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {monthLabel(cur.month)} vs {prev ? monthLabel(prev.month) : "—"} (complete months).
        {mtd &&
          ` ${monthLabel(mtd.month)} so far${asOf ? ` (orders up to ${riyadhStamp(asOf)})` : ""}: ${n0(mtd.orders)} orders, ${sar(mtd.revenue)}.`}
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {items.map((i) => (
          <div key={i.label} className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">{i.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{i.value}</div>
            <Delta value={i.delta} invert={i.invert} />
          </div>
        ))}
      </div>
    </div>
  );
}

const axisProps = { tick: { fontSize: 11 }, stroke: "currentColor", className: "text-muted-foreground" } as const;

export function TrendCharts({ rows }: { rows: InsightRow[] }) {
  const data = monthlySeries(rows).map((p) => ({
    ...p,
    label: monthLabel(p.month),
    discountPct: p.discountShare === null ? null : Math.round(p.discountShare * 1000) / 10,
  }));
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="h-64">
        <p className="mb-1 text-xs text-muted-foreground">Revenue (bars) and orders (line)</p>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis yAxisId="l" {...axisProps} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
            <YAxis yAxisId="r" orientation="right" {...axisProps} />
            <Tooltip formatter={(v: unknown, k: unknown) => (k === "Revenue" ? sar(Number(v)) : n0(Number(v)))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="revenue" name="Revenue" fill={PALETTE[0]} radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" dataKey="orders" name="Orders" stroke={PALETTE[2]} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="h-64">
        <p className="mb-1 text-xs text-muted-foreground">New vs repeat customers per month</p>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} />
            <Tooltip formatter={(v: unknown) => n0(Number(v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="repeatCustomers" name="Repeat" stackId="c" fill={PALETTE[1]} />
            <Bar dataKey="newCustomers" name="New" stackId="c" fill={PALETTE[5]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="h-64">
        <p className="mb-1 text-xs text-muted-foreground">Discount cost (bars) and % of orders discounted (line)</p>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis yAxisId="l" {...axisProps} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
            <YAxis yAxisId="r" orientation="right" {...axisProps} unit="%" />
            <Tooltip formatter={(v: unknown, k: unknown) => (k === "Discount cost" ? sar(Number(v)) : `${Number(v)}%`)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="discountCost" name="Discount cost" fill={PALETTE[3]} radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" dataKey="discountPct" name="% discounted" stroke={PALETTE[4]} strokeWidth={2} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type DimMetric = "orders" | "customers" | "revenue" | "new_customers" | "discount_cost";
export const DIM_METRIC_LABEL: Record<DimMetric, string> = {
  orders: "Orders",
  customers: "Customers",
  revenue: "Revenue (SAR)",
  new_customers: "New customers",
  discount_cost: "Discount cost (SAR)",
};

/** Month × store / channel table with share and MoM change, plus a line chart. */
export function DimMonthly({
  rows,
  grp,
  metric,
  label,
  asOf,
  months = 6,
}: {
  rows: InsightRow[];
  grp: "store_monthly" | "channel_monthly";
  metric: DimMetric;
  label: (d: string) => string;
  asOf: string | null;
  months?: number;
}) {
  const { months: ms, table } = dimMonthTable(rows, grp, metric, months);
  if (table.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  // Share and MoM always compare COMPLETE months; the month-to-date column is shown but not compared.
  const mtd = asOf ? asOf.slice(0, 7) : null;
  const lastIdx = ms[ms.length - 1] === mtd ? ms.length - 2 : ms.length - 1;
  table.sort((a, b) => (b.values[lastIdx] ?? 0) - (a.values[lastIdx] ?? 0));
  const total = table.reduce((a, r) => a + (r.values[lastIdx] ?? 0), 0) || 1;
  const chart = ms.map((m, i) => {
    const point: Record<string, string | number> = { label: monthLabel(m) };
    for (const r of table.slice(0, 8)) point[label(r.dim)] = r.values[i];
    return point;
  });
  return (
    <div className="space-y-4">
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} />
            <Tooltip formatter={(v: unknown) => n0(Number(v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {table.slice(0, 8).map((r, i) => (
              <Line key={r.dim} dataKey={label(r.dim)} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">{grp === "store_monthly" ? "Store" : "Channel"}</th>
              {ms.map((m) => (
                <th key={m} className="px-2 py-1.5 text-right font-medium">
                  {monthLabel(m)}
                  {m === mtd ? " (MTD)" : ""}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium">Share {lastIdx >= 0 ? monthLabel(ms[lastIdx]) : ""}</th>
              <th className="px-2 py-1.5 text-right font-medium">MoM</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.dim} className="border-t border-border">
                <td className="px-2 py-1.5 text-foreground">{label(r.dim)}</td>
                {r.values.map((v, i) => (
                  <td key={i} className={cn("px-2 py-1.5 text-right tabular-nums", ms[i] === mtd && "text-muted-foreground")}>
                    {n0(v)}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right tabular-nums">{pct((r.values[lastIdx] ?? 0) / total)}</td>
                <td className="px-2 py-1.5 text-right">
                  <Delta value={lastIdx > 0 ? pctChange(r.values[lastIdx] ?? 0, r.values[lastIdx - 1] ?? 0) : null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-muted-foreground">
          Share and month-on-month change compare complete months only; MTD = month to date.
        </p>
      </div>
    </div>
  );
}

const DIM_TITLES: Record<string, string> = {
  fulfilment: "Order fulfilment (picking data, Apr 2026+)",
  discounted: "Order had a discount",
  basket: "Basket size (SAR)",
  order_number: "Which order it was",
  channel: "Channel",
  store: "Store",
};

/** Horizontal rate bars per condition, compared with the overall baseline. */
export function RateBlocks({
  rows,
  grp,
  num,
  den,
  dims,
  denLabel,
  label,
}: {
  rows: InsightRow[];
  grp: string;
  num: string;
  den: string;
  dims: string[];
  denLabel: string;
  label: (dim: string, v: string) => string;
}) {
  const t = rateTable(rows, grp, num, den);
  const baseline = t.get("all")?.[0]?.rate ?? null;
  return (
    <div className="space-y-4">
      {baseline !== null && (
        <p className="text-sm text-foreground">
          Overall: <b>{pct(baseline, 1)}</b>. Groups clearly <span className="text-red-600">below</span> this are where customers drop off;
          groups clearly <span className="text-emerald-600">above</span> show what keeps them coming back.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {dims
          .filter((d) => t.has(d))
          .map((d) => (
            <div key={d} className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-xs font-semibold text-foreground">{DIM_TITLES[d] ?? d}</h3>
              <div className="space-y-1.5">
                {t.get(d)!.map((r) => {
                  const diff = baseline === null ? 0 : r.rate - baseline;
                  return (
                    <div key={r.dim_value} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs">
                      <span className="truncate text-foreground" title={label(d, r.dim_value)}>{label(d, r.dim_value)}</span>
                      <div className="h-2 rounded bg-muted">
                        <div
                          className={cn("h-2 rounded", diff < -0.03 ? "bg-red-500" : diff > 0.03 ? "bg-emerald-500" : "bg-primary")}
                          style={{ width: `${Math.min(100, r.rate * 100)}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-muted-foreground">
                        {pct(r.rate, 1)} · {n0(r.den)} {denLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function CohortHeatmap({ rows, asOf }: { rows: InsightRow[]; asOf: string | null }) {
  const m = cohortMatrix(rows, asOf ? asOf.slice(0, 7) : null);
  if (m.length === 0) return <p className="text-sm text-muted-foreground">No cohort data.</p>;
  const maxOff = Math.max(...m.map((r) => r.shares.length - 1));
  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">First order</th>
            <th className="px-2 py-1 text-right font-medium">New customers</th>
            {Array.from({ length: maxOff }, (_, i) => (
              <th key={i} className="px-2 py-1 text-center font-medium">M+{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.map((r) => (
            <tr key={r.cohort}>
              <td className="px-2 py-1 text-foreground">{monthLabel(r.cohort)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{n0(r.size)}</td>
              {Array.from({ length: maxOff }, (_, i) => {
                const v = r.shares[i + 1];
                return (
                  <td
                    key={i}
                    className="px-2 py-1 text-center tabular-nums"
                    style={v === undefined ? undefined : { backgroundColor: `rgba(37, 99, 235, ${Math.min(0.85, v * 1.6)})`, color: v > 0.3 ? "white" : undefined }}
                  >
                    {v === undefined ? "" : pct(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Share of each month&rsquo;s new customers who ordered again N months later. Read down a column to see whether newer customers stay
        better or worse than older ones.
      </p>
    </div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function DowHourHeatmap({ rows }: { rows: InsightRow[] }) {
  const g = dowHourGrid(rows);
  const max = Math.max(1, ...g.flat());
  const busiest = g.flatMap((row, d) => row.map((v, h) => ({ d, h, v }))).sort((a, b) => b.v - a.v).slice(0, 3);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="text-[10px]">
          <thead className="text-muted-foreground">
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="w-6 text-center font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.map((row, d) => (
              <tr key={d}>
                <td className="pr-2 text-muted-foreground">{DOW[d]}</td>
                {row.map((v, h) => (
                  <td
                    key={h}
                    title={`${DOW[d]} ${h}:00 — ${n0(v)} orders`}
                    className="h-5 w-6"
                    style={{ backgroundColor: `rgba(22, 163, 74, ${v ? 0.08 + (v / max) * 0.85 : 0.03})` }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Orders by weekday and hour (Riyadh time, last 180 days). Busiest: {busiest.map((b) => `${DOW[b.d]} ${b.h}:00`).join(", ")} — good
        windows for campaign sends.
      </p>
    </div>
  );
}

export function FrequencyTable({ rows }: { rows: InsightRow[] }) {
  const order = ["1", "2", "3-5", "6-10", "11+"];
  const recs = order.map((b) => {
    const get = (m: string) => rows.find((r) => r.grp === "frequency" && r.dim_value === b && r.metric === m)?.value ?? 0;
    return { band: b, customers: get("customers"), revenue: get("revenue") };
  });
  const tc = recs.reduce((a, r) => a + r.customers, 0) || 1;
  const tr = recs.reduce((a, r) => a + r.revenue, 0) || 1;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="px-2 py-1.5 font-medium">Lifetime orders</th>
          <th className="px-2 py-1.5 text-right font-medium">Customers</th>
          <th className="px-2 py-1.5 text-right font-medium">% customers</th>
          <th className="px-2 py-1.5 text-right font-medium">Revenue</th>
          <th className="px-2 py-1.5 text-right font-medium">% revenue</th>
        </tr>
      </thead>
      <tbody>
        {recs.map((r) => (
          <tr key={r.band} className="border-t border-border">
            <td className="px-2 py-1.5 text-foreground">{r.band}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{n0(r.customers)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{pct(r.customers / tc)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{n0(r.revenue)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{pct(r.revenue / tr)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProductsTable({ rows, rankBy = "revenue" }: { rows: InsightRow[]; rankBy?: "revenue" | "customers" }) {
  const byName = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.grp !== "product") continue;
    const rec = byName.get(r.dim_value) ?? {};
    rec[r.metric] = r.value;
    byName.set(r.dim_value, rec);
  }
  const list = [...byName.entries()]
    .map(([name, m]) => ({
      name,
      revenue: m.revenue ?? 0,
      revenue_prev: m.revenue_prev ?? 0,
      units: m.units ?? 0,
      orders: m.orders ?? 0,
      customers: m.customers ?? 0,
    }))
    .sort((a, b) => (rankBy === "customers" ? b.customers - a.customers || b.revenue - a.revenue : b.revenue - a.revenue))
    .slice(0, 40);
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No product data.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">#</th>
            <th className="px-2 py-1.5 font-medium">Product</th>
            <th className="px-2 py-1.5 text-right font-medium">Revenue (90 d)</th>
            <th className="px-2 py-1.5 text-right font-medium">vs previous 90 d</th>
            <th className="px-2 py-1.5 text-right font-medium">Units</th>
            <th className="px-2 py-1.5 text-right font-medium">Orders</th>
            <th className="px-2 py-1.5 text-right font-medium">Customers</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p, i) => (
            <tr key={p.name} className="border-t border-border">
              <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
              <td className="px-2 py-1.5 text-foreground">{p.name}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{n0(p.revenue)}</td>
              <td className="px-2 py-1.5 text-right"><Delta value={pctChange(p.revenue, p.revenue_prev)} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{n0(p.units)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{n0(p.orders)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{n0(p.customers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ month-on-month: departments & product groups

export function Toggle<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`rounded-md px-2 py-1 text-xs ${value === k ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const MOM_METRIC_OPTIONS: [MomMetric, string][] = [
  ["orders", "Orders"],
  ["customers", "Customers"],
  ["revenue", "Revenue"],
];

/** code → best-selling product of the group and how many products it has. */
export function groupLabels(rows: InsightRow[]) {
  const out = new Map<string, { name: string; products: number }>();
  for (const r of rows) if (r.grp === "group_label") out.set(r.dim, { name: r.dim_value, products: r.value });
  return out;
}

export function GroupName({ code, labels }: { code: string; labels: Map<string, { name: string; products: number }> }) {
  const l = labels.get(code);
  if (!l) return <span>Group {code}</span>;
  return (
    <span title={`Product group ${code} (${deptLabel(code.slice(0, 3))}) — ${l.products} product${l.products === 1 ? "" : "s"} counted together`}>
      {l.name}
      {l.products > 1 && <span className="ml-1 text-xs text-muted-foreground">+{l.products - 1} similar</span>}
    </span>
  );
}

const ptsDiff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

function Gap({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const pts = Math.round(value * 100);
  return (
    <span className={cn("text-xs font-medium", pts === 0 ? "text-muted-foreground" : pts > 0 ? "text-emerald-600" : "text-red-600")}>
      {pts > 0 ? "+" : ""}
      {pts} pts
    </span>
  );
}

const periodHead = (m: string, current: string | null, day: number | null) =>
  m === current && day ? `${monthLabel(m)} · 1–${day}` : monthLabel(m);

/**
 * Months as columns, each value with a small ▲/▼ vs the month before. The month-to-date column is
 * compared with the SAME DAYS of the previous month. "vs all orders" = this row's latest change minus
 * the change in all orders: positive = growing faster (or falling slower) than the business.
 */
export function MomTable({
  rows,
  grp,
  metric,
  asOf,
  label,
  limit = 15,
  filter = "all",
  showTotal = true,
}: {
  rows: InsightRow[];
  grp: "dept" | "group_monthly" | "product_monthly";
  metric: MomMetric;
  asOf: string | null;
  label: (dim: string) => ReactNode;
  limit?: number;
  filter?: "all" | "growing" | "falling";
  showTotal?: boolean;
}) {
  const t = momTable(rows, grp, metric, asOf);
  if (t.rows.length === 0 || t.months.length === 0) {
    return <p className="text-sm text-muted-foreground">No data yet — re-run create_insights_view.sql in BigQuery and the n8n sync.</p>;
  }
  const last = t.months.length - 1;
  const totalChange = t.total?.cells[last]?.change ?? null;
  let list = t.rows;
  if (filter !== "all") {
    list = list
      .filter((r) => {
        const c = r.cells[last]?.change;
        return c !== null && c !== undefined && (filter === "growing" ? c > 0 : c < 0);
      })
      .sort((a, b) => {
        // biggest movers in absolute terms first (a big product moving 10% matters more than a tiny one doubling)
        const d = (r: MomRow) => {
          const c = r.cells[last];
          return c?.value && c.change !== null ? c.value - c.value / (1 + c.change) : 0;
        };
        return filter === "growing" ? d(b) - d(a) : d(a) - d(b);
      });
  }
  list = list.slice(0, limit);
  const cell = (c: MomCell, i: number) => (
    <td key={i} className="px-2 py-1.5 text-right align-top">
      <div className="tabular-nums">{c.value === null ? "—" : n0(c.value)}</div>
      <div className="leading-none">{i === 0 && c.change === null ? null : <Delta value={c.change} />}</div>
    </td>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">{grp === "dept" ? "Department" : "Product"}</th>
            {t.months.map((m) => (
              <th key={m} className="whitespace-nowrap px-2 py-1.5 text-right font-medium">
                {periodHead(m, t.current, t.day)}
              </th>
            ))}
            {showTotal && t.total && (
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium" title="Latest change of this row minus the change in all orders">
                vs all orders
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {showTotal && t.total && (
            <tr className="border-t border-border bg-muted/40 font-medium">
              <td className="px-2 py-1.5 text-foreground">All orders{metric === "revenue" ? " (order value)" : ""}</td>
              {t.total.cells.map(cell)}
              <td />
            </tr>
          )}
          {list.map((r) => (
            <tr key={r.dim} className="border-t border-border">
              <td className="px-2 py-1.5 text-foreground">{label(r.dim)}</td>
              {r.cells.map(cell)}
              {showTotal && t.total && (
                <td className="px-2 py-1.5 text-right align-top">
                  <Gap value={ptsDiff(r.cells[last]?.change ?? null, totalChange)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted-foreground">
        ▲/▼ = change vs the month before{t.current && t.day ? `; ${monthLabel(t.current)} is compared with the same ${t.day} days of the previous month` : ""}.
        {t.adjusted && " Figures are scaled up for the few orders without picking detail (a feed gap is not a drop)."}
        {metric === "revenue" && " Revenue in SAR from picked items."}
      </p>
    </div>
  );
}

function MoverList({
  title,
  items,
  label,
  tone,
}: {
  title: string;
  items: Mover[];
  label: (dim: string) => ReactNode;
  tone: "up" | "down";
}) {
  const max = Math.max(1, ...items.map((m) => Math.abs(m.delta)));
  return (
    <div>
      <div className={cn("mb-1 text-xs font-semibold", tone === "up" ? "text-emerald-700" : "text-red-700")}>{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((m) => (
            <li key={m.dim} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-foreground">{label(m.dim)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {n0(m.before)} → {n0(m.now)}{" "}
                  <span className={tone === "up" ? "text-emerald-600" : "text-red-600"}>
                    ({m.delta > 0 ? "+" : ""}
                    {n0(m.delta)}
                    {m.change !== null ? `, ${m.change > 0 ? "+" : ""}${(m.change * 100).toFixed(0)}%` : ""})
                  </span>
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-muted">
                <div
                  className={cn("h-1 rounded", tone === "up" ? "bg-emerald-500" : "bg-red-500")}
                  style={{ width: `${(Math.abs(m.delta) / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Which departments and product groups pushed sales up or pulled them down between two months. */
export function MoversPanel({ rows, asOf, metric, pairKey }: { rows: InsightRow[]; asOf: string | null; metric: MomMetric; pairKey: "full" | "td" }) {
  const pairs = comparePairs(rows, "dept", asOf);
  const pair = pairs.find((p) => p.key === pairKey) ?? pairs[0];
  if (!pair) return <p className="text-sm text-muted-foreground">No data yet — re-run create_insights_view.sql in BigQuery and the n8n sync.</p>;
  const labels = groupLabels(rows);
  const dept = movers(rows, "dept", metric, pair, asOf);
  const grp = movers(rows, "group_monthly", metric, pair, asOf);
  const { day } = currentPeriod(asOf);
  const span = pair.partial && day ? ` 1–${day}` : "";
  const what = metric === "orders" ? "orders" : metric === "customers" ? "customers" : "revenue (SAR)";
  return (
    <div className="space-y-4">
      {dept.total && (
        <p className="text-sm text-foreground">
          All {what}: {monthLabel(pair.prev)}
          {span} <span className="tabular-nums">{n0(dept.total.before)}</span> → {monthLabel(pair.cur)}
          {span} <span className="tabular-nums">{n0(dept.total.now)}</span> <Delta value={dept.total.change} />
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Departments</div>
          <MoverList title="Pushing up" items={dept.up.slice(0, 6)} label={(d) => deptLabel(d)} tone="up" />
          <MoverList title="Pulling down" items={dept.down.slice(0, 6)} label={(d) => deptLabel(d)} tone="down" />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Product groups</div>
          <MoverList title="Pushing up" items={grp.up.slice(0, 8)} label={(d) => <GroupName code={d} labels={labels} />} tone="up" />
          <MoverList title="Pulling down" items={grp.down.slice(0, 8)} label={(d) => <GroupName code={d} labels={labels} />} tone="down" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Ranked by the change in {what}, not by %, so big everyday groups come before small ones that doubled. A product group = all brands and
        sizes of the same item (e.g. all 30-pc egg trays), so a switch from one SKU to another does not show as a collapse.
        {metric !== "revenue" && " An order with items from several departments counts in each of them."}
      </p>
    </div>
  );
}

export function PairsTable({ rows }: { rows: InsightRow[] }) {
  const byPair = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.grp !== "pair") continue;
    const rec = byPair.get(r.dim_value) ?? {};
    rec[r.metric] = r.value;
    byPair.set(r.dim_value, rec);
  }
  const list = [...byPair.entries()].map(([pair, m]) => ({ pair, orders: m.orders ?? 0, lift: m.lift ?? 0, share: m.together_share ?? 0 }))
    .sort((a, b) => b.lift - a.lift);
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No pair data yet — re-run create_insights_view.sql and the sync.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Products bought together</th>
            <th className="px-2 py-1.5 text-right font-medium">Orders with both</th>
            <th className="px-2 py-1.5 text-right font-medium">Likelihood vs chance</th>
            <th className="px-2 py-1.5 text-right font-medium">Share of the smaller one&rsquo;s orders</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.pair} className="border-t border-border">
              <td className="px-2 py-1.5 text-foreground">{p.pair}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{n0(p.orders)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.lift.toFixed(1)}×</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{pct(p.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted-foreground">Last 180 days of picking data. Useful for bundles, shelf placement and the Cross-sell campaign.</p>
    </div>
  );
}
