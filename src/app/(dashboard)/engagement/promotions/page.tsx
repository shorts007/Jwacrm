"use client";

// Image promotions (PRD §41): paste a product image, write the offer in Arabic + English,
// pick the audience, preview, then test and send through the normal paced sender.

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ImagePlus, Loader2, Plus, Save } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { DEFAULT_TEMPLATE_NAMES, PROMO_TEXT_MAX, cleanVariable, formatExpiry, type PromoAudience } from "@/lib/lulu";

interface PromoRow {
  id: string;
  campaign_code: string;
  name: string;
  mode: string;
  status: string;
  active: boolean;
  promo_image_url: string | null;
  promo_text_ar: string | null;
  promo_text_en: string | null;
  promo_valid_until: string | null;
  rule_params: { audience?: PromoAudience } | null;
}

interface Draft {
  id: string | null;
  name: string;
  image: string | null;
  textAr: string;
  textEn: string;
  validUntil: string;
  audience: PromoAudience;
}

const STAGES: { v: NonNullable<PromoAudience["stages"]>[number]; label: string }[] = [
  { v: "ACTIVE", label: "Active" },
  { v: "NEW", label: "New / first order" },
  { v: "AT_RISK", label: "At risk" },
  { v: "DORMANT", label: "Dormant" },
  { v: "LOST", label: "Lost" },
];
const BEHAVIOURS = ["Offer-driven", "Mixed", "Full-price", "Unknown"];
const STORES = ["3805", "3806", "3808", "3809", "3810", "3814", "3818", "3821"];
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const blank = (): Draft => ({ id: null, name: "", image: null, textAr: "", textEn: "", validUntil: inDays(7), audience: {} });

export default function PromotionsPage() {
  const { accountId } = useAuth();
  const [promos, setPromos] = useState<PromoRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imageLink, setImageLink] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await createClient()
      .from("lulu_campaigns")
      .select("id, campaign_code, name, mode, status, active, promo_image_url, promo_text_ar, promo_text_en, promo_valid_until, rule_params")
      .eq("account_id", accountId)
      .eq("campaign_type", "NEW_OFFER")
      .order("created_at", { ascending: false });
    if (error) setMsg(/promo_/.test(error.message) ? "Run migration 057 in Supabase." : error.message);
    setPromos((data ?? []) as PromoRow[]);
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

  // Live audience estimate (before frequency caps, STOP list, holdout and the daily cap).
  useEffect(() => {
    if (!draft || !accountId) return;
    const a = draft.audience;
    let q = createClient()
      .from("lulu_customer_profiles")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("active", true)
      .eq("marketing_opt_in", true)
      .is("suspect_reason", null);
    if (a.stages?.length) q = q.in("lifecycle_stage", a.stages.flatMap((s) => (s === "NEW" ? ["NEW", "FIRST_ORDER"] : [s])));
    if (a.priceBehaviour?.length) {
      const named = a.priceBehaviour.filter((b) => b !== "Unknown");
      const parts = [named.length ? `price_sensitivity.in.(${named.map((b) => `"${b}"`).join(",")})` : null, a.priceBehaviour.includes("Unknown") ? "price_sensitivity.is.null" : null].filter(Boolean);
      q = q.or(parts.join(","));
    }
    if (a.stores?.length) q = q.in("preferred_store_id", a.stores.map(Number));
    if (a.vipOnly) q = q.eq("vip_flag", true);
    if (a.minOrders) q = q.gte("total_orders", a.minOrders);
    if (a.orderedWithinDays) q = q.gte("last_order_date", inDays(-a.orderedWithinDays));
    let cancelled = false;
    void q.then(({ count }) => {
      if (!cancelled) setEstimate(count ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, [draft, accountId]);

  const upload = async (file: File | null | undefined) => {
    if (!file || !draft || !accountId) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) return setMsg("Use a PNG or JPEG image.");
    if (file.size > 5 * 1024 * 1024) return setMsg("Image must be under 5 MB (WhatsApp limit).");
    setUploading(true);
    const path = `account-${accountId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${file.type === "image/png" ? "png" : "jpg"}`;
    const db = createClient();
    const { error } = await db.storage.from("lulu-promos").upload(path, file, { contentType: file.type, upsert: false });
    setUploading(false);
    if (error) return setMsg(/bucket/i.test(error.message) ? "Run migration 057 in Supabase (image bucket)." : error.message);
    const { data } = db.storage.from("lulu-promos").getPublicUrl(path);
    setDraft({ ...draft, image: data.publicUrl });
    setMsg(null);
  };

  // An image already stored online (Supabase, S3, Cloudinary, a website…). WhatsApp downloads it
  // at send time, so it must be a direct, public PNG/JPEG link — checked by loading it here.
  const applyImageLink = (raw: string) => {
    if (!draft) return;
    let url = raw.trim();
    if (!url) return;
    // Common share links → direct image links.
    const drive = /drive\.google\.com\/file\/d\/([^/]+)/.exec(url) ?? /drive\.google\.com\/open\?id=([^&]+)/.exec(url);
    if (drive) url = `https://drive.google.com/uc?export=view&id=${drive[1]}`;
    if (/dropbox\.com\//.test(url)) url = url.replace(/([?&])dl=0/, "$1raw=1");
    if (!/^https:\/\//i.test(url)) return setMsg("The image link must start with https:// and be publicly reachable.");
    setUploading(true);
    const img = new Image();
    img.onload = () => {
      setUploading(false);
      setDraft((d) => (d ? { ...d, image: url } : d));
      setImageLink("");
      setMsg(
        /\.(png|jpe?g)(\?|$)/i.test(url)
          ? null
          : "Image link added. WhatsApp only accepts PNG or JPEG (max 5 MB) — send a test to be sure it arrives."
      );
    };
    img.onerror = () => {
      setUploading(false);
      setMsg("That link did not open as an image. Use a direct, public link to a PNG or JPEG (not a web page or a private file).");
    };
    img.src = url;
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    if (item) {
      e.preventDefault();
      void upload(item.getAsFile());
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void upload(e.dataTransfer.files?.[0]);
  };

  const save = async () => {
    if (!draft || !accountId) return;
    if (!draft.name.trim()) return setMsg("Give the promotion a name.");
    if (!draft.image) return setMsg("Add a product image.");
    if (!draft.textAr.trim() || !draft.textEn.trim()) return setMsg("Write the offer in Arabic and English.");
    const names = DEFAULT_TEMPLATE_NAMES.NEW_OFFER!;
    const row = {
      account_id: accountId,
      name: draft.name.trim(),
      campaign_type: "NEW_OFFER",
      rule_params: { audience: draft.audience },
      priority: 90,
      promo_image_url: draft.image,
      promo_text_ar: cleanVariable(draft.textAr).slice(0, PROMO_TEXT_MAX),
      promo_text_en: cleanVariable(draft.textEn).slice(0, PROMO_TEXT_MAX),
      promo_valid_until: draft.validUntil,
      end_date: draft.validUntil,
      template_name_ar: names.ar,
      template_name_en: names.en,
      template_name_bilingual: names.bi,
    };
    const db = createClient();
    const { error } = draft.id
      ? await db.from("lulu_campaigns").update(row).eq("id", draft.id)
      : await db.from("lulu_campaigns").insert({
          ...row,
          campaign_code: `PROMO_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          active: false,
          mode: "DRY_RUN",
          status: "DRAFT",
        });
    setMsg(error ? error.message : "Saved. Test it from Campaigns → Step 2, then Make LIVE in Step 3.");
    if (!error) {
      setDraft(null);
      await load();
    }
  };

  const toggle = (list: string[] | undefined, v: string) => {
    const l = list ?? [];
    return l.includes(v) ? l.filter((x) => x !== v) : [...l, v];
  };
  const chip = (on: boolean) => `me-1 mb-1 rounded-full border px-2 py-0.5 text-xs ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`;
  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement/campaigns" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Promotions</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Product-image offers. Paste or drop the image, write the offer once in Arabic and English, choose who gets it. It is sent with the
              approved image templates (the image changes per promotion — no new Meta approval needed) through the same paced sender and
              daily cap, after the lifecycle campaigns.
            </p>
          </div>
          <button type="button" onClick={() => { setDraft(blank()); setEstimate(null); }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> New promotion
          </button>
        </div>
      </div>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {draft && (
        <div className="grid gap-6 rounded-xl border border-border bg-card p-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            <label className="block space-y-1 text-xs text-muted-foreground">Name (internal)
              <input className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Fresh fruit week" />
            </label>
            <div
              tabIndex={0}
              onPaste={onPaste}
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-4 text-center text-sm text-muted-foreground outline-none focus:border-primary"
            >
              {uploading ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
              <span>Click here, then <b>paste</b> (Ctrl/⌘+V) a product image — or drop / choose a PNG or JPEG (max 5 MB).</span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                …or paste a link to an image that is already stored online
                <input
                  className={input}
                  dir="ltr"
                  inputMode="url"
                  placeholder="https://…/product.jpg"
                  value={imageLink}
                  onChange={(e) => setImageLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyImageLink(imageLink);
                    }
                  }}
                />
              </label>
              <button
                type="button"
                disabled={uploading || !imageLink.trim()}
                onClick={() => applyImageLink(imageLink)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50"
              >
                Use link
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">Offer text — Arabic ({draft.textAr.length}/{PROMO_TEXT_MAX})
                <textarea dir="rtl" rows={3} maxLength={PROMO_TEXT_MAX} className={input} value={draft.textAr} onChange={(e) => setDraft({ ...draft, textAr: e.target.value })} placeholder="خصم 20% على جميع الفواكه الطازجة هذا الأسبوع." />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">Offer text — English ({draft.textEn.length}/{PROMO_TEXT_MAX})
                <textarea rows={3} maxLength={PROMO_TEXT_MAX} className={input} value={draft.textEn} onChange={(e) => setDraft({ ...draft, textEn: e.target.value })} placeholder="20% off all fresh fruit this week." />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">Valid until (last send day)
                <input type="date" className={input} value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">Line breaks are turned into spaces (WhatsApp rule for template text). Write one short paragraph.</p>

            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">Audience</div>
              <div>Lifecycle:{" "}
                {STAGES.map((s) => (
                  <button key={s.v} type="button" className={chip(!!draft.audience.stages?.includes(s.v))}
                    onClick={() => setDraft({ ...draft, audience: { ...draft.audience, stages: toggle(draft.audience.stages, s.v) as PromoAudience["stages"] } })}>{s.label}</button>
                ))}
              </div>
              <div>Price behaviour:{" "}
                {BEHAVIOURS.map((b) => (
                  <button key={b} type="button" className={chip(!!draft.audience.priceBehaviour?.includes(b))}
                    onClick={() => setDraft({ ...draft, audience: { ...draft.audience, priceBehaviour: toggle(draft.audience.priceBehaviour, b) } })}>{b}</button>
                ))}
              </div>
              <div>Preferred store:{" "}
                {STORES.map((s) => (
                  <button key={s} type="button" className={chip(!!draft.audience.stores?.includes(s))}
                    onClick={() => setDraft({ ...draft, audience: { ...draft.audience, stores: toggle(draft.audience.stores, s) } })}>{s}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!draft.audience.vipOnly}
                  onChange={(e) => setDraft({ ...draft, audience: { ...draft.audience, vipOnly: e.target.checked } })} /> VIP only</label>
                <label className="flex items-center gap-1">Min. orders
                  <input type="number" min={0} className="w-16 rounded border border-border bg-background px-1" value={draft.audience.minOrders ?? ""}
                    onChange={(e) => setDraft({ ...draft, audience: { ...draft.audience, minOrders: Number(e.target.value) || undefined } })} /></label>
                <label className="flex items-center gap-1">Ordered in the last
                  <input type="number" min={0} className="w-16 rounded border border-border bg-background px-1" value={draft.audience.orderedWithinDays ?? ""}
                    onChange={(e) => setDraft({ ...draft, audience: { ...draft.audience, orderedWithinDays: Number(e.target.value) || undefined } })} /> days</label>
              </div>
              <p className="text-sm text-foreground">
                ≈ <b>{estimate === null ? "…" : estimate.toLocaleString("en-US")}</b> opted-in customers match. Sending is limited by the daily cap,
                frequency limits, the STOP list and a 10% control group; lifecycle campaigns go first.
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Save className="h-4 w-4" /> Save promotion</button>
              <button type="button" onClick={() => setDraft(null)} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted">Cancel</button>
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs text-muted-foreground">Preview (no language chosen yet → both languages)</div>
            <div className="overflow-hidden rounded-xl bg-[#e7ffdb] text-sm text-neutral-900 shadow dark:bg-[#1f3b2d] dark:text-neutral-100">
              {draft.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.image} alt="Promotion" className="aspect-[1.91/1] w-full object-cover" />
              ) : (
                <div className="flex aspect-[1.91/1] w-full items-center justify-center bg-black/5 text-xs">product image</div>
              )}
              <div className="space-y-2 p-3">
                <p dir="rtl">مرحباً أحمد، لدينا عرض خاص لك: {cleanVariable(draft.textAr) || "…"} العرض ساري حتى {formatExpiry(draft.validUntil, "ar")}. اطلب الآن!</p>
                <p>Hi Ahmed, we have a special offer for you: {cleanVariable(draft.textEn) || "…"} Valid until {formatExpiry(draft.validUntil, "en")}. Order now!</p>
                <p className="text-xs opacity-60">Reply STOP to opt out | للإلغاء أرسل STOP</p>
              </div>
              <div className="grid grid-cols-2 border-t border-black/10 text-center text-xs text-sky-700 dark:text-sky-300">
                <div className="py-2">العربية</div>
                <div className="border-s border-black/10 py-2">English</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {promos.length === 0 && !draft && <p className="text-sm text-muted-foreground">No promotions yet.</p>}
        {promos.map((p) => (
          <div key={p.id} className="overflow-hidden rounded-xl border border-border bg-card">
            {p.promo_image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.promo_image_url} alt={p.name} className="aspect-[1.91/1] w-full object-cover" />
            )}
            <div className="space-y-1 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className={`text-xs ${p.mode === "LIVE" ? "text-emerald-600" : "text-muted-foreground"}`}>{p.mode} · {p.status}</span>
              </div>
              <p className="text-xs text-muted-foreground">{p.promo_text_en}</p>
              <p className="text-xs text-muted-foreground">Valid until {p.promo_valid_until ?? "—"} · {p.campaign_code}</p>
              <button type="button" className="mt-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => { setEstimate(null); setDraft({ id: p.id, name: p.name, image: p.promo_image_url, textAr: p.promo_text_ar ?? "", textEn: p.promo_text_en ?? "", validUntil: p.promo_valid_until ?? inDays(7), audience: p.rule_params?.audience ?? {} }); }}>
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
