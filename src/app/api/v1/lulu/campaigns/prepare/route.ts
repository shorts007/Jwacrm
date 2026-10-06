// ============================================================
// POST /api/v1/lulu/campaigns/prepare   (scope: messages:send)
//
// Builds TODAY's send queue for LIVE campaigns (Live switch on + mode LIVE,
// not paused): runs the next-best-action engine over every active customer,
// applies STOP list / frequency caps / already-received / daily cap, and
// inserts SCHEDULED actions (idempotent per campaign + customer + day).
// Sends nothing — /send-next does, one message per call, paced.
// Returns { queued, first_wait_seconds, … } or { queued: 0, blocked: [reasons] }.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isHoldout } from '@/lib/lulu/attribution';
import { campaignNeedsOffer, customerOfferReason, offerBlockReason } from '@/lib/lulu/offers';
import { gapBeforeNext, planSends, riyadhDayStart, totalDuration } from '@/lib/lulu/sender';
import {
  campaignTemplateNames,
  chooseTemplate,
  liveGates,
  loadActiveProfiles,
  loadOfferDiscountUsed,
  loadOffers,
  loadApprovedTemplates,
  loadLiveCampaigns,
  loadPolicyAndSettings,
  promoBlockReason,
} from '@/lib/lulu/server';
import type { PastSend } from '@/lib/lulu/types';

export const maxDuration = 60;
const DAY = 86_400_000;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const db = ctx.supabase;
    const accountId = ctx.accountId;
    const now = new Date();

    // Global gates stop everything; per-campaign problems only drop that campaign.
    const blocked = await liveGates(db, accountId, now);
    if (blocked.length) return ok({ queued: 0, blocked });
    const live = await loadLiveCampaigns(db, accountId);
    if (live.length === 0) return ok({ queued: 0, blocked: ['No campaign is LIVE (Live switch on + mode LIVE).'] });

    const warnings: string[] = [];
    const approved = await loadApprovedTemplates(db, accountId, live.flatMap(campaignTemplateNames));
    const needOffer = live.some((c) => campaignNeedsOffer(c.type));
    const [offers, offerUsed] = needOffer
      ? await Promise.all([loadOffers(db, accountId), loadOfferDiscountUsed(db, accountId)])
      : [new Map(), new Map<string, number>()];
    const sendable = live.filter((c) => {
      if (!chooseTemplate(c, null, approved)) {
        warnings.push(`${c.code}: no APPROVED template set.`);
        return false;
      }
      const promoWhy = promoBlockReason(c, now);
      if (promoWhy) {
        warnings.push(`${c.code}: ${promoWhy} — campaign skipped.`);
        return false;
      }
      if (campaignNeedsOffer(c.type)) {
        const reason = offerBlockReason(c.offerId ? offers.get(c.offerId) : null, now, c.offerId ? (offerUsed.get(c.offerId) ?? 0) : 0);
        if (reason) {
          warnings.push(`${c.code}: ${reason} — campaign skipped (its message promises an offer).`);
          return false;
        }
      }
      return true;
    });
    if (sendable.length === 0) return ok({ queued: 0, blocked: warnings });

    const { policy, settings } = await loadPolicyAndSettings(db, accountId);
    const dayStart = riyadhDayStart(now).toISOString();

    const [today, recent, allCampaigns, stops, rows] = await Promise.all([
      db.from('lulu_customer_next_actions').select('customer_id, status')
        .eq('account_id', accountId).eq('is_test', false).gte('created_at', dayStart).range(0, 9999),
      db.from('lulu_customer_next_actions').select('customer_id, campaign_id, sent_at, status, created_at')
        .eq('account_id', accountId).eq('is_test', false)
        .or('status.eq.SENT,skip_reason.eq.holdout')
        .gte('created_at', new Date(now.getTime() - 60 * DAY).toISOString()).range(0, 49999),
      db.from('lulu_campaigns').select('id, campaign_code').eq('account_id', accountId),
      db.from('lulu_opt_outs').select('phone_digits').eq('account_id', accountId).range(0, 99999),
      loadActiveProfiles(db, accountId),
    ]);
    for (const r of [today, recent, allCampaigns, stops]) if (r.error) throw r.error;

    const used = (today.data ?? []).filter((a) => ['SCHEDULED', 'SENDING', 'SENT'].includes(a.status as string)).length;
    const remainingCap = settings.dailyCap - used;
    if (remainingCap <= 0) return ok({ queued: 0, blocked: [`Daily cap of ${settings.dailyCap} already used today.`] });

    const codeById = new Map((allCampaigns.data ?? []).map((c) => [c.id as string, c.campaign_code as string]));
    const history = new Map<string, PastSend[]>();
    const receivedCodes = new Map<string, Set<string>>();
    const windowStart = now.getTime() - Math.max(policy.promoWindowDays, policy.marketingWindowDays) * DAY;
    for (const a of recent.data ?? []) {
      const cid = a.customer_id as string;
      // Holdout customers count as "received" so they stay out of the campaign (clean control group),
      // but they do not count towards frequency caps — they were never messaged.
      const sentAt = new Date((a.sent_at ?? a.created_at) as string);
      if (a.status === 'SENT' && sentAt.getTime() >= windowStart) {
        if (!history.has(cid)) history.set(cid, []);
        history.get(cid)!.push({ sentAt, isPromo: true });
      }
      const code = codeById.get(a.campaign_id as string);
      if (code) {
        if (!receivedCodes.has(cid)) receivedCodes.set(cid, new Set());
        receivedCodes.get(cid)!.add(code);
      }
    }

    const plan = planSends({
      rows,
      liveCampaigns: sendable,
      policy,
      now,
      // Plan beyond the cap: holdout customers are recorded but don't use a send slot.
      remainingCap: remainingCap * 2 + 20,
      history,
      receivedCodes,
      stopDigits: new Set((stops.data ?? []).map((s) => s.phone_digits as string)),
      alreadyQueuedToday: new Set((today.data ?? []).map((a) => a.customer_id as string)),
    });

    const endOfDay = new Date(riyadhDayStart(now).getTime() + DAY).toISOString();
    const pctById = new Map(sendable.map((c) => [c.id, c.holdoutPct]));
    const campaignById = new Map(sendable.map((c) => [c.id, c]));
    const rowById = new Map(rows.map((r) => [r.customer_id, r]));
    const inserts: Record<string, unknown>[] = [];
    let toSend = 0;
    let holdouts = 0;
    for (const p of plan.planned) {
      // Offer eligibility (segment / store / price behaviour) for campaigns that carry an offer.
      const camp = campaignById.get(p.campaignId);
      if (camp && campaignNeedsOffer(camp.type) && camp.offerId) {
        const offer = offers.get(camp.offerId);
        const row = rowById.get(p.customerId);
        const why = offer && row
          ? customerOfferReason(offer, {
              customerSegment: row.customer_segment ?? null,
              preferredStoreId: row.preferred_store_id ?? null,
              priceBehaviour: row.price_sensitivity ?? null,
            })
          : 'offer_missing';
        if (why) {
          plan.skipped[why] = (plan.skipped[why] ?? 0) + 1;
          continue;
        }
      }
      const holdout = isHoldout(p.customerId, p.campaignCode, pctById.get(p.campaignId) ?? 0);
      if (!holdout && toSend >= remainingCap) break;
      if (holdout) holdouts++;
      else toSend++;
      inserts.push({
        account_id: accountId,
        customer_id: p.customerId,
        campaign_id: p.campaignId,
        offer_id: p.offerId,
        action_type: p.campaignType,
        reason: p.reason,
        language: p.language,
        priority: inserts.length + 1,
        idempotency_key: p.idempotencyKey,
        status: holdout ? 'SKIPPED' : 'SCHEDULED',
        skip_reason: holdout ? 'holdout' : null,
        finished_at: holdout ? now.toISOString() : null,
        is_test: false,
        expires_at: endOfDay,
      });
    }
    let queued = 0;
    for (let i = 0; i < inserts.length; i += 500) {
      const { data, error } = await db
        .from('lulu_customer_next_actions')
        .upsert(inserts.slice(i, i + 500), { onConflict: 'account_id,idempotency_key', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      queued += data?.length ?? 0;
    }

    const sentToday = (today.data ?? []).filter((a) => a.status === 'SENT').length;
    return ok({
      queued: toSend,
      inserted: queued,
      holdout: holdouts,
      cap: settings.dailyCap,
      used_before: used,
      evaluated: plan.evaluated,
      skipped: plan.skipped,
      warnings,
      first_wait_seconds: gapBeforeNext(sentToday, settings),
      estimated_minutes: Math.round(totalDuration(toSend, settings) / 60),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
