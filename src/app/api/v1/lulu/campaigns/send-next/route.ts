// ============================================================
// POST /api/v1/lulu/campaigns/send-next   (scope: messages:send)
//
// Sends AT MOST ONE queued customer message, then tells the caller how long
// to wait before calling again: 60 s, 61 s, 62 s … (base + increment × sent).
// Safe to call from several runners: the action is claimed atomically
// (SCHEDULED → SENDING) and spacing is enforced server-side too.
//
// Re-checks just before sending: quiet hours, data freshness + STOP handling,
// campaign still LIVE, customer still eligible (opt-out, suspect, ordered
// since queued, frequency), approved template. Auto-pauses every LIVE
// campaign on Meta rate-limit / block errors or 5 failures in a row.
//
// Response: { sent, done, remaining, next_wait_seconds, status?, reason? }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isQuietNow } from '@/lib/lulu/contact-policy';
import { profileFromRow, type DryRunProfileRow } from '@/lib/lulu/dry-run';
import { buildParamsForKind } from '@/lib/lulu/messages';
import { campaignNeedsOffer, customerOfferReason, offerBlockReason, offerExpiry, offerText, type Offer } from '@/lib/lulu/offers';
import { decideNextBestAction } from '@/lib/lulu/next-best-action';
import { gapBeforeNext, isPauseWorthyError, riyadhDayStart } from '@/lib/lulu/sender';
import {
  PROFILE_COLUMNS,
  campaignTemplateNames,
  chooseTemplate,
  loadLanguagePreference,
  loadOfferDiscountUsed,
  loadOffers,
  liveGates,
  loadApprovedTemplates,
  loadLiveCampaigns,
  loadPolicyAndSettings,
  promoBlockReason,
} from '@/lib/lulu/server';
import type { PastSend } from '@/lib/lulu/types';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

export const maxDuration = 60;
const DAY = 86_400_000;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const db = ctx.supabase;
    const accountId = ctx.accountId;
    const now = new Date();
    const dayStart = riyadhDayStart(now).toISOString();

    const { policy, settings } = await loadPolicyAndSettings(db, accountId);
    const todayQ = () =>
      db.from('lulu_customer_next_actions').select('id', { count: 'exact', head: true })
        .eq('account_id', accountId).eq('is_test', false).gte('created_at', dayStart);
    const remainingCount = async () => (await todayQ().eq('status', 'SCHEDULED')).count ?? 0;

    if (isQuietNow(policy, now)) {
      return ok({ sent: 0, done: true, remaining: await remainingCount(), reason: 'quiet hours — no customer messages now' });
    }
    const gates = await liveGates(db, accountId, now);
    if (gates.length) return ok({ sent: 0, done: true, remaining: await remainingCount(), reason: gates.join(' ') });

    // Daily cap + server-side spacing.
    const { data: sentRows } = await db
      .from('lulu_customer_next_actions').select('sent_at')
      .eq('account_id', accountId).eq('is_test', false).eq('status', 'SENT').gte('created_at', dayStart)
      .order('sent_at', { ascending: false }).range(0, 9999);
    const sentToday = sentRows?.length ?? 0;
    if (sentToday >= settings.dailyCap) {
      await db.from('lulu_customer_next_actions')
        .update({ status: 'CANCELLED', skip_reason: 'daily_cap' })
        .eq('account_id', accountId).eq('is_test', false).eq('status', 'SCHEDULED').gte('created_at', dayStart);
      return ok({ sent: 0, done: true, remaining: 0, reason: `daily cap of ${settings.dailyCap} reached` });
    }
    const lastSentAt = sentRows?.[0]?.sent_at ? new Date(sentRows[0].sent_at as string).getTime() : null;
    const requiredGap = gapBeforeNext(sentToday, settings);
    if (lastSentAt !== null) {
      const waited = (now.getTime() - lastSentAt) / 1000;
      if (waited < requiredGap - 2) {
        return ok({ sent: 0, done: false, remaining: await remainingCount(), next_wait_seconds: Math.ceil(requiredGap - waited), reason: 'too early' });
      }
    }

    // Claim the next scheduled action atomically.
    const { data: nextRows } = await db
      .from('lulu_customer_next_actions').select('id')
      .eq('account_id', accountId).eq('is_test', false).eq('status', 'SCHEDULED').gte('created_at', dayStart)
      .order('priority').order('created_at').limit(1);
    const nextId = nextRows?.[0]?.id as string | undefined;
    if (!nextId) return ok({ sent: 0, done: true, remaining: 0 });

    const { data: claimed } = await db
      .from('lulu_customer_next_actions')
      .update({ status: 'SENDING', attempts: 1 })
      .eq('id', nextId).eq('status', 'SCHEDULED')
      .select('id, customer_id, campaign_id, offer_id, language')
      .maybeSingle();
    if (!claimed) return ok({ sent: 0, done: false, remaining: await remainingCount(), next_wait_seconds: 3, reason: 'claimed by another runner' });

    const finish = async (status: 'SENT' | 'FAILED' | 'CANCELLED', extra: Record<string, unknown>) => {
      await db.from('lulu_customer_next_actions').update({ status, finished_at: new Date().toISOString(), ...extra }).eq('id', claimed.id);
    };
    const skip = async (reason: string) => {
      await finish('CANCELLED', { skip_reason: reason });
      return ok({ sent: 0, done: false, remaining: await remainingCount(), next_wait_seconds: 1, status: 'CANCELLED', reason });
    };

    const live = await loadLiveCampaigns(db, accountId);
    const campaign = live.find((c) => c.id === claimed.campaign_id);
    if (!campaign) return skip('campaign is no longer live');

    const { data: prow } = await db
      .from('lulu_customer_profiles').select(PROFILE_COLUMNS)
      .eq('account_id', accountId).eq('customer_id', claimed.customer_id).eq('active', true).maybeSingle();
    if (!prow) return skip('customer no longer in the active base');
    const row = prow as unknown as DryRunProfileRow;
    const digits = row.mobile.replace(/\D/g, '');
    const { data: stop } = await db.from('lulu_opt_outs').select('phone_digits')
      .eq('account_id', accountId).eq('phone_digits', digits).maybeSingle();
    if (stop) return skip('opted_out');

    // Re-run the engine for this one campaign with real history (catches orders since queuing, caps, opt-out, suspects).
    const { data: hist } = await db
      .from('lulu_customer_next_actions').select('sent_at, campaign_id')
      .eq('account_id', accountId).eq('is_test', false).eq('status', 'SENT').eq('customer_id', claimed.customer_id)
      .gte('sent_at', new Date(now.getTime() - 60 * DAY).toISOString());
    const windowStart = now.getTime() - Math.max(policy.promoWindowDays, policy.marketingWindowDays) * DAY;
    const history: PastSend[] = (hist ?? [])
      .map((h) => ({ sentAt: new Date(h.sent_at as string), isPromo: true }))
      .filter((h) => h.sentAt.getTime() >= windowStart);
    const received = new Set((hist ?? []).filter((h) => h.campaign_id === campaign.id).map(() => campaign.code));
    const profile = profileFromRow(row);
    const decision = decideNextBestAction({
      profile,
      campaigns: [campaign],
      policy,
      history,
      now,
      lastOrderAt: row.last_order_date ? new Date(`${row.last_order_date}T23:59:59+03:00`) : null,
      receivedCampaignCodes: received,
    });
    if (!decision.action) return skip(decision.skipped[0]?.reason ?? 'no longer eligible');

    const promoWhy = promoBlockReason(campaign, now);
    if (promoWhy) return skip(promoWhy);

    // Offer campaigns: the offer must still be usable (active, in date, budget left) and fit this customer.
    let offer: Offer | null = null;
    if (campaignNeedsOffer(campaign.type)) {
      const [offers, used] = await Promise.all([loadOffers(db, accountId), loadOfferDiscountUsed(db, accountId)]);
      offer = campaign.offerId ? (offers.get(campaign.offerId) ?? null) : null;
      const why = offerBlockReason(offer, now, campaign.offerId ? (used.get(campaign.offerId) ?? 0) : 0);
      if (why) return skip(why);
      const custWhy = customerOfferReason(offer!, {
        customerSegment: row.customer_segment ?? null,
        preferredStoreId: row.preferred_store_id ?? null,
        priceBehaviour: row.price_sensitivity ?? null,
      });
      if (custWhy) return skip(custWhy);
    }

    const approved = await loadApprovedTemplates(db, accountId, campaignTemplateNames(campaign));
    const preference = await loadLanguagePreference(db, accountId, digits);
    const choice = chooseTemplate(campaign, preference, approved);
    if (!choice) {
      await finish('FAILED', { last_error: 'no approved template' });
      return ok({ sent: 0, done: false, remaining: await remainingCount(), next_wait_seconds: 1, status: 'FAILED', reason: 'no approved template' });
    }
    const template = choice.template;
    const isPromo = campaign.type === 'NEW_OFFER';
    const expiryDate = isPromo
      ? campaign.promoValidUntil!
      : offer
        ? offerExpiry(offer, now)
        : new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10);
    // No language chosen yet → bilingual template (AR block + EN block, with العربية / English buttons).
    const wanted = buildParamsForKind(choice.kind, campaign.type, {
      name: profile.name,
      expiryDate,
      offer: offer ? { ar: offerText(offer, 'ar'), en: offerText(offer, 'en') } : null,
      promo: isPromo ? { ar: campaign.promoTextAr ?? '', en: campaign.promoTextEn ?? '' } : null,
    });
    if (template.varCount > wanted.length) {
      await finish('FAILED', { last_error: `template ${template.name} needs ${template.varCount} variables` });
      return ok({ sent: 0, done: false, remaining: await remainingCount(), next_wait_seconds: 1, status: 'FAILED', reason: 'template variable mismatch' });
    }
    const params = wanted.slice(0, template.varCount);

    try {
      const conv = await resolveConversationByPhone(db, accountId, profile.mobile, profile.name ?? undefined);
      const sent = await sendMessageToConversation(db, accountId, {
        conversationId: conv.conversationId,
        messageType: 'template',
        templateName: template.name,
        templateLanguage: template.language,
        templateParams: params,
        // Promotions: this promotion's own image replaces the template's sample header image.
        templateMessageParams: isPromo ? { body: params, headerMediaUrl: campaign.promoImageUrl! } : undefined,
      });
      await finish('SENT', {
        sent_at: new Date().toISOString(),
        wa_message_id: sent.whatsappMessageId,
        recipient: profile.mobile,
        template_name: template.name,
        template_language: template.language,
        template_params: params,
        offer_id: offer?.id ?? claimed.offer_id,
      });
      await db.from('lulu_campaign_events').insert({
        account_id: accountId, action_id: claimed.id, campaign_id: campaign.id, customer_id: claimed.customer_id,
        offer_id: offer?.id ?? claimed.offer_id, wa_message_id: sent.whatsappMessageId, event_type: 'SENT',
      });
      const remaining = await remainingCount();
      return ok({ sent: 1, done: remaining === 0, remaining, status: 'SENT', next_wait_seconds: gapBeforeNext(sentToday + 1, settings) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finish('FAILED', { last_error: message.slice(0, 500) });
      await db.from('lulu_campaign_events').insert({
        account_id: accountId, action_id: claimed.id, campaign_id: campaign.id, customer_id: claimed.customer_id,
        event_type: 'FAILED', meta: { error: message.slice(0, 300) },
      });

      // Auto-pause: Meta throttling/blocking, or 5 failures in a row today.
      const { data: last5 } = await db
        .from('lulu_customer_next_actions').select('status')
        .eq('account_id', accountId).eq('is_test', false).gte('created_at', dayStart).in('status', ['SENT', 'FAILED'])
        .order('finished_at', { ascending: false, nullsFirst: false }).limit(5);
      const fiveFailed = (last5?.length ?? 0) === 5 && last5!.every((r) => r.status === 'FAILED');
      if (isPauseWorthyError(message) || fiveFailed) {
        await db.from('lulu_campaigns').update({ status: 'PAUSED' }).eq('account_id', accountId).eq('mode', 'LIVE').eq('active', true);
        return ok({ sent: 0, done: true, paused: true, remaining: await remainingCount(), status: 'FAILED', reason: `auto-paused: ${message.slice(0, 200)}` });
      }
      return ok({ sent: 0, done: false, remaining: await remainingCount(), status: 'FAILED', reason: message.slice(0, 200), next_wait_seconds: requiredGap });
    }
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
