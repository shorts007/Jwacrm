// ============================================================
// POST /api/lulu/preview   (admin+, cookie session)   { campaign_id }
//
// Campaign preview (PRD §77) — SENDS NOTHING, WRITES NOTHING.
// Who the campaign would reach if it were LIVE now (same engine as the live queue: real send
// history, STOP list, frequency caps, priority against the campaigns already live, offer fit,
// holdout), why the others are left out, how long the daily limits make it take, and the exact
// messages a few real recipients would get.
// ============================================================
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { channelFor } from '@/lib/channels/outbound';
import { dailyLimit } from '@/lib/evolution/safety';
import { loadSafety } from '@/lib/evolution/safety-server';
import { renderTemplate } from '@/lib/evolution/render';
import {
  EXCLUSION_LABELS,
  campaignNeedsOffer,
  campaignParams,
  customerOfferReason,
  maskPhone,
  missingProducts,
  offerBlockReason,
  previewAudience,
  profileFromRow,
} from '@/lib/lulu';
import {
  campaignTemplateNames,
  chooseTemplate,
  loadActiveProfiles,
  loadApprovedTemplates,
  loadCampaign,
  loadLiveCampaigns,
  loadOfferDiscountUsed,
  loadOffers,
  loadPolicyAndSettings,
  loadSendHistory,
  promoBlockReason,
} from '@/lib/lulu/server';
import type { MessageTemplate } from '@/types';

export const maxDuration = 60;
const SAMPLES = 4;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const db = ctx.supabase;
    const accountId = ctx.accountId;
    const body = (await request.json().catch(() => null)) as { campaign_id?: unknown } | null;
    if (!body || typeof body.campaign_id !== 'string') return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 });

    const now = new Date();
    const campaign = await loadCampaign(db, accountId, body.campaign_id);
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

    const { policy, settings } = await loadPolicyAndSettings(db, accountId);
    const [live, sendHistory, rows, approved, channel] = await Promise.all([
      loadLiveCampaigns(db, accountId),
      loadSendHistory(db, accountId, now, policy),
      loadActiveProfiles(db, accountId),
      loadApprovedTemplates(db, accountId, campaignTemplateNames(campaign)),
      channelFor(accountId, { channel: 'default' }),
    ]);

    const warnings: string[] = [];
    const promoWhy = promoBlockReason(campaign, now);
    if (promoWhy) warnings.push(`Promotion: ${promoWhy}.`);
    if (!chooseTemplate(campaign, null, approved)) warnings.push('No APPROVED template is set for this campaign — it cannot send until one is.');

    let offer = null;
    if (campaignNeedsOffer(campaign.type)) {
      const [offers, used] = await Promise.all([loadOffers(db, accountId), loadOfferDiscountUsed(db, accountId)]);
      offer = campaign.offerId ? (offers.get(campaign.offerId) ?? null) : null;
      const why = offerBlockReason(offer, now, campaign.offerId ? (used.get(campaign.offerId) ?? 0) : 0);
      if (why) warnings.push(`Offer: ${why} — the campaign will not send until this is fixed.`);
    }
    const usableOffer = offer;

    const audience = previewAudience({
      rows,
      target: campaign,
      otherLive: live.filter((c) => c.id !== campaign.id),
      policy,
      now,
      ...sendHistory,
      customerCheck: usableOffer
        ? (r) =>
            customerOfferReason(usableOffer, {
              customerSegment: r.customer_segment ?? null,
              preferredStoreId: r.preferred_store_id ?? null,
              priceBehaviour: r.price_sensitivity ?? null,
            })
        : undefined,
    });

    // Pace: the account's daily cap, and the app number's (warm-up) limit when it is the sender.
    let appLimit: number | null = null;
    if (channel === 'evolution') {
      const safety = await loadSafety(accountId);
      if (safety) appLimit = dailyLimit(safety, now).limit;
    }
    const perDay = Math.max(1, Math.min(settings.dailyCap, appLimit ?? Number.MAX_SAFE_INTEGER));

    // Sample messages — a mix of Arabic / English / not-chosen customers where possible.
    const rowById = new Map(rows.map((r) => [r.customer_id, r]));
    const pool = audience.recipients.slice(0, 60).map((id) => rowById.get(id)!).filter(Boolean);
    const { data: prefs } = await db
      .from('lulu_language_prefs')
      .select('phone_digits, language')
      .eq('account_id', accountId)
      .in('phone_digits', pool.map((r) => r.mobile.replace(/\D/g, '')));
    const prefOf = new Map((prefs ?? []).map((p) => [p.phone_digits as string, p.language as string]));
    const pref = (mobile: string) => {
      const l = prefOf.get(mobile.replace(/\D/g, ''));
      return l === 'ar' || l === 'en' ? l : null;
    };
    const picked: typeof pool = [];
    for (const want of ['ar', 'en', null] as const) {
      const hit = pool.find((r) => !picked.includes(r) && pref(r.mobile) === want);
      if (hit) picked.push(hit);
    }
    for (const r of pool) if (picked.length < SAMPLES && !picked.includes(r)) picked.push(r);

    const names = campaignTemplateNames(campaign);
    const { data: tplRows } = names.length
      ? await db.from('message_templates').select('*').eq('account_id', accountId).in('name', names)
      : { data: [] };
    const templateRow = (name: string, language: string) =>
      ((tplRows ?? []) as MessageTemplate[]).find((t) => t.name === name && t.language === language) ??
      ((tplRows ?? []) as MessageTemplate[]).find((t) => t.name === name) ??
      null;

    const samples = picked.slice(0, SAMPLES).map((r) => {
      const profile = profileFromRow(r);
      const language = pref(r.mobile);
      const base = { name: r.name ?? '—', phone: maskPhone(r.mobile), languageChoice: language ?? 'not chosen' };
      const choice = chooseTemplate(campaign, language, approved);
      if (!choice) return { ...base, error: 'no approved template for this customer' };
      const params = campaignParams(choice.kind, campaign, profile, usableOffer, now);
      if (missingProducts(campaign.type, params)) return { ...base, error: 'skipped at send time: no products to name' };
      try {
        const rendered = renderTemplate(
          templateRow(choice.template.name, choice.template.language),
          { body: params.slice(0, choice.template.varCount), ...(campaign.type === 'NEW_OFFER' && campaign.promoImageUrl ? { headerMediaUrl: campaign.promoImageUrl } : {}) },
        );
        return { ...base, template: `${choice.template.name} (${choice.template.language})`, text: rendered.text, image: rendered.media?.kind === 'image' ? rendered.media.url : null };
      } catch (e) {
        return { ...base, error: e instanceof Error ? e.message : String(e) };
      }
    });

    return NextResponse.json({
      campaign: { name: campaign.name, code: campaign.code, mode: campaign.mode, status: campaign.status, active: campaign.active },
      counts: {
        customers: rows.length,
        matched: audience.matched,
        recipients: audience.recipients.length,
        holdout: audience.holdout,
        suspects: audience.suspects,
      },
      exclusions: Object.entries(audience.exclusions)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, label: EXCLUSION_LABELS[reason] ?? reason.replace(/_/g, ' '), count })),
      pacing: {
        channel,
        dailyCap: settings.dailyCap,
        appLimit,
        perDay,
        days: Math.ceil(audience.recipients.length / perDay),
        sharedWith: live.filter((c) => c.id !== campaign.id).map((c) => c.name),
      },
      samples,
      warnings,
      note: 'Preview only — nothing was sent or saved. Counts are for today; customers move in and out as they order.',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
