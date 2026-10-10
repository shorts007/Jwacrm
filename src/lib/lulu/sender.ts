/**
 * Live-sending logic (pure, no I/O):
 *  - pacing: gap before the n-th message of the day = base + increment × (n − 1)
 *    e.g. 60 s, 61 s, 62 s … (business rule to protect the WhatsApp number)
 *  - planning: which customers get which LIVE campaign today, within the daily cap
 *  - Meta error classification for auto-pause
 */
import { daysSince } from "./lifecycle";
import { decideNextBestAction } from "./next-best-action";
import { profileFromRow, type DryRunProfileRow } from "./dry-run";
import type { CampaignConfig, ContactPolicy, PastSend } from "./types";

export interface SendSettings {
  dailyCap: number;
  gapBaseSeconds: number;
  gapIncrementSeconds: number;
}

export const DEFAULT_SEND_SETTINGS: SendSettings = { dailyCap: 100, gapBaseSeconds: 60, gapIncrementSeconds: 1 };

/** Seconds to wait BEFORE sending the message that will be number `sentSoFar + 1` today. */
export function gapBeforeNext(sentSoFar: number, s: SendSettings = DEFAULT_SEND_SETTINGS): number {
  return s.gapBaseSeconds + s.gapIncrementSeconds * Math.max(0, sentSoFar);
}

/** Total time to send `n` messages with this pacing (seconds, including the first wait). */
export function totalDuration(n: number, s: SendSettings = DEFAULT_SEND_SETTINGS): number {
  let t = 0;
  for (let i = 0; i < n; i++) t += gapBeforeNext(i, s);
  return t;
}

/** Start of the current Riyadh (UTC+3) calendar day, as a UTC Date. */
export function riyadhDayStart(now: Date, utcOffsetHours = 3): Date {
  const local = new Date(now.getTime() + utcOffsetHours * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - utcOffsetHours * 3_600_000);
}

export interface PlannedSend {
  customerId: string;
  campaignId: string;
  campaignCode: string;
  campaignType: CampaignConfig["type"];
  offerId: string | null;
  reason: string;
  language: string;
  priorityClass: CampaignConfig["priorityClass"];
  idempotencyKey: string;
  daysSinceOrder: number | null;
}

export interface PlanResult {
  planned: PlannedSend[];
  /** Why matched customers were not planned (opted_out, lower_priority, frequency caps, daily_cap …). */
  skipped: Record<string, number>;
  evaluated: number;
}

/**
 * Pick today's sends. Only `liveCampaigns` (active + LIVE + not paused) are considered.
 * Suspects, inactive profiles and phones on the STOP list are excluded up front.
 * Ordering: campaign priority (policy order), then the most recently active customers first
 * (fresher = more likely to respond), then customer id for determinism.
 */
export function planSends(input: {
  rows: DryRunProfileRow[];
  liveCampaigns: CampaignConfig[];
  policy: ContactPolicy;
  now: Date;
  remainingCap: number;
  history: Map<string, PastSend[]>;
  receivedCodes: Map<string, Set<string>>;
  stopDigits: Set<string>;
  alreadyQueuedToday: Set<string>;
}): PlanResult {
  const skipped: Record<string, number> = {};
  const bump = (k: string, n = 1) => (skipped[k] = (skipped[k] ?? 0) + n);
  const candidates: PlannedSend[] = [];
  let evaluated = 0;

  if (input.liveCampaigns.length === 0) return { planned: [], skipped, evaluated };

  for (const row of input.rows) {
    if (row.suspect_reason) continue;
    if (input.alreadyQueuedToday.has(row.customer_id)) {
      bump("already_queued_today");
      continue;
    }
    evaluated++;
    const profile = profileFromRow(row);
    if (input.stopDigits.has(profile.mobile.replace(/\D/g, ""))) profile.marketingOptIn = false;

    const result = decideNextBestAction({
      profile,
      campaigns: input.liveCampaigns,
      policy: input.policy,
      history: input.history.get(row.customer_id) ?? [],
      now: input.now,
      lastOrderAt: row.last_order_date ? new Date(`${row.last_order_date}T23:59:59+03:00`) : null,
      receivedCampaignCodes: input.receivedCodes.get(row.customer_id),
    });
    for (const s of result.skipped) bump(s.reason);
    if (!result.action) continue;
    const c = input.liveCampaigns.find((x) => x.id === result.action!.campaignId)!;
    candidates.push({
      customerId: result.action.customerId,
      campaignId: result.action.campaignId,
      campaignCode: result.action.campaignCode,
      campaignType: c.type,
      offerId: result.action.offerId ?? null,
      reason: result.action.reason,
      language: result.action.language,
      priorityClass: result.action.priorityClass,
      idempotencyKey: result.action.idempotencyKey,
      daysSinceOrder: daysSince(row.last_order_date, input.now),
    });
  }

  const rank = (p: PlannedSend) => {
    const i = input.policy.priorityOrder.indexOf(p.priorityClass);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  candidates.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.daysSinceOrder ?? 9_999) - (b.daysSinceOrder ?? 9_999) ||
      a.customerId.localeCompare(b.customerId),
  );
  const cap = Math.max(0, input.remainingCap);
  if (candidates.length > cap) bump("daily_cap", candidates.length - cap);
  return { planned: candidates.slice(0, cap), skipped, evaluated };
}

/**
 * Meta / WhatsApp errors that mean "stop sending now" (number at risk), as opposed to
 * one bad recipient. Codes: 131048 spam rate limit, 131056 pair rate limit, 80007 / 130429
 * throughput, 368 temporarily blocked for policy, 131031 account locked, 131049 marketing
 * message not delivered to keep healthy engagement (per-user; NOT a pause).
 */
export function isPauseWorthyError(message: string): boolean {
  return (
    /\b(131048|131056|80007|130429|368|131031)\b/.test(message) ||
    /rate limit|temporarily blocked|account (?:has been )?locked/i.test(message) ||
    // WhatsApp app number (Evolution): unlinked / logged out / server unreachable / bad key.
    /WhatsApp app number is (?:disconnected|not set up)|paused for safety|Connection Closed|not connected|Cannot reach Evolution|→ 401/i.test(message)
  );
}
