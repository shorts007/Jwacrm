"use client";

// Step 3 — Live sending: pacing settings, which campaigns are LIVE, pause/resume,
// and today's send log. Sending itself is driven by the n8n "daily sender"
// workflow calling /api/v1/lulu/campaigns/prepare and /send-next.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pause, Play, RefreshCw, Radio } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_SEND_SETTINGS, OFFER_CAMPAIGNS, riyadhDayStart, totalDuration, type CampaignType, type SendSettings } from "@/lib/lulu";

export interface LiveCampaignRow {
  id: string;
  campaign_code: string;
  name: string;
  mode: string;
  status: string;
  active: boolean;
  template_name_ar: string | null;
  template_name_en: string | null;
  template_name_bilingual?: string | null;
  campaign_type?: string;
  offer_id?: string | null;
}

interface ActionRow {
  id: string;
  customer_id: string;
  campaign_id: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
  wa_message_id: string | null;
  last_error: string | null;
  skip_reason: string | null;
  template_language: string | null;
}

const mask = (d: string) => (d.length > 6 ? `+${d.slice(0, 5)}•••${d.slice(-3)}` : d);
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

export function LivePanel({ accountId, campaigns, onChanged }: { accountId: string; campaigns: LiveCampaignRow[]; onChanged: () => void }) {
  const [settings, setSettings] = useState<SendSettings>(DEFAULT_SEND_SETTINGS);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [delivery, setDelivery] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState<{ id: string; offer_code: string; name: string; active: boolean }[]>([]);

  const load = useCallback(async () => {
    const db = createClient();
    const dayStart = riyadhDayStart(new Date()).toISOString();
    const [{ data: pol }, { data: acts }, { data: evs }, { data: offs }] = await Promise.all([
      db.from("lulu_contact_policy").select("*").eq("account_id", accountId).maybeSingle(),
      db
        .from("lulu_customer_next_actions")
        .select("id, customer_id, campaign_id, status, sent_at, created_at, wa_message_id, last_error, skip_reason, template_language")
        .eq("account_id", accountId)
        .eq("is_test", false)
        .gte("created_at", dayStart)
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("lulu_campaign_events")
        .select("action_id, event_type")
        .eq("account_id", accountId)
        .gte("occurred_at", dayStart)
        .in("event_type", ["DELIVERED", "READ", "FAILED"])
        .limit(2000),
      db.from("lulu_offers").select("id, offer_code, name, active").eq("account_id", accountId).order("offer_code"),
    ]);
    setOffers((offs ?? []) as { id: string; offer_code: string; name: string; active: boolean }[]);
    if (pol) {
      const p = pol as { daily_send_cap?: number; send_gap_base_seconds?: number; send_gap_increment_seconds?: number };
      setSettings({
        dailyCap: p.daily_send_cap ?? DEFAULT_SEND_SETTINGS.dailyCap,
        gapBaseSeconds: p.send_gap_base_seconds ?? DEFAULT_SEND_SETTINGS.gapBaseSeconds,
        gapIncrementSeconds: p.send_gap_increment_seconds ?? DEFAULT_SEND_SETTINGS.gapIncrementSeconds,
      });
    }
    setActions((acts ?? []) as ActionRow[]);
    const rank: Record<string, number> = { DELIVERED: 1, READ: 2, FAILED: 3 };
    const d: Record<string, string> = {};
    for (const e of evs ?? []) {
      const id = e.action_id as string | null;
      if (!id) continue;
      if (!d[id] || rank[e.event_type as string] > rank[d[id]]) d[id] = e.event_type as string;
    }
    setDelivery(d);
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const saveSettings = async () => {
    setBusy(true);
    const { error } = await createClient().from("lulu_contact_policy").upsert(
      {
        account_id: accountId,
        daily_send_cap: settings.dailyCap,
        send_gap_base_seconds: settings.gapBaseSeconds,
        send_gap_increment_seconds: settings.gapIncrementSeconds,
      },
      { onConflict: "account_id" },
    );
    setBusy(false);
    setMsg(error ? (/send_gap|daily_send_cap/.test(error.message) ? "Run migration 053 in Supabase first." : error.message) : "Saved.");
  };

  const setMode = async (c: LiveCampaignRow, live: boolean) => {
    if (live) {
      const ok = window.confirm(
        `Make "${c.name}" LIVE?\n\nReal customers will receive WhatsApp messages (max ${settings.dailyCap}/day) the next time the daily sender runs.\n` +
          `Templates: both ${c.template_name_bilingual ?? "—"} · AR ${c.template_name_ar ?? "—"} · EN ${c.template_name_en ?? "—"}\n` +
          `Customers who haven't chosen a language get the bilingual message.\nThe campaign's Live switch must also be On.`,
      );
      if (!ok) return;
    }
    const { error } = await createClient()
      .from("lulu_campaigns")
      .update(live ? { mode: "LIVE", status: "RUNNING" } : { mode: "DRY_RUN", status: "DRAFT" })
      .eq("id", c.id);
    setMsg(error ? error.message : live ? `${c.name} is LIVE.` : `${c.name} is back in dry-run mode.`);
    onChanged();
  };

  const setOffer = async (c: LiveCampaignRow, offerId: string) => {
    const { error } = await createClient().from("lulu_campaigns").update({ offer_id: offerId || null }).eq("id", c.id);
    setMsg(error ? error.message : `Offer for ${c.name} updated.`);
    onChanged();
  };

  const pauseAll = async (pause: boolean) => {
    const db = createClient();
    const { error } = await db
      .from("lulu_campaigns")
      .update({ status: pause ? "PAUSED" : "RUNNING" })
      .eq("account_id", accountId)
      .eq("mode", "LIVE");
    if (!error && pause) {
      // Nothing queued for today may go out while paused.
      await db
        .from("lulu_customer_next_actions")
        .update({ status: "CANCELLED", skip_reason: "paused by user" })
        .eq("account_id", accountId)
        .eq("is_test", false)
        .eq("status", "SCHEDULED");
    }
    setMsg(error ? error.message : pause ? "All live campaigns paused; today's remaining queue cancelled." : "Live campaigns resumed.");
    onChanged();
    await load();
  };

  const count = (s: string) => actions.filter((a) => a.status === s).length;
  const delivered = Object.values(delivery).filter((v) => v === "DELIVERED" || v === "READ").length;
  const read = Object.values(delivery).filter((v) => v === "READ").length;
  const liveCampaigns = campaigns.filter((c) => c.mode === "LIVE");
  const anyPaused = liveCampaigns.some((c) => c.status === "PAUSED");
  const codeOf = (id: string | null) => campaigns.find((c) => c.id === id)?.campaign_code ?? "—";
  const input = "w-24 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground";
  const btn = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50";

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Radio className="h-4 w-4" /> Step 3 — Live sending to customers
          </h2>
          <p className="text-xs text-muted-foreground">
            The n8n &ldquo;daily sender&rdquo; builds today&rsquo;s queue from LIVE campaigns and sends one message at a time, waiting{" "}
            {settings.gapBaseSeconds} s, {settings.gapBaseSeconds + settings.gapIncrementSeconds} s,{" "}
            {settings.gapBaseSeconds + 2 * settings.gapIncrementSeconds} s … between messages. {settings.dailyCap} messages take about{" "}
            {Math.round(totalDuration(settings.dailyCap, settings) / 60)} minutes. No sends 22:00–09:00 (Riyadh); paused automatically on
            Meta rate-limit/block errors or 5 failures in a row.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          {liveCampaigns.length > 0 &&
            (anyPaused ? (
              <button type="button" className={btn} onClick={() => void pauseAll(false)}>
                <Play className="h-4 w-4" /> Resume
              </button>
            ) : (
              <button type="button" className={`${btn} border-destructive/50 text-destructive`} onClick={() => void pauseAll(true)}>
                <Pause className="h-4 w-4" /> Pause all
              </button>
            ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-xs text-muted-foreground">
        <label className="space-y-1">
          <div>Daily cap</div>
          <input type="number" min={1} max={1000} className={input} value={settings.dailyCap}
            onChange={(e) => setSettings({ ...settings, dailyCap: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="space-y-1">
          <div>First gap (s)</div>
          <input type="number" min={10} max={600} className={input} value={settings.gapBaseSeconds}
            onChange={(e) => setSettings({ ...settings, gapBaseSeconds: Math.max(10, Number(e.target.value) || 60) })} />
        </label>
        <label className="space-y-1">
          <div>+ per message (s)</div>
          <input type="number" min={0} max={60} className={input} value={settings.gapIncrementSeconds}
            onChange={(e) => setSettings({ ...settings, gapIncrementSeconds: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <button type="button" className={btn} disabled={busy} onClick={() => void saveSettings()}>Save pacing</button>
        {msg && <span className="text-foreground">{msg}</span>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Campaign</th>
              <th className="px-2 py-1.5 font-medium">Live switch</th>
              <th className="px-2 py-1.5 font-medium">Mode</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Offer</th>
              <th className="px-2 py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-2 py-1.5 text-foreground">{c.name}</td>
                <td className="px-2 py-1.5">{c.active ? "On" : "Off"}</td>
                <td className={`px-2 py-1.5 ${c.mode === "LIVE" ? "font-semibold text-emerald-600" : ""}`}>{c.mode}</td>
                <td className={`px-2 py-1.5 ${c.status === "PAUSED" ? "text-amber-600" : ""}`}>{c.status}</td>
                <td className="px-2 py-1.5">
                  {c.campaign_type && OFFER_CAMPAIGNS.has(c.campaign_type as CampaignType) ? (
                    <select
                      className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                      value={c.offer_id ?? ""}
                      onChange={(e) => void setOffer(c, e.target.value)}
                    >
                      <option value="">— required —</option>
                      {offers.map((o) => (
                        <option key={o.id} value={o.id}>{o.offer_code}{o.active ? "" : " (inactive)"}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-muted-foreground">no offer in message</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {c.mode === "LIVE" ? (
                    <button type="button" className={btn} onClick={() => void setMode(c, false)}>Back to dry run</button>
                  ) : (
                    <div className="flex flex-col items-end gap-0.5">
                      <button type="button" className={btn} disabled={!c.active || (!c.template_name_ar && !c.template_name_en && !c.template_name_bilingual)}
                        onClick={() => void setMode(c, true)}>
                        Make LIVE
                      </button>
                      {/* Two deliberate steps so nothing goes to customers by a single click. */}
                      {!c.active ? (
                        <span className="text-[11px] text-muted-foreground">First turn its <b>Live</b> switch On in the campaign table above</span>
                      ) : !c.template_name_ar && !c.template_name_en && !c.template_name_bilingual ? (
                        <span className="text-[11px] text-muted-foreground">First save its template names in Step 2</span>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold text-foreground">Today</h3>
        <p className="text-xs text-muted-foreground">
          Queued {count("SCHEDULED")} · sending {count("SENDING")} · sent {count("SENT")} · delivered {delivered} · read {read} · failed{" "}
          {count("FAILED")} · skipped {count("CANCELLED")} (of cap {settings.dailyCap})
        </p>
        {anyPaused && (
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" /> Paused — check the failed rows below before resuming.
          </p>
        )}
        {actions.length > 0 && (
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Queued</th>
                  <th className="px-2 py-1 font-medium">Sent</th>
                  <th className="px-2 py-1 font-medium">Campaign</th>
                  <th className="px-2 py-1 font-medium">Customer</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Delivery</th>
                  <th className="px-2 py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-2 py-1 text-muted-foreground">{time(a.created_at)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{time(a.sent_at)}</td>
                    <td className="px-2 py-1">{codeOf(a.campaign_id)}</td>
                    <td className="px-2 py-1 tabular-nums">{mask(a.customer_id)}</td>
                    <td className={`px-2 py-1 ${a.status === "FAILED" ? "text-destructive" : a.status === "SENT" ? "text-emerald-600" : ""}`}>{a.status}</td>
                    <td className="px-2 py-1">{delivery[a.id] ?? (a.status === "SENT" ? "sent" : "")}</td>
                    <td className="px-2 py-1 text-muted-foreground">{a.last_error ?? a.skip_reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
