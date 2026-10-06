"use client";

// Customer 360 (PRD §61): profile, buying pattern, preferences, every LuLu message with its
// outcome, attributed orders, and what the engine would do next — and why.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { loadCustomer360, type Customer360 } from "@/lib/lulu/customer360";

const n0 = (v: number | string | null | undefined) => (v == null ? "—" : Math.round(Number(v)).toLocaleString("en-US"));
const pct = (v: number | string | null | undefined) => (v == null ? "—" : `${Math.round(Number(v) * 100)}%`);
const REASONS: Record<string, string> = {
  opted_out: "opted out", suspected_shared_number: "suspected shared number", active_complaint: "open complaint",
  ordered_recently: "ordered in the last 24 h", already_received_campaign: "already received this campaign",
  marketing_frequency_cap: "marketing frequency limit", promo_frequency_cap: "promo frequency limit", lower_priority: "a higher-priority campaign wins",
};

export default function Customer360Page() {
  const { phone } = useParams<{ phone: string }>();
  const { accountId } = useAuth();
  const digits = String(phone ?? "").replace(/\D/g, "");
  const [d, setD] = useState<Customer360 | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId || !digits) return;
    let cancelled = false;
    const db = createClient();
    loadCustomer360(db, accountId, digits)
      .then((x) => !cancelled && setD(x))
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : "Failed to load"));
    void db
      .from("contacts")
      .select("id, conversations(id)")
      .eq("account_id", accountId)
      .eq("phone_normalized", digits)
      .maybeSingle()
      .then(({ data }) => {
        const conv = (data as { conversations?: { id: string }[] } | null)?.conversations?.[0]?.id ?? null;
        if (!cancelled) setConversationId(conv);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, digits]);

  const p = d?.profile;
  const card = "rounded-xl border border-border bg-card p-4";
  const kv = (k: string, v: React.ReactNode) => (
    <div key={k} className="flex justify-between gap-3 border-b border-border/60 py-1 text-sm last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right text-foreground">{v}</span>
    </div>
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Link href="/engagement/customers" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Customers
      </Link>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {!d ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted/50" />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-foreground">{p?.name ?? `+${digits}`}</h1>
              <p className="text-sm text-muted-foreground">
                +{digits} · {d.stage ?? "not in customer base"}
                {p?.vip_flag ? " · VIP" : ""}
                {p?.customer_segment ? ` · ${p.customer_segment}` : ""}
                {d.optedOut ? " · OPTED OUT" : ""}
              </p>
            </div>
            {conversationId && (
              <Link href={`/inbox?c=${conversationId}`} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
                <MessageSquare className="h-4 w-4" /> Open chat
              </Link>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className={card}>
              <h2 className="mb-2 text-sm font-semibold">Buying pattern</h2>
              {p ? [
                kv("First order (in data)", p.first_order_date ?? "—"),
                kv("Last order", p.last_order_date ? `${p.last_order_date} · ${d.daysSinceOrder} days ago` : "—"),
                kv("Orders", `${n0(p.total_orders)} (30 d: ${p.orders_30d ?? 0}, 90 d: ${p.orders_90d ?? 0})`),
                kv("Lifetime spend", `SAR ${n0(p.total_sales)}`),
                kv("Average basket", `SAR ${n0(p.average_order_value)}`),
                kv("Usually orders every", p.median_interval_days != null ? `${n0(p.median_interval_days)} days (± ${n0(p.stddev_interval_days)})` : "not enough orders"),
                kv("Next order expected", d.nextExpectedOrder ?? "—"),
                kv("RFM (recency / frequency / spend)", `${p.rfm_recency ?? "—"} / ${p.rfm_frequency ?? "—"} / ${p.rfm_monetary ?? "—"}`),
              ] : <p className="text-sm text-muted-foreground">No synced orders for this number.</p>}
            </div>
            <div className={card}>
              <h2 className="mb-2 text-sm font-semibold">Preferences</h2>
              {p && [
                kv("Store", p.preferred_store ?? "—"),
                kv("Stores used", n0(p.stores_used)),
                kv("Channel", p.preferred_channel ?? "—"),
                kv("Top department code", p.preferred_category ?? "—"),
                kv("Discount behaviour", p.price_sensitivity ?? "not enough data"),
                kv("Orders with a discount", pct(p.discount_order_share)),
                kv("Discounts received", `SAR ${n0(p.total_discount)}`),
              ]}
              {kv("Message language", d.languagePref ? (d.languagePref === "en" ? "English (chosen)" : "Arabic (chosen)") : "not chosen — gets both")}
              {kv("Marketing messages", d.optedOut ? `opted out ${new Date(d.optedOut.at).toLocaleDateString()} (${d.optedOut.keyword ?? "STOP"})` : "allowed")}
            </div>
            <div className={card}>
              <h2 className="mb-2 text-sm font-semibold">Next best action</h2>
              {d.next ? (
                <p className="text-sm">
                  <b>{d.next.campaign}</b> — {d.next.reason}
                  <span className="block text-xs text-muted-foreground">{d.next.live ? "Among LIVE campaigns" : "Dry-run view (no campaign is LIVE)"}</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No campaign would message this customer today.</p>
              )}
              {d.nextSkipped.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {d.nextSkipped.map((s, i) => (
                    <li key={i}>{s.campaign}: {REASONS[s.reason] ?? s.reason.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className={card}>
            <h2 className="mb-2 text-sm font-semibold">Usual items &amp; restock timing</h2>
            {d.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repeat products found (needs 2+ purchases of a replenishable item in the picking data, Apr 2026+).</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 font-medium">Product</th>
                    <th className="px-2 py-1 text-right font-medium">Times bought</th>
                    <th className="px-2 py-1 font-medium">Last bought</th>
                    <th className="px-2 py-1 text-right font-medium">Usually every</th>
                    <th className="px-2 py-1 font-medium">Restock</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.name} className="border-t border-border">
                      <td className="px-2 py-1">{i.name}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{i.times}</td>
                      <td className="px-2 py-1 text-xs">{i.last}</td>
                      <td className="px-2 py-1 text-right text-xs">{i.every} days</td>
                      <td className={`px-2 py-1 text-xs ${i.status === "due" ? "text-emerald-600" : i.status === "overdue" ? "text-amber-600" : "text-muted-foreground"}`}>
                        {i.status === "ok" ? `in ${i.dueInDays} days` : i.status === "due" ? "due now" : i.status === "overdue" ? `overdue ${-i.dueInDays} days` : "habit lapsed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className={card}>
            <h2 className="mb-2 text-sm font-semibold">LuLu messages &amp; results</h2>
            {d.touches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No campaign messages yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 font-medium">Date</th>
                      <th className="px-2 py-1 font-medium">Campaign</th>
                      <th className="px-2 py-1 font-medium">Status</th>
                      <th className="px-2 py-1 font-medium">Outcome</th>
                      <th className="px-2 py-1 font-medium">Offer</th>
                      <th className="px-2 py-1 font-medium">Orders after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.touches.map((t) => (
                      <tr key={t.id} className="border-t border-border align-top">
                        <td className="px-2 py-1 text-xs text-muted-foreground">{new Date(t.sentAt ?? t.createdAt).toLocaleString()}</td>
                        <td className="px-2 py-1">{t.campaignName}</td>
                        <td className="px-2 py-1 text-xs">
                          {t.status === "SKIPPED" && t.skipReason === "holdout" ? "control group (not sent)" : t.status}
                          {t.skipReason && t.skipReason !== "holdout" && <span className="block text-muted-foreground">{REASONS[t.skipReason] ?? t.skipReason}</span>}
                          {t.lastError && <span className="block text-destructive">{t.lastError}</span>}
                        </td>
                        <td className="px-2 py-1 text-xs">{t.status === "SENT" ? [t.delivered && "delivered", t.read && "read", t.replied && "replied"].filter(Boolean).join(" · ") || "sent" : ""}</td>
                        <td className="px-2 py-1 text-xs">{t.offer ? `${t.offer.code} — ${t.offer.text} (until ${t.offer.validUntil})` : ""}</td>
                        <td className="px-2 py-1 text-xs">{t.orders.map((o) => `SAR ${n0(o.value)} on ${new Date(o.at).toLocaleDateString()}`).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
