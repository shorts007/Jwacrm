"use client";

// Campaign preview (PRD §77): who it would reach if it went LIVE now, who is left out and why,
// how many days the daily limits make it take, and the exact messages for a few real customers.

import { useEffect, useState } from "react";
import { AlertTriangle, Eye, Loader2, X } from "lucide-react";

interface Preview {
  campaign: { name: string; code: string; mode: string; status: string; active: boolean };
  counts: { customers: number; matched: number; recipients: number; holdout: number; suspects: number };
  exclusions: { reason: string; label: string; count: number }[];
  pacing: { channel: "meta" | "evolution"; dailyCap: number; appLimit: number | null; perDay: number; days: number; sharedWith: string[] };
  samples: { name: string; phone: string; languageChoice: string; template?: string; text?: string; image?: string | null; error?: string }[];
  warnings: string[];
  note: string;
}

const fmt = (n: number) => n.toLocaleString();

export function PreviewPanel({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/lulu/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaign_id: campaignId }) })
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else setData(j as Preview);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Eye className="h-4 w-4" /> Preview{data ? ` — ${data.campaign.name}` : ""}
        </h3>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close preview">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!data && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking every customer against the campaign rules…
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          {data.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}
            </p>
          ))}

          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Match the campaign" value={fmt(data.counts.matched)} hint={`of ${fmt(data.counts.customers)} customers`} />
            <Stat label="Left out" value={fmt(data.counts.matched - data.counts.recipients - data.counts.holdout)} hint="see reasons below" />
            <Stat label="Held back to measure" value={fmt(data.counts.holdout)} hint="holdout group" />
            <Stat label="Would receive it" value={fmt(data.counts.recipients)} hint={`≈ ${data.pacing.days} day${data.pacing.days === 1 ? "" : "s"} at ${data.pacing.perDay}/day`} strong />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-foreground">Why customers are left out</h4>
              {data.exclusions.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nobody who matched is left out.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <tbody>
                    {data.exclusions.map((e) => (
                      <tr key={e.reason} className="border-t border-border">
                        <td className="py-1 pe-2 text-foreground">{e.label}</td>
                        <td className="py-1 text-right tabular-nums text-muted-foreground">{fmt(e.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-muted-foreground">
                Sends through <b>{data.pacing.channel === "evolution" ? "the WhatsApp app number" : "the Meta number"}</b>: daily cap {data.pacing.dailyCap}
                {data.pacing.appLimit !== null ? `, app-number limit today ${data.pacing.appLimit}` : ""}.
                {data.pacing.sharedWith.length > 0 && ` The daily limit is shared with: ${data.pacing.sharedWith.join(", ")}.`}
                {data.counts.suspects > 0 && ` ${fmt(data.counts.suspects)} suspect numbers are never messaged.`}
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-foreground">What real customers would get</h4>
              {data.samples.length === 0 && <p className="text-xs text-muted-foreground">No one would receive it today.</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                {data.samples.map((s) => (
                  <div key={s.phone} className="space-y-1">
                    <div className="text-[11px] text-muted-foreground">
                      {s.name} · {s.phone} · language: {s.languageChoice}
                    </div>
                    {s.error ? (
                      <div className="rounded-lg border border-dashed border-border p-2 text-xs text-destructive">{s.error}</div>
                    ) : (
                      <div className="overflow-hidden rounded-lg bg-[#dcf8c6] text-[13px] leading-snug text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
                        {s.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.image} alt="" className="aspect-[1.91/1] w-full object-cover" />
                        )}
                        <div className="whitespace-pre-wrap p-2" dir="auto">
                          {s.text}
                        </div>
                      </div>
                    )}
                    {s.template && <div className="text-[10px] text-muted-foreground">{s.template}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{data.note}</p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${strong ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}
