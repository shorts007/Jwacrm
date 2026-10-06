"use client";

// Offers (PRD §53-54, §81): create the offers campaigns may promise, see what each has cost.
// The code itself must exist in your checkout system — this page only decides who is offered what.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Save } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OFFER_COLUMNS, offerBlockReason, offerFromRow, offerText, type OfferRow, type OfferType, type PriceBehaviour } from "@/lib/lulu/offers";

interface Usage {
  offer_id: string;
  sends: number;
  converted: number;
  orders: number;
  revenue: number | string;
  discount_cost: number | string;
}

const TYPES: { v: OfferType; label: string }[] = [
  { v: "FREE_DELIVERY", label: "Free delivery" },
  { v: "FIXED_VOUCHER", label: "Fixed SAR off" },
  { v: "PERCENT_DISCOUNT", label: "% off" },
  { v: "CATEGORY_DISCOUNT", label: "% off a category" },
];
const BEHAVIOURS: PriceBehaviour[] = ["Offer-driven", "Mixed", "Full-price", "Unknown"];
const STORES = ["3805", "3806", "3808", "3809", "3810", "3814", "3818", "3821"];

const blank = (): OfferRow => ({
  id: "",
  offer_code: "",
  name: "",
  offer_type: "FREE_DELIVERY",
  value: 0,
  minimum_order: 0,
  text_ar: "",
  text_en: "",
  validity_days: 7,
  start_date: null,
  end_date: null,
  budget_sar: null,
  eligible_segments: [],
  eligible_stores: [],
  eligible_price_behaviour: ["Offer-driven", "Mixed", "Unknown"],
  active: true,
});

const n0 = (v: number) => Math.round(v).toLocaleString("en-US");

export default function OffersPage() {
  const { accountId } = useAuth();
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [usage, setUsage] = useState<Map<string, Usage>>(new Map());
  const [edit, setEdit] = useState<OfferRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const [o, u] = await Promise.all([
      db.from("lulu_offers").select(OFFER_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: false }),
      db.rpc("lulu_offer_usage", { p_account: accountId }),
    ]);
    if (o.error) setMsg(/text_ar|budget_sar|validity_days/.test(o.error.message) ? "Run migration 056 in Supabase." : o.error.message);
    setOffers((o.data ?? []) as unknown as OfferRow[]);
    setUsage(new Map(((u.data ?? []) as Usage[]).map((x) => [x.offer_id, x])));
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

  const save = async () => {
    if (!edit || !accountId) return;
    if (!edit.offer_code.trim() || !edit.name.trim()) return setMsg("Code and name are required.");
    const row = {
      account_id: accountId,
      offer_code: edit.offer_code.trim().toUpperCase(),
      name: edit.name.trim(),
      offer_type: edit.offer_type,
      value: Number(edit.value) || 0,
      minimum_order: Number(edit.minimum_order) || 0,
      text_ar: edit.text_ar?.trim() || null,
      text_en: edit.text_en?.trim() || null,
      validity_days: Math.max(1, Number(edit.validity_days) || 7),
      start_date: edit.start_date || null,
      end_date: edit.end_date || null,
      budget_sar: edit.budget_sar === null || edit.budget_sar === "" ? null : Number(edit.budget_sar),
      eligible_segments: edit.eligible_segments ?? [],
      eligible_stores: edit.eligible_stores ?? [],
      eligible_price_behaviour: edit.eligible_price_behaviour ?? [],
      active: edit.active,
      updated_at: new Date().toISOString(),
    };
    const db = createClient();
    const { error } = edit.id ? await db.from("lulu_offers").update(row).eq("id", edit.id) : await db.from("lulu_offers").insert(row);
    setMsg(error ? error.message : "Saved.");
    if (!error) {
      setEdit(null);
      await load();
    }
  };

  const toggle = <T extends string>(list: T[] | null, v: T) => {
    const l = list ?? [];
    return l.includes(v) ? l.filter((x) => x !== v) : [...l, v];
  };

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-xs ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`;
  const preview = edit ? offerFromRow({ ...edit, value: Number(edit.value) || 0 } as OfferRow) : null;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement/campaigns" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Offers</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Offers that win-back and VIP messages may promise. The code must already work in your checkout — this page decides who is
              offered what, until when, and stops the offer when its budget is used. Campaigns that mention an offer cannot send without a
              usable one.
            </p>
          </div>
          <button type="button" onClick={() => setEdit(blank())}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> New offer
          </button>
        </div>
      </div>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {edit && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">{edit.id ? `Edit ${edit.offer_code}` : "New offer"}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs text-muted-foreground">Code (as used at checkout)
              <input className={input} dir="ltr" value={edit.offer_code} onChange={(e) => setEdit({ ...edit, offer_code: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Name (internal)
              <input className={input} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Type
              <select className={input} value={edit.offer_type} onChange={(e) => setEdit({ ...edit, offer_type: e.target.value as OfferType })}>
                {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </label>
            {edit.offer_type !== "FREE_DELIVERY" && (
              <label className="space-y-1 text-xs text-muted-foreground">{edit.offer_type === "FIXED_VOUCHER" ? "SAR off" : "% off"}
                <input type="number" className={input} value={String(edit.value)} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
              </label>
            )}
            <label className="space-y-1 text-xs text-muted-foreground">Minimum order (SAR, info)
              <input type="number" className={input} value={String(edit.minimum_order ?? 0)} onChange={(e) => setEdit({ ...edit, minimum_order: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Valid for (days after the message)
              <input type="number" className={input} value={String(edit.validity_days ?? 7)} onChange={(e) => setEdit({ ...edit, validity_days: Number(e.target.value) })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Starts
              <input type="date" className={input} value={edit.start_date ?? ""} onChange={(e) => setEdit({ ...edit, start_date: e.target.value || null })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Ends
              <input type="date" className={input} value={edit.end_date ?? ""} onChange={(e) => setEdit({ ...edit, end_date: e.target.value || null })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Budget (SAR of discounts, empty = no limit)
              <input type="number" className={input} value={edit.budget_sar === null ? "" : String(edit.budget_sar)} onChange={(e) => setEdit({ ...edit, budget_sar: e.target.value === "" ? null : e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Arabic wording (optional)
              <input className={input} dir="rtl" placeholder={preview ? offerText({ ...preview, textAr: null }, "ar") : ""} value={edit.text_ar ?? ""} onChange={(e) => setEdit({ ...edit, text_ar: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">English wording (optional)
              <input className={input} placeholder={preview ? offerText({ ...preview, textEn: null }, "en") : ""} value={edit.text_en ?? ""} onChange={(e) => setEdit({ ...edit, text_en: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active
            </label>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div>
              Who may get it — price behaviour (recommended: not Full-price buyers, they buy without discounts):{" "}
              {BEHAVIOURS.map((b) => (
                <button key={b} type="button" className={`${chip((edit.eligible_price_behaviour ?? []).includes(b))} me-1`}
                  onClick={() => setEdit({ ...edit, eligible_price_behaviour: toggle(edit.eligible_price_behaviour, b) })}>{b}</button>
              ))}
            </div>
            <div>
              Stores (none selected = all):{" "}
              {STORES.map((s) => (
                <button key={s} type="button" className={`${chip((edit.eligible_stores ?? []).includes(s))} me-1`}
                  onClick={() => setEdit({ ...edit, eligible_stores: toggle(edit.eligible_stores, s) })}>{s}</button>
              ))}
            </div>
          </div>
          {preview && (
            <p className="rounded-lg bg-muted/50 p-3 text-sm">
              Message will say: <b>{offerText(preview, "en")}</b> / <b dir="rtl">{offerText(preview, "ar")}</b> — valid {preview.validityDays} days after sending
              {preview.endDate ? `, never after ${preview.endDate}` : ""}.
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
              <Save className="h-4 w-4" /> Save
            </button>
            <button type="button" onClick={() => setEdit(null)} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Offer</th>
              <th className="px-3 py-2 font-medium">Message wording</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Sent</th>
              <th className="px-3 py-2 text-right font-medium">Ordered</th>
              <th className="px-3 py-2 text-right font-medium">Revenue</th>
              <th className="px-3 py-2 text-right font-medium">Discounts used</th>
              <th className="px-3 py-2 font-medium">Budget</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {offers.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No offers yet.</td></tr>
            )}
            {offers.map((r) => {
              const o = offerFromRow(r);
              const u = usage.get(r.id);
              const used = Number(u?.discount_cost ?? 0);
              const why = offerBlockReason(o, new Date(), used);
              const share = o.budgetSar ? Math.min(1, used / o.budgetSar) : null;
              return (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2"><div className="font-medium text-foreground">{o.offerCode}</div><div className="text-xs text-muted-foreground">{o.name}</div></td>
                  <td className="px-3 py-2 text-xs">{offerText(o, "en")}<div dir="rtl" className="text-muted-foreground">{offerText(o, "ar")}</div></td>
                  <td className={`px-3 py-2 text-xs ${why ? "text-amber-600" : "text-emerald-600"}`}>{why ?? "usable"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{n0(u?.sends ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{n0(u?.converted ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{n0(Number(u?.revenue ?? 0))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{n0(used)}</td>
                  <td className="px-3 py-2 text-xs">
                    {o.budgetSar ? (
                      <div className="w-32">
                        <div className="h-2 rounded bg-muted"><div className={`h-2 rounded ${share! >= 1 ? "bg-red-500" : "bg-primary"}`} style={{ width: `${share! * 100}%` }} /></div>
                        <div className="mt-0.5 text-muted-foreground">SAR {n0(used)} / {n0(o.budgetSar)}</div>
                      </div>
                    ) : "no limit"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => setEdit(r)}>Edit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Discounts used = discount on orders attributed to messages that carried this offer (from the daily order sync). When it reaches the
        budget the offer stops being sent; campaigns using it are skipped until you raise the budget or attach another offer.
      </p>
    </div>
  );
}
