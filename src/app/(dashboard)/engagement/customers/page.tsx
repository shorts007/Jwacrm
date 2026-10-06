"use client";

// Customer search → Customer 360.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

interface Hit {
  customer_id: string;
  mobile: string;
  name: string | null;
  lifecycle_stage: string | null;
  total_orders: number;
  total_sales: number | string;
  last_order_date: string | null;
  vip_flag: boolean;
}

const STAGES = ["", "ACTIVE", "FIRST_ORDER", "AT_RISK", "DORMANT", "LOST", "NEW"];

export default function CustomersPage() {
  const { accountId } = useAuth();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [vip, setVip] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      let query = createClient()
        .from("lulu_customer_profiles")
        .select("customer_id, mobile, name, lifecycle_stage, total_orders, total_sales, last_order_date, vip_flag")
        .eq("account_id", accountId)
        .eq("active", true)
        .order("total_sales", { ascending: false })
        .limit(50);
      const term = q.trim();
      const digits = term.replace(/\D/g, "");
      if (digits.length >= 4) query = query.like("customer_id", `%${digits}%`);
      else if (term) query = query.ilike("name", `%${term.replace(/[%_]/g, "")}%`);
      if (stage) query = query.eq("lifecycle_stage", stage);
      if (vip) query = query.eq("vip_flag", true);
      void query.then(({ data }) => !cancelled && setHits((data ?? []) as Hit[]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [accountId, q, stage, vip]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Customers</h1>
        <p className="text-sm text-muted-foreground">Search by phone (any 4+ digits) or name. Click a customer for the full 360 view.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="0501234567 or name"
            className="w-72 rounded-lg border border-border bg-background py-2 pe-3 ps-8 text-sm text-foreground" />
        </div>
        <select value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-2 text-sm">
          {STAGES.map((s) => <option key={s} value={s}>{s || "All stages"}</option>)}
        </select>
        <label className="flex items-center gap-1 text-sm text-muted-foreground"><input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} /> VIP only</label>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 text-right font-medium">Orders</th>
              <th className="px-3 py-2 text-right font-medium">Spend (SAR)</th>
              <th className="px-3 py-2 font-medium">Last order</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.customer_id} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2">
                  <Link href={`/engagement/customers/${h.customer_id}`} className="text-foreground hover:underline">
                    {h.name ?? "—"} <span className="text-xs text-muted-foreground">{h.mobile}</span>
                  </Link>
                  {h.vip_flag && <span className="ms-1 text-xs text-amber-600">VIP</span>}
                </td>
                <td className="px-3 py-2 text-xs">{h.lifecycle_stage}</td>
                <td className="px-3 py-2 text-right tabular-nums">{h.total_orders}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(Number(h.total_sales)).toLocaleString("en-US")}</td>
                <td className="px-3 py-2 text-xs">{h.last_order_date}</td>
              </tr>
            ))}
            {hits.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
