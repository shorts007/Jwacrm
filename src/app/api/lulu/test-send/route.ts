// ============================================================
// POST /api/lulu/test-send     (admin+, cookie session)
//
// Sends ONE campaign's WhatsApp template to the campaign's configured
// INTERNAL test numbers (PRD §78 Test Mode) so the team can check wording,
// variables and delivery before any customer is ever messaged.
//
// Hard safety rule: the recipient must be in lulu_campaigns.test_phones.
// This route never sends to a customer number.
//
// Body: { campaign_id: uuid, language: 'ar' | 'en', name?: string }
// Every attempt is logged in lulu_customer_next_actions (is_test = true).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  SendMessageError,
  sendMessageToConversation,
} from '@/lib/whatsapp/send-message';
import {
  TEMPLATE_LANGUAGE,
  OFFER_COLUMNS,
  asMessageLanguage,
  buildParamsForKind,
  campaignNeedsOffer,
  offerExpiry,
  offerFromRow,
  offerText,
  type OfferRow,
  pickTemplate,
  type CampaignType,
} from '@/lib/lulu';

interface CampaignRow {
  id: string;
  campaign_code: string;
  campaign_type: CampaignType;
  template_name_ar: string | null;
  template_name_en: string | null;
  template_name_bilingual: string | null;
  test_phones: string[] | null;
  offer_id: string | null;
  promo_image_url: string | null;
  promo_text_ar: string | null;
  promo_text_en: string | null;
  promo_valid_until: string | null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      campaign_id?: unknown;
      language?: unknown;
      name?: unknown;
    } | null;
    if (!body || typeof body.campaign_id !== 'string') {
      return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 });
    }
    // 'bi' = the bilingual AR+EN template with العربية / English buttons
    const bilingual = body.language === 'bi';
    const language = asMessageLanguage(typeof body.language === 'string' ? body.language : 'ar');
    const sampleName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Test';

    const { data: campaign, error } = await ctx.supabase
      .from('lulu_campaigns')
      .select('id, campaign_code, campaign_type, template_name_ar, template_name_en, template_name_bilingual, test_phones, offer_id, promo_image_url, promo_text_ar, promo_text_en, promo_valid_until')
      .eq('id', body.campaign_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle<CampaignRow>();
    if (error) throw error;
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

    const phones = (campaign.test_phones ?? []).filter(Boolean);
    if (phones.length === 0) {
      return NextResponse.json(
        { error: 'Add at least one test phone number (with +country code) to this campaign first.' },
        { status: 400 }
      );
    }
    const template = bilingual
      ? campaign.template_name_bilingual
        ? { name: campaign.template_name_bilingual, language: 'ar' as const }
        : null
      : pickTemplate({ ar: campaign.template_name_ar, en: campaign.template_name_en }, language);
    if (!template) {
      return NextResponse.json(
        { error: 'Set the template name for this campaign first (it must be an APPROVED template in Meta).' },
        { status: 400 }
      );
    }

    // Check against the templates synced from Meta BEFORE calling Meta, so a name /
    // language / approval problem comes back as a clear message instead of #132001.
    const { data: synced, error: tErr } = await ctx.supabase
      .from('message_templates')
      .select('name, language, status, body_text')
      .eq('account_id', ctx.accountId);
    if (tErr) throw tErr;
    const rows = (synced ?? []) as { name: string; language: string | null; status: string | null; body_text: string | null }[];
    const sameName = rows.filter((r) => r.name === template.name);
    const describe = (r: { name: string; language: string | null; status: string | null }) =>
      `${r.name} [${r.language ?? '?'}, ${r.status ?? '?'}]`;
    if (sameName.length === 0) {
      const mine = rows.filter((r) => r.name.startsWith('lulu_')).map(describe);
      return NextResponse.json(
        {
          error:
            `Template "${template.name}" is not in this WhatsApp account's synced templates. ` +
            `Create/submit it under the SAME WhatsApp Business Account as the connected number, then run ` +
            `Settings → Templates → "Sync from Meta". ` +
            (mine.length ? `LuLu templates currently synced: ${mine.join(', ')}.` : `No lulu_ templates are synced yet.`),
        },
        { status: 400 }
      );
    }
    const approved = sameName.filter((r) => (r.status ?? '').toUpperCase() === 'APPROVED');
    if (approved.length === 0) {
      return NextResponse.json(
        {
          error: `Template "${template.name}" exists but is not approved yet: ${sameName.map(describe).join(', ')}. Meta only delivers APPROVED templates (run "Sync from Meta" to refresh the status).`,
        },
        { status: 400 }
      );
    }
    // Use the language code Meta actually has for this template (e.g. "ar" vs "ar_SA").
    const wanted = TEMPLATE_LANGUAGE[template.language];
    const chosen =
      approved.find((r) => r.language === wanted) ??
      approved.find((r) => (r.language ?? '').toLowerCase().startsWith(wanted)) ??
      approved[0];
    const sendLanguage = chosen.language ?? wanted;

    const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    // Offer campaigns are tested with their REAL offer wording — never a placeholder.
    let offerTexts: { ar: string; en: string } | null = null;
    let expiryDate = expiry;
    if (campaignNeedsOffer(campaign.campaign_type)) {
      const { data: offerRow } = campaign.offer_id
        ? await ctx.supabase.from('lulu_offers').select(OFFER_COLUMNS).eq('id', campaign.offer_id).maybeSingle()
        : { data: null };
      if (!offerRow) {
        return NextResponse.json(
          { error: 'This campaign mentions an offer — attach one first (Campaigns → Step 3 → Offer, created on the Offers page).' },
          { status: 400 }
        );
      }
      const offer = offerFromRow(offerRow as unknown as OfferRow);
      offerTexts = { ar: offerText(offer, 'ar'), en: offerText(offer, 'en') };
      expiryDate = offerExpiry(offer, new Date());
    }
    const isPromo = campaign.campaign_type === 'NEW_OFFER';
    if (isPromo && (!campaign.promo_image_url || !campaign.promo_text_ar || !campaign.promo_text_en || !campaign.promo_valid_until)) {
      return NextResponse.json({ error: 'Finish the promotion first: image, Arabic and English text, valid-until date (Promotions page).' }, { status: 400 });
    }
    if (isPromo) expiryDate = campaign.promo_valid_until!;
    const wantedParams = buildParamsForKind(bilingual ? 'bi' : template.language, campaign.campaign_type, {
      name: sampleName,
      expiryDate,
      offer: offerTexts,
      promo: isPromo ? { ar: campaign.promo_text_ar!, en: campaign.promo_text_en! } : null,
      items: ['Banana Ecuador 1 kg', 'LuLu White Eggs Large 30 pcs'],
    });
    // Send exactly as many variables as the approved template declares (hello_world has none).
    const varCount = new Set([...(chosen.body_text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    if (varCount > wantedParams.length) {
      return NextResponse.json(
        { error: `Template "${template.name}" has ${varCount} variables but this campaign supplies ${wantedParams.length}. Pick a template that matches the campaign.` },
        { status: 400 }
      );
    }
    const params = wantedParams.slice(0, varCount);

    const admin = supabaseAdmin();
    const results: { phone: string; ok: boolean; error?: string; code?: string }[] = [];
    const { data: optRows } = await admin
      .from('lulu_opt_outs')
      .select('phone_digits')
      .eq('account_id', ctx.accountId)
      .in('phone_digits', phones.map((p) => p.replace(/\D/g, '')));
    const optedOut = new Set((optRows ?? []).map((r) => r.phone_digits as string));

    for (const phone of phones) {
      if (optedOut.has(phone.replace(/\D/g, ''))) {
        results.push({ phone, ok: false, error: 'opted out (replied STOP) — reply START from this phone to receive messages again' });
        continue;
      }
      const key = `TEST_${campaign.campaign_code}_${Date.now()}_${phone.replace(/\D/g, '')}`;
      const row = {
        account_id: ctx.accountId,
        customer_id: 'TEST',
        campaign_id: campaign.id,
        action_type: campaign.campaign_type,
        reason: 'Test send to internal number',
        language: template.language,
        idempotency_key: key,
        is_test: true,
        recipient: phone,
        template_name: template.name,
        template_language: sendLanguage,
        template_params: params,
      };
      try {
        const resolved = await resolveConversationByPhone(ctx.supabase, ctx.accountId, phone, 'LuLu test');
        const sent = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId: resolved.conversationId,
          messageType: 'template',
          templateName: template.name,
          templateLanguage: sendLanguage,
          templateParams: params,
          templateMessageParams: isPromo ? { body: params, headerMediaUrl: campaign.promo_image_url! } : undefined,
        });
        await admin.from('lulu_customer_next_actions').insert({
          ...row,
          status: 'SENT',
          sent_at: new Date().toISOString(),
          wa_message_id: sent.whatsappMessageId,
        });
        results.push({ phone, ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Send failed';
        await admin
          .from('lulu_customer_next_actions')
          .insert({ ...row, status: 'FAILED', attempts: 1, last_error: message.slice(0, 500) });
        results.push({
          phone,
          ok: false,
          error: message,
          code: e instanceof SendMessageError ? e.code : undefined,
        });
      }
    }

    return NextResponse.json({
      template: template.name,
      language: template.language,
      params,
      results,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
