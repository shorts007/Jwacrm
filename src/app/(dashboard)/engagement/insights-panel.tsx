"use client";

// Breakdown tables for the synced customer base (channel, store, price behaviour,
// segment). Data comes from the lulu_engagement_breakdown() RPC (RLS applies).

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Row {
  dimension: "channel" | "store" | "price" | "segment";
  value: string;
  customers: number;
  sales: number | string;
  discount: number | string;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

const TITLES: Record<Row["dimension"], { title: string; hint: string }> = {
  channel: { title: "By channel", hint: "Most-used ordering channel (ios / android / default)." },
  store: { title: "By store", hint: "Each customer's most-used store." },
  price: { title: "By price behaviour", hint: "Offer-driven: ≥70% of orders discounted · Full-price: ≤20%." },
  segment: { title: "By RFM segment", hint: "Descriptive segment from recency, frequency, spend." },
};

export function InsightsPanel({ accountId, refreshKey }: { accountId: string; refreshKey: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createClient()
      .rpc("lulu_engagement_breakdown", { p_account: accountId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(/lulu_engagement_breakdown/.test(err.message) ? "Run migration 048 in Supabase to enable insights." : err.message);
        else {
          setError(null);
          setRows((data ?? []) as Row[]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, refreshKey]);

  if (error) return <p className="text-xs text-muted-foreground">{error}</p>;
  if (!rows || rows.length === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(Object.keys(TITLES) as Row["dimension"][]).map((dim) => {
        const list = rows
          .filter((r) => r.dimension === dim)
          .sort((a, b) => b.customers - a.customers)
          .slice(0, 12);
        const total = list.reduce((a, r) => a + Number(r.customers), 0) || 1;
        return (
          <div key={dim} className="rounded-xl border border-border bg-card">
            <div className="border-b border-border p-3">
              <h2 className="text-sm font-semibold text-foreground">{TITLES[dim].title}</h2>
              <p className="text-xs text-muted-foreground">{TITLES[dim].hint}</p>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{dim === "store" ? "Store" : "Group"}</th>
                  <th className="px-3 py-1.5 font-medium">Customers</th>
                  <th className="px-3 py-1.5 font-medium">Share</th>
                  <th className="px-3 py-1.5 font-medium">Sales (SAR)</th>
                  <th className="px-3 py-1.5 font-medium">Discounts (SAR)</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.value} className="border-t border-border">
                    <td className="px-3 py-1.5 text-foreground">{r.value}</td>
                    <td className="px-3 py-1.5 tabular-nums">{fmt(Number(r.customers))}</td>
                    <td className="px-3 py-1.5 tabular-nums">{Math.round((Number(r.customers) / total) * 100)}%</td>
                    <td className="px-3 py-1.5 tabular-nums">{fmt(Number(r.sales))}</td>
                    <td className="px-3 py-1.5 tabular-nums">{fmt(Number(r.discount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
