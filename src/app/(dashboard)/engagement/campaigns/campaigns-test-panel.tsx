"use client";

// Test mode (PRD §78): save template names + internal test numbers for a
// campaign and send the template to those numbers only.

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_TEMPLATE_NAMES, type CampaignType } from "@/lib/lulu";

export interface TestCampaign {
  id: string;
  campaign_code: string;
  name: string;
  campaign_type: CampaignType;
  template_name_ar?: string | null;
  template_name_en?: string | null;
  test_phones?: string[] | null;
}

interface SendResult {
  template: string;
  language: string;
  params: string[];
  results: { phone: string; ok: boolean; error?: string }[];
}

export function TestPanel({ campaigns, onSaved }: { campaigns: TestCampaign[]; onSaved: () => void }) {
  const [id, setId] = useState(campaigns[0]?.id ?? "");
  const c = campaigns.find((x) => x.id === id) ?? campaigns[0];
  const [ar, setAr] = useState("");
  const [en, setEn] = useState("");
  const [phones, setPhones] = useState("");
  const [name, setName] = useState("Test");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  useEffect(() => {
    if (!c) return;
    const d = DEFAULT_TEMPLATE_NAMES[c.campaign_type];
    setAr(c.template_name_ar ?? d?.ar ?? "");
    setEn(c.template_name_en ?? d?.en ?? "");
    setPhones((c.test_phones ?? []).join(", "));
    setResult(null);
    setMsg(null);
  }, [c?.id, c?.template_name_ar, c?.template_name_en, c?.test_phones]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c) return null;

  const parsedPhones = phones.split(/[,\n]/).map((p) => p.trim().replace(/[\s()-]/g, "")).filter(Boolean);
  const badPhone = parsedPhones.find((p) => !/^\+\d{8,15}$/.test(p));

  const save = async () => {
    if (badPhone) return setMsg(`"${badPhone}" must look like +966501234567 (leading +, country code).`);
    setBusy(true);
    const { error } = await createClient()
      .from("lulu_campaigns")
      .update({ template_name_ar: ar.trim() || null, template_name_en: en.trim() || null, test_phones: parsedPhones })
      .eq("id", c.id);
    setBusy(false);
    setMsg(error ? error.message : "Saved.");
    if (!error) onSaved();
  };

  const send = async (language: "ar" | "en") => {
    setBusy(true);
    setMsg(null);
    setResult(null);
    try {
      const res = await fetch("/api/lulu/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: c.id, language, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Test send failed");
      setResult(json);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Test send failed");
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Test mode</h2>
        <p className="text-xs text-muted-foreground">
          Sends the template to your internal test numbers only — never to customers. The template must be APPROVED in Meta, and
          with Meta&rsquo;s free test sender each recipient must first be added to its allowed list.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Campaign
          <select className={input} value={c.id} onChange={(e) => setId(e.target.value)}>
            {campaigns.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Name shown in the message
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Arabic template name
          <input className={input} value={ar} onChange={(e) => setAr(e.target.value)} dir="ltr" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          English template name
          <input className={input} value={en} onChange={(e) => setEn(e.target.value)} dir="ltr" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
          Test phone numbers (comma-separated, with +country code)
          <input className={input} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="+966546182300" dir="ltr" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50">
          Save
        </button>
        {(["ar", "en"] as const).map((l) => (
          <button key={l} type="button" onClick={() => void send(l)} disabled={busy || parsedPhones.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send test ({l === "ar" ? "Arabic" : "English"})
          </button>
        ))}
        <span className="text-xs text-muted-foreground">Save first if you changed the fields.</span>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      {result && (
        <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
          <div>Template <b>{result.template}</b> ({result.language}) · variables: {result.params.join(" | ")}</div>
          {result.results.map((r) => (
            <div key={r.phone} className={r.ok ? "text-emerald-600" : "text-destructive"}>
              {r.phone}: {r.ok ? "sent" : `failed — ${r.error}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
