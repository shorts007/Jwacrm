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
  dimMonthTable,
  dowHourGrid,
  monthlySeries,
  pctChange,
  rateTable,
  type InsightRow,
  type MonthPoint,
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
        {mtd && ` ${monthLabel(mtd.month)} so far: ${n0(mtd.orders)} orders, ${sar(mtd.revenue)}.`}
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
  months = 6,
}: {
  rows: InsightRow[];
  grp: "store_monthly" | "channel_monthly";
  metric: DimMetric;
  label: (d: string) => string;
  months?: number;
}) {
  const { months: ms, table } = dimMonthTable(rows, grp, metric, months);
  if (table.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  const lastIdx = ms.length - 1;
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
                <th key={m} className="px-2 py-1.5 text-right font-medium">{monthLabel(m)}</th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium">Share (latest)</th>
              <th className="px-2 py-1.5 text-right font-medium">MoM</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.dim} className="border-t border-border">
                <td className="px-2 py-1.5 text-foreground">{label(r.dim)}</td>
                {r.values.map((v, i) => (
                  <td key={i} className="px-2 py-1.5 text-right tabular-nums">{n0(v)}</td>
                ))}
                <td className="px-2 py-1.5 text-right tabular-nums">{pct((r.values[lastIdx] ?? 0) / total)}</td>
                <td className="px-2 py-1.5 text-right">
                  <Delta value={lastIdx > 0 ? pctChange(r.values[lastIdx] ?? 0, r.values[lastIdx - 1] ?? 0) : null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-muted-foreground">The latest column may be a partial month (data up to the as-of date).</p>
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

export function CohortHeatmap({ rows }: { rows: InsightRow[] }) {
  const m = cohortMatrix(rows);
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

export function ProductsTable({ rows }: { rows: InsightRow[] }) {
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
    .sort((a, b) => b.revenue - a.revenue);
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

export function DeptTable({ rows }: { rows: InsightRow[] }) {
  const months = [...new Set(rows.filter((r) => r.grp === "dept").map((r) => r.period))].sort().slice(-6);
  const depts = new Map<string, number[]>();
  for (const r of rows) {
    if (r.grp !== "dept" || !months.includes(r.period)) continue;
    const arr = depts.get(r.dim_value) ?? Array(months.length).fill(0);
    arr[months.indexOf(r.period)] = r.value;
    depts.set(r.dim_value, arr);
  }
  const list = [...depts.entries()].sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0)).slice(0, 15);
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No department data.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Department code</th>
            {months.map((m) => (
              <th key={m} className="px-2 py-1.5 text-right font-medium">{monthLabel(m)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map(([dept, vals]) => (
            <tr key={dept} className="border-t border-border">
              <td className="px-2 py-1.5 text-foreground">{dept}</td>
              {vals.map((v, i) => (
                <td key={i} className="px-2 py-1.5 text-right tabular-nums">{n0(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted-foreground">Revenue in SAR from picking data. Codes need a code → name list to show department names.</p>
    </div>
  );
}
