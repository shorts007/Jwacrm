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
  asMessageLanguage,
  buildTemplateParams,
  pickTemplate,
  type CampaignType,
} from '@/lib/lulu';

interface CampaignRow {
  id: string;
  campaign_code: string;
  campaign_type: CampaignType;
  template_name_ar: string | null;
  template_name_en: string | null;
  test_phones: string[] | null;
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
    const language = asMessageLanguage(typeof body.language === 'string' ? body.language : 'ar');
    const sampleName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Test';

    const { data: campaign, error } = await ctx.supabase
      .from('lulu_campaigns')
      .select('id, campaign_code, campaign_type, template_name_ar, template_name_en, test_phones')
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
    const template = pickTemplate(
      { ar: campaign.template_name_ar, en: campaign.template_name_en },
      language
    );
    if (!template) {
      return NextResponse.json(
        { error: 'Set the template name for this campaign first (it must be an APPROVED template in Meta).' },
        { status: 400 }
      );
    }

    const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const params = buildTemplateParams(campaign.campaign_type, {
      name: sampleName,
      language: template.language,
      expiryDate: expiry,
    });

    const admin = supabaseAdmin();
    const results: { phone: string; ok: boolean; error?: string; code?: string }[] = [];

    for (const phone of phones) {
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
        template_language: TEMPLATE_LANGUAGE[template.language],
        template_params: params,
      };
      try {
        const resolved = await resolveConversationByPhone(ctx.supabase, ctx.accountId, phone, 'LuLu test');
        const sent = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId: resolved.conversationId,
          messageType: 'template',
          templateName: template.name,
          templateLanguage: TEMPLATE_LANGUAGE[template.language],
          templateParams: params,
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
