"use client";

// One-click creation of the LuLu WhatsApp templates in Meta, via WACRM's own
// template submission route (same as Settings → Templates → New template).

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LULU_TEMPLATE_DEFS } from "@/lib/lulu";

interface Synced {
  name: string;
  language: string | null;
  status: string | null;
}

export function LuluTemplatesPanel({ onChanged }: { onChanged?: () => void }) {
  const [synced, setSynced] = useState<Synced[]>([]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const load = useCallback(async () => {
    const { data } = await createClient().from("message_templates").select("name, language, status");
    setSynced((data ?? []) as Synced[]);
    onChanged?.();
  }, [onChanged]);

  // Initial load: state is set in the promise callback, not synchronously in the effect.
  useEffect(() => {
    void createClient()
      .from("message_templates")
      .select("name, language, status")
      .then(({ data }) => setSynced((data ?? []) as Synced[]));
  }, []);

  const statusOf = (name: string) => synced.find((s) => s.name === name)?.status ?? null;
  const missing = LULU_TEMPLATE_DEFS.filter((d) => !statusOf(d.name));

  const refresh = async () => {
    setBusy(true);
    await fetch("/api/whatsapp/templates/sync", { method: "POST" }).catch(() => null);
    await load();
    setBusy(false);
  };

  const createMissing = async () => {
    setBusy(true);
    const lines: string[] = [];
    for (const d of missing) {
      try {
        const res = await fetch("/api/whatsapp/templates/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        });
        const json = await res.json().catch(() => ({}));
        lines.push(res.ok ? `✓ ${d.name} submitted to Meta` : `✗ ${d.name}: ${json.error ?? `HTTP ${res.status}`}`);
      } catch (e) {
        lines.push(`✗ ${d.name}: ${e instanceof Error ? e.message : "request failed"}`);
      }
      setLog([...lines]);
    }
    await fetch("/api/whatsapp/templates/sync", { method: "POST" }).catch(() => null);
    await load();
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Step 1 — LuLu WhatsApp templates</h2>
          <p className="text-xs text-muted-foreground">
            Creates the {LULU_TEMPLATE_DEFS.length} English/Arabic marketing templates in the WhatsApp account this app is
            connected to and sends them to Meta for approval. Approval can take minutes to a day.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void refresh()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh status
          </button>
          <button type="button" onClick={() => void createMissing()} disabled={busy || missing.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Upload className="h-4 w-4" /> Create {missing.length} missing in Meta
          </button>
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {LULU_TEMPLATE_DEFS.map((d) => {
          const st = statusOf(d.name);
          return (
            <div key={d.name} className="flex justify-between gap-2">
              <span dir="ltr" className="text-foreground">{d.name}</span>
              <span className={st ? (st.toUpperCase() === "APPROVED" ? "text-emerald-600" : "text-amber-600") : "text-muted-foreground"}>
                {st ?? "not created"}
              </span>
            </div>
          );
        })}
      </div>
      {log.length > 0 && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs text-foreground">{log.join("\n")}</pre>
      )}
    </div>
  );
}
