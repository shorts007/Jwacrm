"use client";

// Customer Insights — trends and behaviour of the Jeddah customer base.
// Trend data: pre-aggregated BigQuery snapshot (lulu_insights_snapshot, synced by n8n).
// "Customer base today": live counts from lulu_customer_profiles (active, non-suspect).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { comparePairs, currentPeriod, type InsightRow, type MomMetric } from "@/lib/lulu/insights";
import {
  CohortHeatmap,
  DIM_METRIC_LABEL,
  DimMonthly,
  GroupName,
  MOM_METRIC_OPTIONS,
  MomTable,
  MoversPanel,
  Toggle,
  deptLabel,
  groupLabels,
  DowHourHeatmap,
  PairsTable,
  FrequencyTable,
  MonthKpis,
  ProductsTable,
  RateBlocks,
  Section,
  TrendCharts,
  n0,
  pct,
  storeLabel,
  type DimMetric,
} from "./sections";

interface Snapshot {
  rows: InsightRow[];
  data_as_of: string | null;
  synced_at: string;
}

interface BaseCounts {
  total: number;
  active: number;
  newFirst: number;
  atRisk: number;
  dormant: number;
  lost: number;
  vip: number;
  offerDriven: number;
  fullPrice: number;
  optedOut: number;
}

const monthName = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
};

const CHANNEL_LABEL: Record<string, string> = { ios: "iOS app", android: "Android app", website: "Website", unknown: "Unknown" };
const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

function MetricPicker({ value, onChange }: { value: DimMetric; onChange: (m: DimMetric) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
      {(Object.keys(DIM_METRIC_LABEL) as DimMetric[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`rounded-md px-2 py-1 text-xs ${value === m ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          {DIM_METRIC_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

export default function CustomerInsightsPage() {
  const { accountId } = useAuth();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [counts, setCounts] = useState<BaseCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storeMetric, setStoreMetric] = useState<DimMetric>("orders");
  const [channelMetric, setChannelMetric] = useState<DimMetric>("revenue");
  const [rankBy, setRankBy] = useState<"revenue" | "customers">("customers");
  const [moverMetric, setMoverMetric] = useState<MomMetric>("orders");
  const [moverPair, setMoverPair] = useState<"full" | "td">("full");
  const [prodView, setProdView] = useState<"monthly" | "last90">("monthly");
  const [prodLevel, setProdLevel] = useState<"group_monthly" | "product_monthly">("group_monthly");
  const [prodMetric, setProdMetric] = useState<MomMetric>("orders");
  const [prodFilter, setProdFilter] = useState<"all" | "growing" | "falling">("all");
  const [deptMetric, setDeptMetric] = useState<MomMetric>("orders");

  useEffect(() => {
    if (!accountId) return;
    const db = createClient();
    const base = () =>
      db
        .from("lulu_customer_profiles")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId)
        .eq("active", true)
        .is("suspect_reason", null);

    void Promise.all([
      db.from("lulu_insights_snapshot").select("rows, data_as_of, synced_at").eq("account_id", accountId).maybeSingle(),
      base(),
      base().eq("lifecycle_stage", "ACTIVE"),
      base().in("lifecycle_stage", ["NEW", "FIRST_ORDER"]),
      base().eq("lifecycle_stage", "AT_RISK"),
      base().eq("lifecycle_stage", "DORMANT"),
      base().eq("lifecycle_stage", "LOST"),
      base().eq("vip_flag", true),
      base().eq("price_sensitivity", "Offer-driven"),
      base().eq("price_sensitivity", "Full-price"),
      db.from("lulu_opt_outs").select("phone_digits", { count: "exact", head: true }).eq("account_id", accountId),
    ]).then(([s, total, active, newFirst, atRisk, dormant, lost, vip, offer, full, opt]) => {
      if (s.error) {
        setError(/lulu_insights_snapshot/.test(s.error.message) ? "Run migration 050 in Supabase to enable this page." : s.error.message);
      } else {
        setSnap((s.data as Snapshot | null) ?? null);
      }
      setCounts({
        total: total.count ?? 0,
        active: active.count ?? 0,
        newFirst: newFirst.count ?? 0,
        atRisk: atRisk.count ?? 0,
        dormant: dormant.count ?? 0,
        lost: lost.count ?? 0,
        vip: vip.count ?? 0,
        offerDriven: offer.count ?? 0,
        fullPrice: full.count ?? 0,
        optedOut: opt.error ? 0 : (opt.count ?? 0),
      });
      setLoaded(true);
    });
  }, [accountId]);

  const rows = snap?.rows ?? [];
  const asOf = snap?.data_as_of ?? null;
  const share = (n: number) => (counts && counts.total ? pct(n / counts.total) : "—");
  const labels = groupLabels(rows);
  const { day } = currentPeriod(asOf);
  const pairOptions: ["full" | "td", string][] = comparePairs(rows, "dept", asOf).map((p) => [
    p.key,
    p.partial
      ? `${monthName(p.cur)} 1–${day ?? ""} vs ${monthName(p.prev)} 1–${day ?? ""}`
      : `${monthName(p.cur)} vs ${monthName(p.prev)}`,
  ]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Customer Insights</h1>
        <p className="text-sm text-muted-foreground">
          How Jeddah customers buy, stay and leave — month by month.{" "}
          {asOf && `Order data up to ${new Date(asOf).toLocaleString()}.`}{" "}
          {snap?.synced_at && `Snapshot refreshed ${new Date(snap.synced_at).toLocaleString()}.`} Suspected shared numbers are excluded.
        </p>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {counts && (
        <Section title="Customer base today" hint="Live from the synced customer profiles (active, genuine customers).">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ["Customers", counts.total],
              ["Active", counts.active],
              ["New / first order", counts.newFirst],
              ["At risk", counts.atRisk],
              ["Dormant", counts.dormant],
              ["Lost", counts.lost],
              ["VIP", counts.vip],
              ["Discount-driven", counts.offerDriven],
              ["Full-price buyers", counts.fullPrice],
              ["Opted out of messages", counts.optedOut],
            ].map(([label, v]) => (
              <div key={label as string} className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{n0(v as number)}</div>
                <div className="text-xs text-muted-foreground">{label === "Customers" ? "" : share(v as number)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {loaded && !error && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          No insights snapshot yet. In BigQuery run <code>docs/lulu/bigquery/create_insights_view.sql</code>, then run the n8n
          workflow — its &ldquo;Insights&rdquo; branch fills this page.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <Section title="This month vs last month">
            <MonthKpis rows={rows} asOf={asOf} />
          </Section>

          <Section title="Month-on-month trend" hint="Revenue & orders, new vs repeat customers, and how much of it is driven by discounts.">
            <TrendCharts rows={rows} />
          </Section>

          <Section
            title="Stores — month-on-month"
            hint="Which stores are growing or shrinking. Store = the store that fulfilled the order."
            right={<MetricPicker value={storeMetric} onChange={setStoreMetric} />}
          >
            <DimMonthly rows={rows} grp="store_monthly" metric={storeMetric} label={storeLabel} asOf={asOf} />
          </Section>

          <Section
            title="Channels — iOS, Android, website"
            hint="Which ordering channel brings the most customers and value."
            right={<MetricPicker value={channelMetric} onChange={setChannelMetric} />}
          >
            <DimMonthly rows={rows} grp="channel_monthly" metric={channelMetric} label={channelLabel} asOf={asOf} />
          </Section>

          <Section
            title="Why customers come back — or don't"
            hint="Share of orders followed by another order within 30 days, split by what happened on that order."
          >
            <RateBlocks
              rows={rows}
              grp="return30"
              num="returned"
              den="orders"
              denLabel="orders"
              dims={["fulfilment", "discounted", "basket", "order_number", "channel", "store"]}
              label={(d, v) => (d === "store" ? storeLabel(v) : d === "channel" ? channelLabel(v) : d === "basket" ? v.replace(/^\d: /, "") : v)}
            />
          </Section>

          <Section
            title="Turning new customers into repeat customers"
            hint="Share of new customers who placed a 2nd order within 60 days, by how their FIRST order went."
          >
            <RateBlocks
              rows={rows}
              grp="first_order"
              num="second_order_60d"
              den="customers"
              denLabel="new customers"
              dims={["fulfilment", "discounted", "channel", "store"]}
              label={(d, v) => (d === "store" ? storeLabel(v) : d === "channel" ? channelLabel(v) : v)}
            />
          </Section>

          <Section title="Retention by first-order month" hint="How many new customers are still ordering 1, 2, 3… months later.">
            <CohortHeatmap rows={rows} asOf={asOf} />
          </Section>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="When customers order">
              <DowHourHeatmap rows={rows} />
            </Section>
            <Section title="How often customers order" hint="Customers and revenue by lifetime number of orders.">
              <FrequencyTable rows={rows} />
            </Section>
          </div>

          <Section
            title="What moved sales"
            hint="Departments and product groups that pushed sales up or pulled them down compared with the month before."
            right={
              <div className="flex flex-wrap gap-2">
                {pairOptions.length > 1 && <Toggle value={moverPair} options={pairOptions} onChange={setMoverPair} />}
                <Toggle value={moverMetric} options={MOM_METRIC_OPTIONS} onChange={setMoverMetric} />
              </div>
            }
          >
            <MoversPanel rows={rows} asOf={asOf} metric={moverMetric} pairKey={moverPair} />
          </Section>

          <Section
            title="Products driving sales"
            hint={
              prodView === "monthly"
                ? "Month by month, with the change vs the month before. Product groups add up all brands and sizes of the same item, so a SKU switch doesn't look like a collapse."
                : "Top products in the last 90 days of picking data vs the 90 days before (scaled to a full 90 days where picking data was shorter). 'Customers' shows everyday drivers; 'Revenue' is pulled up by one-off electronics."
            }
            right={
              <div className="flex flex-wrap gap-2">
                <Toggle
                  value={prodView}
                  options={[
                    ["monthly", "Month by month"],
                    ["last90", "Last 90 days"],
                  ]}
                  onChange={setProdView}
                />
                {prodView === "monthly" ? (
                  <>
                    <Toggle
                      value={prodLevel}
                      options={[
                        ["group_monthly", "Product groups"],
                        ["product_monthly", "Single products"],
                      ]}
                      onChange={setProdLevel}
                    />
                    <Toggle value={prodMetric} options={MOM_METRIC_OPTIONS} onChange={setProdMetric} />
                    <Toggle
                      value={prodFilter}
                      options={[
                        ["all", "Top"],
                        ["growing", "Growing"],
                        ["falling", "Falling"],
                      ]}
                      onChange={setProdFilter}
                    />
                  </>
                ) : (
                  <Toggle
                    value={rankBy}
                    options={[
                      ["customers", "Rank by customers"],
                      ["revenue", "Rank by revenue"],
                    ]}
                    onChange={setRankBy}
                  />
                )}
              </div>
            }
          >
            {prodView === "monthly" ? (
              <MomTable
                key={prodLevel}
                rows={rows}
                grp={prodLevel}
                metric={prodMetric}
                asOf={asOf}
                filter={prodFilter}
                limit={30}
                label={(d) => (prodLevel === "group_monthly" ? <GroupName code={d} labels={labels} /> : d)}
              />
            ) : (
              <ProductsTable rows={rows} rankBy={rankBy} />
            )}
          </Section>

          <Section title="Frequently bought together" hint="Product pairs that land in the same basket far more often than chance.">
            <PairsTable rows={rows} />
          </Section>

          <Section
            title="Departments month-on-month"
            hint="Each month with its change vs the month before. 'vs all orders' shows whether a department is doing better or worse than the business overall."
            right={<Toggle value={deptMetric} options={MOM_METRIC_OPTIONS} onChange={setDeptMetric} />}
          >
            <MomTable
              rows={rows}
              grp="dept"
              metric={deptMetric}
              asOf={asOf}
              limit={25}
              label={(d) => (
                <>
                  {deptLabel(d)} <span className="text-xs text-muted-foreground">{d}</span>
                </>
              )}
            />
          </Section>
        </>
      )}
    </div>
  );
}
