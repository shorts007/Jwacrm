"use client";

// App-number safety: warm-up ramp, today's limit and usage, sending hours, health warnings and
// the automatic pause. Applies to business-initiated sends (campaigns, broadcasts) through the
// WhatsApp app number — never to replies.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, PauseCircle, PlayCircle, ShieldCheck } from "lucide-react";

interface Summary {
  configured: boolean;
  warmupDays?: number;
  config?: { maxDaily: number; windowStartHour: number; windowEndHour: number; autoPause: boolean; warmupStartedAt: string | null };
  paused?: { at: string; reason: string | null } | null;
  today?: { limit: number; sent: number; warmupDay: number; warmingUp: boolean; optOuts: number };
  undelivered?: { total: number; notDelivered: number };
  recentFailures?: number;
  warnings?: string[];
  error?: string;
}

export function SafetyPanel() {
  const [s, setS] = useState<Summary | null>(null);
  const [form, setForm] = useState({ maxDaily: 100, windowStartHour: 10, windowEndHour: 21, autoPause: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const apply = (j: Summary) => {
    setS(j);
    if (j.config) setForm({ maxDaily: j.config.maxDaily, windowStartHour: j.config.windowStartHour, windowEndHour: j.config.windowEndHour, autoPause: j.config.autoPause });
  };

  const load = useCallback(async () => {
    const r = await fetch("/api/evolution/safety");
    const j = (await r.json()) as Summary;
    if (!r.ok) return setMsg({ text: j.error ?? "Could not load safety settings", error: true });
    apply(j);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setMsg(null);
    try {
      const r = await fetch("/api/evolution/safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const j = (await r.json()) as Summary;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      apply({ warmupDays: s?.warmupDays, ...j, configured: true });
      setMsg({ text: action === "resume" ? "Resumed. Campaigns paused by the safety check stay paused — resume them in Campaigns → Step 3." : "Saved." });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  if (!s?.configured || !s.today || !s.config) {
    return msg ? <p className="text-sm text-destructive">{msg.text}</p> : null;
  }
  const t = s.today;
  const pct = Math.min(100, Math.round((t.sent / Math.max(1, t.limit)) * 100));
  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const btn = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50";

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4" /> Number safety
        </h2>
        {s.paused ? (
          <span className="rounded-full bg-red-500/10 px-3 py-1 text-xs text-red-600">Paused</span>
        ) : (
          <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-600">Sending allowed</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Limits campaigns and broadcasts sent from the WhatsApp app number — replies to customers are never limited. WhatsApp bans app numbers
        that suddenly send a lot or get many blocks / STOP replies.
      </p>

      {s.paused && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
          <span className="text-foreground">
            <b>Paused</b> {new Date(s.paused.at).toLocaleString()} — {s.paused.reason ?? "no reason recorded"}
          </span>
          <button type="button" className={btn} disabled={!!busy} onClick={() => void act("resume", {}, "Resume campaign sending through the app number?")}>
            {busy === "resume" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} Resume
          </button>
        </div>
      )}

      {(s.warnings ?? []).map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}
        </p>
      ))}

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Sent today</div>
          <div className="text-lg font-semibold text-foreground">
            {t.sent} <span className="text-sm font-normal text-muted-foreground">/ {t.limit}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-muted">
            <div className={`h-1.5 rounded-full ${pct >= 100 ? "bg-red-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Warm-up</div>
          <div className="text-lg font-semibold text-foreground">{t.warmingUp ? `Day ${t.warmupDay} of ${s.warmupDays}` : "Done"}</div>
          <div className="text-xs text-muted-foreground">20 → 40 → 70 → 100 a day</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">STOP replies today</div>
          <div className="text-lg font-semibold text-foreground">{t.optOuts}</div>
          <div className="text-xs text-muted-foreground">pauses at 5% (min 20 sent) or 10</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Still one tick (2 h+)</div>
          <div className="text-lg font-semibold text-foreground">
            {s.undelivered?.notDelivered ?? 0} <span className="text-sm font-normal text-muted-foreground">/ {s.undelivered?.total ?? 0}</span>
          </div>
          <div className="text-xs text-muted-foreground">recent failures: {s.recentFailures ?? 0} of last 10</div>
        </div>
      </div>

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
        <label className="space-y-1 text-xs text-muted-foreground">
          Max per day (after warm-up)
          <input type="number" min={1} max={1000} className={input} value={form.maxDaily} onChange={(e) => setForm({ ...form, maxDaily: Number(e.target.value) })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Send from (hour, Riyadh)
          <input type="number" min={0} max={23} className={input} value={form.windowStartHour} onChange={(e) => setForm({ ...form, windowStartHour: Number(e.target.value) })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Until (hour, Riyadh)
          <input type="number" min={1} max={24} className={input} value={form.windowEndHour} onChange={(e) => setForm({ ...form, windowEndHour: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
          <input type="checkbox" checked={form.autoPause} onChange={(e) => setForm({ ...form, autoPause: e.target.checked })} />
          Pause automatically on trouble
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={!!busy} onClick={() => void act("settings", form)}>
          {busy === "settings" && <Loader2 className="h-4 w-4 animate-spin" />} Save limits
        </button>
        {!s.paused && (
          <button type="button" className={`${btn} text-destructive`} disabled={!!busy} onClick={() => void act("pause", {}, "Stop campaign sending through the app number now?")}>
            <PauseCircle className="h-4 w-4" /> Pause now
          </button>
        )}
        {t.warmingUp ? (
          <button
            type="button"
            className={btn}
            disabled={!!busy}
            onClick={() =>
              void act(
                "skip_warmup",
                {},
                "Skip the warm-up? Only do this if this number has already been sending regularly for weeks — a sudden jump is the main reason app numbers get banned."
              )
            }
          >
            Skip warm-up
          </button>
        ) : (
          <button type="button" className={btn} disabled={!!busy} onClick={() => void act("restart_warmup", {}, "Restart the 3-week warm-up (e.g. after linking a new number)?")}>
            Restart warm-up
          </button>
        )}
      </div>
      {msg && <p className={`text-sm ${msg.error ? "text-destructive" : "text-muted-foreground"}`}>{msg.text}</p>}
    </section>
  );
}
