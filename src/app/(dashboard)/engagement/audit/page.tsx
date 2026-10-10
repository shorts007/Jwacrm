"use client";

// Audit log (PRD §75) — who changed which campaign, offer, contact rule, app-number setting or
// template, and when. Written by database triggers (migration 063), read-only here.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface Entry {
  id: number;
  occurred_at: string;
  actor_name: string | null;
  actor_id: string | null;
  entity: string;
  entity_label: string | null;
  action: "INSERT" | "UPDATE" | "DELETE";
  changes: Record<string, { from: unknown; to: unknown }>;
}

const ENTITY: Record<string, string> = {
  lulu_campaigns: "Campaign",
  lulu_offers: "Offer",
  lulu_contact_policy: "Contact rules",
  evolution_config: "WhatsApp app number",
  message_templates: "Template",
};
const ACTION: Record<Entry["action"], string> = { INSERT: "created", UPDATE: "changed", DELETE: "deleted" };

// Friendly names for the fields people change most; everything else is shown as-is.
const FIELD: Record<string, string> = {
  active: "Live switch",
  mode: "Mode",
  status: "Status",
  offer_id: "Offer",
  rule_params: "Rules",
  priority: "Priority",
  template_name_ar: "Arabic template",
  template_name_en: "English template",
  template_name_bilingual: "Bilingual template",
  test_phones: "Test numbers",
  holdout_pct: "Holdout %",
  promo_image_url: "Promotion image",
  promo_text_ar: "Promotion text (AR)",
  promo_text_en: "Promotion text (EN)",
  promo_valid_until: "Valid until",
  daily_send_cap: "Daily cap",
  send_gap_base_seconds: "Gap (s)",
  send_gap_increment_seconds: "Gap increase (s)",
  quiet_hours_start: "Quiet hours from",
  quiet_hours_end: "Quiet hours until",
  max_promo_per_window: "Max offers per window",
  max_marketing_per_window: "Max messages per window",
  is_default_outbound: "Send through this number",
  max_daily: "Max per day",
  window_start_hour: "Send from (hour)",
  window_end_hour: "Send until (hour)",
  auto_pause: "Auto-pause",
  paused_at: "Paused at",
  paused_reason: "Pause reason",
  warmup_started_at: "Warm-up start",
  api_key: "API key",
  base_url: "Server address",
  instance_name: "Instance",
  body_text: "Message text",
  value: "Value",
  name: "Name",
};

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

export default function AuditPage() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entity, setEntity] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    let query = createClient()
      .from("lulu_audit_log")
      .select("id, occurred_at, actor_name, actor_id, entity, entity_label, action, changes")
      .order("occurred_at", { ascending: false })
      .limit(300);
    if (entity) query = query.eq("entity", entity);
    const { data, error: e } = await query;
    if (e) {
      setError(/lulu_audit_log/.test(e.message) ? "Run migration 063 in Supabase to start the audit log." : e.message);
      setRows([]);
      return;
    }
    setError(null);
    setRows((data ?? []) as Entry[]);
  }, [entity]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!rows || !needle) return rows ?? [];
    return rows.filter((r) =>
      [r.actor_name ?? "", r.entity_label ?? "", ENTITY[r.entity] ?? r.entity, ...Object.keys(r.changes).map((k) => FIELD[k] ?? k)].some((x) =>
        x.toLowerCase().includes(needle),
      ),
    );
  }, [rows, q]);

  const input = "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every change to campaigns, offers, contact rules, the WhatsApp app number and templates — who, what and when. &ldquo;system&rdquo;
          means an automatic change (auto-pause, the daily sender, template sync).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={input} value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">Everything</option>
          {Object.entries(ENTITY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input className={`${input} w-full ps-9`} placeholder="Search person, name or field" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button type="button" className={`${input} inline-flex items-center gap-2 hover:bg-muted`} onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <ol className="space-y-2">
          {filtered.map((r) => (
            <li key={r.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-foreground">
                  <b>{r.actor_name ?? "system"}</b> {ACTION[r.action]} {ENTITY[r.entity] ?? r.entity}
                  {r.entity_label ? <> &ldquo;{r.entity_label}&rdquo;</> : null}
                </span>
                <time className="text-xs text-muted-foreground" dateTime={r.occurred_at}>
                  {new Date(r.occurred_at).toLocaleString()}
                </time>
              </div>
              {Object.keys(r.changes).length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {Object.entries(r.changes).map(([field, c]) => (
                    <li key={field} className="text-muted-foreground">
                      <span className="text-foreground">{FIELD[field] ?? field}</span>:{" "}
                      {r.action === "UPDATE" ? (
                        <>
                          <span className="line-through decoration-muted-foreground/50">{show(c.from)}</span> → <span className="text-foreground">{show(c.to)}</span>
                        </>
                      ) : (
                        <span>{show(r.action === "DELETE" ? c.from : c.to)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
