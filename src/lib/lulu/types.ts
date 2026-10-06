/**
 * LuLu engagement engine — shared types.
 * Pure data shapes; no I/O. Mirrors migration 043 (lulu_* tables).
 */

export type LifecycleStage =
  | "NEW"
  | "FIRST_ORDER"
  | "ACTIVE"
  | "AT_RISK"
  | "DORMANT"
  | "LOST";

export type CampaignType =
  | "FIRST_ORDER_THANK_YOU"
  | "THANK_YOU"
  | "SECOND_ORDER"
  | "INACTIVE_15"
  | "WINBACK_30"
  | "LOST_60"
  | "BIRTHDAY"
  | "VIP_PROTECTION"
  | "NEW_OFFER"
  | "SELECTED_CUSTOMER_OFFER"
  | "REPLENISHMENT"
  | "BUY_AGAIN";

/** PRD §56 priority classes. Order is configurable via lulu_contact_policy. */
export type PriorityClass =
  | "SERVICE_RECOVERY"
  | "BIRTHDAY"
  | "ORDER_COMMUNICATION"
  | "VIP"
  | "WINBACK"
  | "PERSONALIZED_OFFER"
  | "GENERAL_PROMOTION";

export interface CustomerProfile {
  customerId: string;
  mobile: string;
  name?: string | null;
  language: string;
  birthday?: string | null; // YYYY-MM-DD
  lastOrderDate?: string | null; // YYYY-MM-DD
  totalOrders: number;
  totalSales: number;
  medianIntervalDays?: number | null;
  vipFlag: boolean;
  marketingOptIn: boolean;
  activeComplaint: boolean;
  /** Non-null = suspected shared/fake number; never contacted (see migration 044). */
  suspectReason?: string | null;
  customerSegment?: string | null;
  preferredStoreId?: number | null;
  priceBehaviour?: string | null;
  /** Replenishable products this customer buys repeatedly (V2 personalisation). */
  usualItems?: UsualItem[];
  /** Last day covered by item (picking) data — YYYY-MM-DD. */
  itemsAsOf?: string | null;
  preferredStore?: string | null;
}

export interface CampaignConfig {
  id: string;
  code: string;
  name?: string;
  /** Tie-break inside the same priority class (lower first) — lulu_campaigns.priority. */
  rank?: number;
  type: CampaignType;
  priorityClass: PriorityClass;
  active: boolean;
  offerId?: string | null;
  /** Configurable thresholds (PRD §100: no code change for business rules). */
  params: {
    inactiveDays?: number; // fixed-day fallback, default 15
    winbackDays?: number; // default 30
    lostDays?: number; // default 60
    lostMaxDays?: number; // default 180: customers inactive longer than this are left alone
    secondOrderAfterDays?: number; // default 7
    birthdayWindowDays?: number; // default 0 (today only)
    secondOrderMaxDays?: number; // default = dormant threshold (30): after that WINBACK_30 takes over
    atRiskRatio?: number; // cycle-aware multiples of the customer's own interval
    dormantRatio?: number;
    lostRatio?: number;
    /** NEW_OFFER (promotion) audience; empty / missing fields mean "everyone". */
    audience?: PromoAudience;
    /** REPLENISHMENT: an item is due from dueRatio × its usual gap … until overdueRatio × gap. */
    dueRatio?: number; // default 0.9
    overdueRatio?: number; // default 2
    maxItems?: number; // items named in the message, default 3
    /** BUY_AGAIN: lifecycle stages to target (default AT_RISK) and minimum usual items. */
    stages?: LifecycleStage[];
    minItems?: number; // default 2
    /** REPLENISHMENT: wait at least N days after any order (default 2) … */
    minDaysSinceOrder?: number;
    /** … and, for customers with a known shopping rhythm, until cycleRatio × their usual gap between orders
     *  (default 0.7 → a 9-day shopper is reminded from day ~6, just before their next shop). */
    cycleRatio?: number;
  };
}

export interface ContactPolicy {
  maxPromoPerWindow: number;
  promoWindowDays: number;
  maxMarketingPerWindow: number;
  marketingWindowDays: number;
  suppressAfterOrderHours: number;
  quietHoursStart: number; // local hour, inclusive
  quietHoursEnd: number; // local hour, exclusive
  utcOffsetHours: number; // Asia/Riyadh = 3
  priorityOrder: PriorityClass[];
}

export interface PastSend {
  sentAt: Date;
  isPromo: boolean;
}

export interface CandidateAction {
  campaign: CampaignConfig;
  reason: string;
}

export interface NextBestAction {
  customerId: string;
  campaignId: string;
  campaignCode: string;
  offerId?: string | null;
  reason: string;
  language: string;
  priorityClass: PriorityClass;
  idempotencyKey: string;
}

export interface DecisionResult {
  action: NextBestAction | null;
  /** Why nothing was sent (or what lost the priority contest). Fuels dry-run reports. */
  skipped: { campaignCode: string; reason: string }[];
}

export const DEFAULT_POLICY: ContactPolicy = {
  maxPromoPerWindow: 3,
  promoWindowDays: 7,
  maxMarketingPerWindow: 5,
  marketingWindowDays: 14,
  suppressAfterOrderHours: 24,
  quietHoursStart: 22,
  quietHoursEnd: 9,
  utcOffsetHours: 3,
  priorityOrder: [
    "SERVICE_RECOVERY",
    "BIRTHDAY",
    "ORDER_COMMUNICATION",
    "VIP",
    "WINBACK",
    "PERSONALIZED_OFFER",
    "GENERAL_PROMOTION",
  ],
};

export interface PromoAudience {
  stages?: LifecycleStage[];
  priceBehaviour?: string[]; // Offer-driven | Mixed | Full-price | Unknown
  stores?: string[]; // store ids
  vipOnly?: boolean;
  minOrders?: number;
  /** Only customers who ordered within the last N days. */
  orderedWithinDays?: number;
}

export interface UsualItem {
  name: string;
  times: number;
  /** YYYY-MM-DD last bought */
  last: string;
  /** usual days between purchases */
  every: number;
}
