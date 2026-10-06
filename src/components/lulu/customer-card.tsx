"use client";

// Compact LuLu Customer 360 card for the WACRM inbox sidebar (PRD §61):
// who this customer is, how they buy, and which campaign / offer they last received.

import { useEffect, useState } from "react";
import Link from "next/link";
import { BellOff, Crown, ExternalLink, Gift } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { loadCustomer360, type Customer360 } from "@/lib/lulu/customer360";

const STAGE_LABEL: Record<string, string> = {
  NEW: "New", FIRST_ORDER: "First order", ACTIVE: "Active", AT_RISK: "At risk", DORMANT: "Dormant", LOST: "Lost",
};
const n0 = (v: number | string | null | undefined) => Math.round(Number(v ?? 0)).toLocaleString("en-US");

export function CustomerCard({ phone }: { phone: string | null | undefined }) {
  const { accountId } = useAuth();
  const digits = (phone ?? "").replace(/\D/g, "");
  const [data, setData] = useState<Customer360 | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!accountId || digits.length < 8) return;
    let cancelled = false;
    loadCustomer360(createClient(), accountId, digits)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [accountId, digits]);

  if (!digits || failed) return null;
  if (!data) return <div className="mt-4 h-24 animate-pulse rounded-lg bg-muted/50" />;

  const p = data.profile;
  const last = data.touches.find((t) => t.status === "SENT");
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right text-foreground">{v}</span>
    </div>
  );

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">Customer 360</span>
        <Link href={`/engagement/customers/${digits}`} className="inline-flex items-center gap-1 text-primary hover:underline">
          Full profile <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {data.optedOut && (
        <div className="flex items-center gap-1 rounded bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-400">
          <BellOff className="h-3 w-3" /> Opted out of offers ({new Date(data.optedOut.at).toLocaleDateString()})
        </div>
      )}

      {!p ? (
        <p className="text-muted-foreground">Not in the synced customer base (no delivered orders in the focus stores).</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            <span className="rounded-full bg-muted px-2 py-0.5">{STAGE_LABEL[data.stage ?? ""] ?? data.stage}</span>
            {p.vip_flag && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                <Crown className="h-3 w-3" /> VIP
              </span>
            )}
            {p.customer_segment && <span className="rounded-full bg-muted px-2 py-0.5">{p.customer_segment}</span>}
            {p.suspect_reason && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-600">Shared number?</span>}
          </div>
          {row("Last order", p.last_order_date ? `${p.last_order_date} (${data.daysSinceOrder} d ago)` : "—")}
          {row("Orders / spend", `${n0(p.total_orders)} · SAR ${n0(p.total_sales)}`)}
          {row("Avg basket", `SAR ${n0(p.average_order_value)}`)}
          {p.median_interval_days != null && row("Usually orders every", `${n0(p.median_interval_days)} days`)}
          {p.preferred_store && row("Store", p.preferred_store)}
          {p.preferred_channel && row("Channel", p.preferred_channel)}
          {p.price_sensitivity && row("Discounts", p.price_sensitivity)}
          {row("Language", data.languagePref ? (data.languagePref === "en" ? "English (chosen)" : "Arabic (chosen)") : "not chosen (gets both)")}
        </>
      )}

      {last && (
        <div className="space-y-0.5 border-t border-border pt-2">
          <div className="text-muted-foreground">Last LuLu message</div>
          <div className="text-foreground">
            {last.campaignName} · {last.sentAt ? new Date(last.sentAt).toLocaleDateString() : ""} ·{" "}
            {last.read ? "read" : last.delivered ? "delivered" : "sent"}
            {last.orders.length > 0 && ` · ordered SAR ${n0(last.orders.reduce((a, o) => a + o.value, 0))}`}
          </div>
          {last.offer && (
            <div className="flex items-start gap-1 text-foreground">
              <Gift className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Offer <b>{last.offer.code}</b>: {last.offer.text} — valid until {last.offer.validUntil}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
