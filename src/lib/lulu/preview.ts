/**
 * Campaign preview (PRD §77): before a campaign goes live, who would it reach and why are the
 * others left out? Uses the same engine as the live queue — real send history, STOP list,
 * frequency caps, and competition with the campaigns that are already LIVE (a customer gets
 * at most one campaign a day: the higher priority one wins). Pure; tested in preview.test.ts.
 */
import { isHoldout } from "./attribution";
import { profileFromRow, type DryRunProfileRow } from "./dry-run";
import { decideNextBestAction } from "./next-best-action";
import type { CampaignConfig, ContactPolicy, PastSend } from "./types";

export interface AudiencePreview {
  /** Customers whose trigger matched this campaign. */
  matched: number;
  /** Customers it would message (after every rule, before the daily cap). */
  recipients: string[];
  /** Matched but left out, by reason. */
  exclusions: Record<string, number>;
  /** Kept back on purpose to measure the campaign's effect (holdout %). */
  holdout: number;
  /** Numbers flagged as suspect (fake / test) — never messaged. */
  suspects: number;
}

export function previewAudience(input: {
  rows: DryRunProfileRow[];
  target: CampaignConfig & { holdoutPct?: number };
  /** Campaigns already LIVE (excluding the target). */
  otherLive: CampaignConfig[];
  policy: ContactPolicy;
  now: Date;
  history: Map<string, PastSend[]>;
  receivedCodes: Map<string, Set<string>>;
  stopDigits: Set<string>;
  /** Extra per-customer rule (e.g. offer fits the customer); return a reason to exclude. */
  customerCheck?: (row: DryRunProfileRow) => string | null;
}): AudiencePreview {
  const target = { ...input.target, active: true };
  const campaigns = [target, ...input.otherLive.filter((c) => c.id !== target.id)];
  const exclusions: Record<string, number> = {};
  const bump = (k: string) => (exclusions[k] = (exclusions[k] ?? 0) + 1);
  const recipients: string[] = [];
  let matched = 0;
  let holdout = 0;
  let suspects = 0;

  for (const row of input.rows) {
    if (row.suspect_reason) {
      suspects++;
      continue;
    }
    const profile = profileFromRow(row);
    const stopped = input.stopDigits.has(profile.mobile.replace(/\D/g, ""));
    if (stopped) profile.marketingOptIn = false;
    const result = decideNextBestAction({
      profile,
      campaigns,
      policy: input.policy,
      history: input.history.get(row.customer_id) ?? [],
      now: input.now,
      lastOrderAt: row.last_order_date ? new Date(`${row.last_order_date}T23:59:59+03:00`) : null,
      receivedCampaignCodes: input.receivedCodes.get(row.customer_id),
    });
    const mine = result.skipped.find((s) => s.campaignCode === target.code);
    if (mine) {
      matched++;
      bump(stopped && mine.reason === "opted_out" ? "replied_stop" : mine.reason);
      continue;
    }
    if (result.action?.campaignCode !== target.code) continue;
    matched++;
    const why = input.customerCheck?.(row) ?? null;
    if (why) {
      bump(why);
      continue;
    }
    if (isHoldout(row.customer_id, target.code, input.target.holdoutPct ?? 0)) {
      holdout++;
      continue;
    }
    recipients.push(row.customer_id);
  }
  return { matched, recipients, exclusions, holdout, suspects };
}

/** Plain-language labels for exclusion reasons. */
export const EXCLUSION_LABELS: Record<string, string> = {
  opted_out: "Not opted in to marketing",
  replied_stop: "Replied STOP",
  suspected_shared_number: "Suspect / shared number",
  ordered_recently: "Ordered recently",
  active_complaint: "Open complaint",
  promo_frequency_cap: "Got too many offers recently",
  marketing_frequency_cap: "Got too many messages recently",
  already_received_campaign: "Already received this campaign",
  lower_priority: "Another campaign comes first",
};

/** "9665•••••234" — enough to tell samples apart without showing the full number. */
export const maskPhone = (mobile: string) => {
  const d = mobile.replace(/\D/g, "");
  return d.length <= 7 ? d : `${d.slice(0, 4)}${"•".repeat(Math.max(0, d.length - 7))}${d.slice(-3)}`;
};
