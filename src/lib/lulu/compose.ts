/**
 * The variables of one campaign message for one customer — shared by the live sender and the
 * campaign preview so the preview shows exactly what would be sent.
 */
import { dueItems } from "./lifecycle";
import { buildParamsForKind, type TemplateChoiceKind } from "./messages";
import { offerExpiry, offerText, type Offer } from "./offers";
import type { CampaignConfig, CustomerProfile } from "./types";

const DAY = 86_400_000;

export interface ComposeCampaign extends Pick<CampaignConfig, "type" | "params"> {
  promoTextAr?: string | null;
  promoTextEn?: string | null;
  promoValidUntil?: string | null;
}

/** Template variables ({{1}}, {{2}}…) for this customer, in order. */
export function campaignParams(kind: TemplateChoiceKind, campaign: ComposeCampaign, profile: CustomerProfile, offer: Offer | null, now: Date): string[] {
  const isPromo = campaign.type === "NEW_OFFER";
  const expiryDate = isPromo
    ? (campaign.promoValidUntil ?? "")
    : offer
      ? offerExpiry(offer, now)
      : new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10);
  return buildParamsForKind(kind, campaign.type, {
    name: profile.name,
    expiryDate,
    offer: offer ? { ar: offerText(offer, "ar"), en: offerText(offer, "en") } : null,
    promo: isPromo ? { ar: campaign.promoTextAr ?? "", en: campaign.promoTextEn ?? "" } : null,
    // V2: the customer's own products — due items for Replenishment, most-bought for Buy Again.
    items:
      campaign.type === "REPLENISHMENT"
        ? dueItems(profile.usualItems, now, campaign.params.dueRatio, campaign.params.overdueRatio)
            .slice(0, campaign.params.maxItems ?? 3)
            .map((i) => i.name)
        : campaign.type === "BUY_AGAIN"
          ? (profile.usualItems ?? []).slice(0, campaign.params.maxItems ?? 3).map((i) => i.name)
          : campaign.type === "CROSS_SELL" && profile.crossSell
            ? [profile.crossSell.anchor]
            : null,
    product: campaign.type === "CROSS_SELL" ? (profile.crossSell?.product ?? null) : null,
  });
}

/** Product campaigns need at least one product name in {{2}}. */
export const missingProducts = (type: CampaignConfig["type"], params: string[]) =>
  (type === "REPLENISHMENT" || type === "BUY_AGAIN" || type === "CROSS_SELL") && !params[1];
