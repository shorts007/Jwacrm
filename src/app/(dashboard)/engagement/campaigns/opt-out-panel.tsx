"use client";

// Step 0 — must be ON before any customer campaign: STOP replies opt customers out,
// and delivery / read / failed statuses are tracked for LuLu sends.
// Shows receiver health, a self-test ("Check"), the latest webhook events and opt-outs.

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

interface HookStatus {
  configured: boolean;
  url: string;
  endpoint: { is_active: boolean; failure_count: number; last_delivery_at: string | null } | null;
  optOuts: number;
  recentOptOuts: { phone_digits: string; opted_out_at: string; keyword: string | null }[];
  log: { received_at: string; event: string | null; outcome: string; detail: string | null }[];
  ping?: string;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export function OptOutPanel() {
  const [st, setSt] = useState<HookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (method: "GET" | "POST", action?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lulu/hooks/setup${action ? `?action=${action}` : ""}`, { method });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed");
      setSt(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void fetch("/api/lulu/hooks/setup")
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setSt(j)))
      .catch(() => setError("Could not load opt-out status"));
  }, []);

  const btn = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50";

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4" /> Step 0 — Opt-out &amp; delivery tracking
          </h2>
          <p className="text-xs text-muted-foreground">
            Customers who reply STOP / إيقاف / إلغاء are unsubscribed instantly and get a confirmation; START / ابدأ subscribes them
            again. Delivered / read / failed statuses of LuLu messages are recorded. Required before any customer campaign.
          </p>
          {st && (
            <p className="mt-1 text-xs text-muted-foreground">
              {st.configured ? "Active" : "Not active"} · last delivery from WACRM: {when(st.endpoint?.last_delivery_at ?? null)} ·
              consecutive failures: {st.endpoint?.failure_count ?? 0} · {st.optOuts.toLocaleString("en-US")} phones opted out
            </p>
          )}
          {st?.ping && (
            <p className={`mt-1 text-xs ${st.ping === "ok" ? "text-emerald-600" : "text-destructive"}`}>Self-test: {st.ping}</p>
          )}
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {st?.configured ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> Enabled
              </span>
              <button type="button" className={btn} disabled={busy} onClick={() => void call("POST", "ping")}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Check receiver
              </button>
              <button type="button" className={btn} disabled={busy} onClick={() => void call("GET")}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void call("POST")}
              disabled={busy || !st}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enable
            </button>
          )}
        </div>
      </div>

      {st?.configured && (
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h3 className="mb-1 text-xs font-semibold text-foreground">Latest webhook events</h3>
            {st.log.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing received yet. Reply STOP from a test phone, then Refresh. If nothing appears, WACRM is not delivering to the
                receiver — click &ldquo;Check receiver&rdquo;.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <tbody>
                  {st.log.map((l, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-1 pe-2 text-muted-foreground">{when(l.received_at)}</td>
                      <td className="py-1 pe-2 text-foreground">{l.outcome}</td>
                      <td className="py-1 text-muted-foreground">{l.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold text-foreground">Recent opt-outs</h3>
            {st.recentOptOuts.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {st.recentOptOuts.map((o) => (
                  <li key={o.phone_digits} className="text-muted-foreground">
                    +{o.phone_digits} · {o.keyword ?? ""} · {when(o.opted_out_at)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
