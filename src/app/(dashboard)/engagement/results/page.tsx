"use client";

// Campaign results (PRD §58-60): funnel, attributed orders & revenue, and the
// comparison with each campaign's holdout (control) group to estimate real lift.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Info } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { lift } from "@/lib/lulu/attribution";

interface ResultRow {
  campaign_id: string;
  sent: number;
  failed: number;
  queued: number;
  skipped: number;
  holdout: number;
  delivered: number;
  read: number;
  replied: number;
  converted: number;
  orders: number;
  revenue: number | string;
  discount_cost: number | string;
  control_converted: number;
}

interface CampaignMeta {
  id: string;
  name: string;
  campaign_code: string;
  mode: string;
  holdout_pct: number | string;
  attribution_days: number;
}

const PERIODS = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: 3650 },
] as const;

const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const pct = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
const ratio = (a: number, b: number) => (b ? a / b : null);

export default function CampaignResultsPage() {
  const { accountId } = useAuth();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("30");
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [meta, setMeta] = useState<CampaignMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const days = PERIODS.find((p) => p.key === period)!.days;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const db = createClient();
    const [r, c] = await Promise.all([
      db.rpc("lulu_campaign_results", { p_account: accountId, p_since: since }),
      db.from("lulu_campaigns").select("id, name, campaign_code, mode, holdout_pct, attribution_days").eq("account_id", accountId).order("priority"),
    ]);
    if (r.error) setError(/lulu_campaign_results|holdout_pct/.test(r.error.message) ? "Run migration 055 in Supabase." : r.error.message);
    else {
      setError(null);
      setRows((r.data ?? []) as ResultRow[]);
    }
    setMeta((c.data ?? []) as CampaignMeta[]);
  }, [accountId, period]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const saveSetting = async (id: string, patch: Partial<Pick<CampaignMeta, "holdout_pct" | "attribution_days">>) => {
    const { error: e } = await createClient().from("lulu_campaigns").update(patch).eq("id", id);
    setMsg(e ? e.message : "Saved — applies to new sends.");
    await load();
  };

  const byId = new Map(rows.map((r) => [r.campaign_id, r]));
  const list = meta
    .map((m) => ({ m, r: byId.get(m.id) }))
    .filter(({ m, r }) => r || m.mode === "LIVE");
  const tot = rows.reduce(
    (a, r) => ({
      sent: a.sent + r.sent,
      delivered: a.delivered + r.delivered,
      read: a.read + r.read,
      replied: a.replied + r.replied,
      converted: a.converted + r.converted,
      orders: a.orders + Number(r.orders),
      revenue: a.revenue + Number(r.revenue),
      discount: a.discount + Number(r.discount_cost),
      holdout: a.holdout + r.holdout,
      control: a.control + r.control_converted,
    }),
    { sent: 0, delivered: 0, read: 0, replied: 0, converted: 0, orders: 0, revenue: 0, discount: 0, holdout: 0, control: 0 },
  );
  const totLift = lift(tot.sent, tot.converted, tot.holdout, tot.control);

  const th = "px-2 py-1.5 text-right font-medium";
  const td = "px-2 py-1.5 text-right tabular-nums";

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement/campaigns" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Campaign results</h1>
            <p className="text-sm text-muted-foreground">
              What the messages achieved: delivery, reads, replies, orders and revenue — and how that compares with similar customers
              who were deliberately not messaged.
            </p>
          </div>
          <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.key)}
                className={`rounded-md px-2 py-1 text-xs ${period === p.key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {[
          ["Messages sent", n0(tot.sent)],
          ["Delivered", pct(ratio(tot.delivered, tot.sent))],
          ["Read", pct(ratio(tot.read, tot.sent))],
          ["Replied", pct(ratio(tot.replied, tot.sent))],
          ["Ordered after message", pct(totLift.conversion)],
          ["Attributed revenue", `SAR ${n0(tot.revenue)}`],
          ["Control group ordered", pct(totLift.controlConversion)],
          ["Est. extra customers", totLift.incrementalCustomers === null ? "—" : n0(totLift.incrementalCustomers)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Campaign</th>
              <th className={th}>Sent</th>
              <th className={th}>Delivered</th>
              <th className={th}>Read</th>
              <th className={th}>Replied</th>
              <th className={th}>Ordered</th>
              <th className={th}>Orders</th>
              <th className={th}>Revenue</th>
              <th className={th}>Discounts</th>
              <th className={th}>Rev / message</th>
              <th className={th}>Control (n)</th>
              <th className={th}>Control ordered</th>
              <th className={th}>Lift</th>
              <th className={th}>Holdout %</th>
              <th className={th}>Window (days)</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={15} className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No live sends in this period yet.
                </td>
              </tr>
            )}
            {list.map(({ m, r }) => {
              const sent = r?.sent ?? 0;
              const l = lift(sent, r?.converted ?? 0, r?.holdout ?? 0, r?.control_converted ?? 0);
              return (
                <tr key={m.id} className="border-t border-border">
                  <td className="px-2 py-1.5 text-foreground">
                    {m.name}
                    {m.mode === "LIVE" && <span className="ms-1 text-xs text-emerald-600">LIVE</span>}
                  </td>
                  <td className={td}>{n0(sent)}</td>
                  <td className={td}>{pct(ratio(r?.delivered ?? 0, sent))}</td>
                  <td className={td}>{pct(ratio(r?.read ?? 0, sent))}</td>
                  <td className={td}>{pct(ratio(r?.replied ?? 0, sent))}</td>
                  <td className={td}>{pct(l.conversion)} <span className="text-xs text-muted-foreground">({n0(r?.converted ?? 0)})</span></td>
                  <td className={td}>{n0(Number(r?.orders ?? 0))}</td>
                  <td className={td}>{n0(Number(r?.revenue ?? 0))}</td>
                  <td className={td}>{n0(Number(r?.discount_cost ?? 0))}</td>
                  <td className={td}>{sent ? n0(Number(r?.revenue ?? 0) / sent) : "—"}</td>
                  <td className={td}>{n0(r?.holdout ?? 0)}</td>
                  <td className={td}>{pct(l.controlConversion)}</td>
                  <td className={td} title={l.reliable ? "" : "Too few customers yet — early estimate"}>
                    {l.liftPoints === null ? "—" : `${l.liftPoints >= 0 ? "+" : ""}${(l.liftPoints * 100).toFixed(1)} pts`}
                    {!l.reliable && l.liftPoints !== null && <span className="text-xs text-amber-600"> *</span>}
                  </td>
                  <td className={td}>
                    <input
                      type="number" min={0} max={50} step={1} defaultValue={Number(m.holdout_pct)}
                      className="w-14 rounded border border-border bg-background px-1 text-right"
                      onBlur={(e) => Number(e.target.value) !== Number(m.holdout_pct) && void saveSetting(m.id, { holdout_pct: Math.min(50, Math.max(0, Number(e.target.value) || 0)) })}
                    />
                  </td>
                  <td className={td}>
                    <input
                      type="number" min={1} max={30} defaultValue={m.attribution_days}
                      className="w-12 rounded border border-border bg-background px-1 text-right"
                      onBlur={(e) => Number(e.target.value) !== m.attribution_days && void saveSetting(m.id, { attribution_days: Math.min(30, Math.max(1, Number(e.target.value) || 7)) })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

      <div className="flex gap-2 rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p>
            <b className="text-foreground">Ordered / revenue</b>: orders placed within the campaign&rsquo;s window (default 7 days) after the message,
            credited to the most recent message (filled daily from BigQuery by the n8n sync).
          </p>
          <p>
            <b className="text-foreground">Control group</b>: a fixed share of eligible customers (holdout %, default 10%) is deliberately not
            messaged. Many customers would have ordered anyway; <b className="text-foreground">Lift</b> = ordered rate of messaged customers minus
            the control group&rsquo;s rate — the part the message actually caused. * = fewer than 100 control / 300 messaged customers, so
            treat it as an early estimate.
          </p>
        </div>
      </div>
    </div>
  );
}
