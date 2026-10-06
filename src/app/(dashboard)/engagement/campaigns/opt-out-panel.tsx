"use client";

// Step 0 — must be ON before any customer campaign: STOP replies opt customers out,
// and delivery / read / failed statuses are tracked for LuLu sends.

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

interface HookStatus {
  configured: boolean;
  url: string;
  optOuts: number;
}

export function OptOutPanel() {
  const [st, setSt] = useState<HookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/lulu/hooks/setup")
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setSt(j)))
      .catch(() => setError("Could not load opt-out status"));
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lulu/hooks/setup", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed");
      setSt(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="max-w-2xl">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4" /> Step 0 — Opt-out &amp; delivery tracking
        </h2>
        <p className="text-xs text-muted-foreground">
          Customers who reply STOP / إيقاف / إلغاء are unsubscribed instantly and get a confirmation; START / ابدأ subscribes them again.
          Delivered / read / failed statuses of LuLu messages are recorded. Required before any customer campaign.
        </p>
        {st && (
          <p className="mt-1 text-xs text-muted-foreground">
            {st.configured ? "Active" : "Not active"} · {st.optOuts.toLocaleString("en-US")} phones opted out · receiver {st.url}
          </p>
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      {st?.configured ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" /> Enabled
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void enable()}
          disabled={busy || !st}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enable
        </button>
      )}
    </div>
  );
}
