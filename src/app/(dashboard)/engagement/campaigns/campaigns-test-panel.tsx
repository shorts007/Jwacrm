"use client";

// Test mode (PRD §78): save template names + internal test numbers for a
// campaign and send the template to those numbers only.

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_TEMPLATE_NAMES, campaignNeedsOffer, type CampaignType } from "@/lib/lulu";

export interface TestCampaign {
  id: string;
  campaign_code: string;
  name: string;
  campaign_type: CampaignType;
  template_name_ar?: string | null;
  template_name_en?: string | null;
  template_name_bilingual?: string | null;
  test_phones?: string[] | null;
  offer_id?: string | null;
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
  const [bi, setBi] = useState("");
  const [phones, setPhones] = useState("");
  const [name, setName] = useState("Test");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [synced, setSynced] = useState<{ name: string; language: string | null; status: string | null }[]>([]);
  const [offers, setOffers] = useState<{ id: string; offer_code: string; name: string; active: boolean }[]>([]);
  const [offerId, setOfferId] = useState("");

  // Templates already synced from Meta — offered as suggestions so names match exactly.
  useEffect(() => {
    void createClient()
      .from("message_templates")
      .select("name, language, status")
      .order("name")
      .then(({ data }) => setSynced((data ?? []) as typeof synced));
    void createClient()
      .from("lulu_offers")
      .select("id, offer_code, name, active")
      .order("offer_code")
      .then(({ data }) => setOffers((data ?? []) as typeof offers));
  }, []);

  useEffect(() => {
    if (!c) return;
    const d = DEFAULT_TEMPLATE_NAMES[c.campaign_type];
    setAr(c.template_name_ar ?? d?.ar ?? "");
    setEn(c.template_name_en ?? d?.en ?? "");
    setBi(c.template_name_bilingual ?? d?.bi ?? "");
    setPhones((c.test_phones ?? []).join(", "));
    setOfferId(c.offer_id ?? "");
    setResult(null);
    setMsg(null);
  }, [c?.id, c?.template_name_ar, c?.template_name_en, c?.template_name_bilingual, c?.test_phones, c?.offer_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c) return null;

  const parsedPhones = phones.split(/[,\n]/).map((p) => p.trim().replace(/[\s()-]/g, "")).filter(Boolean);
  const badPhone = parsedPhones.find((p) => !/^\+\d{8,15}$/.test(p));

  const needsOffer = campaignNeedsOffer(c.campaign_type);

  // Writes what is on screen. Returns false (with a message) when it could not.
  const persist = async (): Promise<boolean> => {
    if (badPhone) {
      setMsg(`"${badPhone}" must look like +966501234567 (leading +, country code).`);
      return false;
    }
    const { error } = await createClient()
      .from("lulu_campaigns")
      .update({
        template_name_ar: ar.trim() || null,
        template_name_en: en.trim() || null,
        template_name_bilingual: bi.trim() || null,
        test_phones: parsedPhones,
        ...(needsOffer ? { offer_id: offerId || null } : {}),
      })
      .eq("id", c.id);
    if (error) {
      setMsg(error.message);
      return false;
    }
    return true;
  };

  const save = async () => {
    setBusy(true);
    const ok = await persist();
    setBusy(false);
    if (ok) {
      setMsg("Saved.");
      onSaved();
    }
  };

  const send = async (language: "ar" | "en" | "bi") => {
    setBusy(true);
    setMsg(null);
    setResult(null);
    try {
      // Send exactly what is on screen: the (pre-filled) template names, numbers and offer are
      // saved first, so a test never fails on "set the template name" while the fields look filled.
      if (needsOffer && !offerId) {
        throw new Error("This campaign's message mentions an offer — pick one in “Offer” below (create offers on the Offers page).");
      }
      if (!(await persist())) return;
      onSaved();
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
        <h2 className="text-sm font-semibold text-foreground">Step 2 — Test mode</h2>
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
          <input className={input} list="lulu-synced-templates" value={ar} onChange={(e) => setAr(e.target.value)} dir="ltr" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          English template name
          <input className={input} list="lulu-synced-templates" value={en} onChange={(e) => setEn(e.target.value)} dir="ltr" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Bilingual template name (AR + EN, with language buttons)
          <input className={input} list="lulu-synced-templates" value={bi} onChange={(e) => setBi(e.target.value)} dir="ltr" />
        </label>
        {needsOffer && (
          <label className="space-y-1 text-xs text-muted-foreground">
            Offer (named in the message)
            <select className={input} value={offerId} onChange={(e) => setOfferId(e.target.value)}>
              <option value="">— pick an offer —</option>
              {offers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.offer_code} · {o.name}
                  {o.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
            {offers.length === 0 && (
              <span className="block">
                No offers yet — create one on the{" "}
                <a href="/engagement/offers" className="text-primary underline">Offers page</a>.
              </span>
            )}
          </label>
        )}
        <label className="space-y-1 text-xs text-muted-foreground">
          Test phone numbers (comma-separated, with +country code)
          <input className={input} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="+966546182300" dir="ltr" />
        </label>
      </div>
      <datalist id="lulu-synced-templates">
        {synced.map((t) => (
          <option key={`${t.name}-${t.language}`} value={t.name}>{`${t.language ?? "?"} · ${t.status ?? "?"}`}</option>
        ))}
      </datalist>
      <p className="text-xs text-muted-foreground">
        {synced.length === 0
          ? "No templates synced from Meta yet — go to Settings → Templates → Sync from Meta."
          : `${synced.length} templates synced from Meta (start typing a name to pick one; only Approved ones can be sent).`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50">
          Save
        </button>
        {(["bi", "ar", "en"] as const).map((l) => (
          <button key={l} type="button" onClick={() => void send(l)} disabled={busy || parsedPhones.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send test ({l === "bi" ? "Both languages" : l === "ar" ? "Arabic" : "English"})
          </button>
        ))}
        <span className="text-xs text-muted-foreground">Sending also saves these fields.</span>
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
