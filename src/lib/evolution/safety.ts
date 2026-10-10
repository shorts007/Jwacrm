/**
 * WhatsApp app number (Evolution / Baileys) safety rules — pure functions, tested in safety.test.ts.
 *
 * App numbers are not Meta-approved senders: WhatsApp bans them when they suddenly send a lot,
 * when many recipients block / report them, or when messages keep failing. So business-initiated
 * sends (campaigns, broadcasts, tests — never replies) are limited by:
 *   - a warm-up ramp: 20 → 40 → 70 → 100 a day over the first three weeks, then the max per day;
 *   - sending hours (Riyadh time);
 *   - health checks that pause sending automatically (failures, opt-outs, logout / ban).
 */

export interface SafetyConfig {
  warmupStartedAt: Date | null;
  maxDaily: number;
  windowStartHour: number;
  windowEndHour: number;
  autoPause: boolean;
  pausedAt: Date | null;
  pausedReason: string | null;
}

export const WARMUP_STEPS: { throughDay: number; limit: number }[] = [
  { throughDay: 3, limit: 20 },
  { throughDay: 7, limit: 40 },
  { throughDay: 14, limit: 70 },
  { throughDay: 21, limit: 100 },
];
export const WARMUP_DAYS = WARMUP_STEPS[WARMUP_STEPS.length - 1].throughDay;
const DAY = 86_400_000;
const RIYADH_OFFSET_H = 3;

/** 1-based day of the warm-up (day 1 = the day it started), Riyadh calendar days. */
export function warmupDay(startedAt: Date | null, now: Date): number {
  if (!startedAt) return 1;
  const day = (d: Date) => Math.floor((d.getTime() + RIYADH_OFFSET_H * 3_600_000) / DAY);
  return Math.max(1, day(now) - day(startedAt) + 1);
}

/** Today's limit for business-initiated sends through the app number. */
export function dailyLimit(cfg: Pick<SafetyConfig, "warmupStartedAt" | "maxDaily">, now: Date): { limit: number; day: number; warmingUp: boolean } {
  const day = warmupDay(cfg.warmupStartedAt, now);
  const step = WARMUP_STEPS.find((s) => day <= s.throughDay);
  return step ? { limit: Math.min(step.limit, cfg.maxDaily), day, warmingUp: true } : { limit: cfg.maxDaily, day, warmingUp: false };
}

export function riyadhHour(now: Date): number {
  return new Date(now.getTime() + RIYADH_OFFSET_H * 3_600_000).getUTCHours();
}

export function inSendingHours(cfg: Pick<SafetyConfig, "windowStartHour" | "windowEndHour">, now: Date): boolean {
  const h = riyadhHour(now);
  return h >= cfg.windowStartHour && h < cfg.windowEndHour;
}

export type GateCode = "paused" | "outside_window" | "daily_limit";

/** Why a business-initiated send may not go out right now (null = OK). */
export function outreachBlock(cfg: SafetyConfig, sentToday: number, now: Date): { code: GateCode; message: string } | null {
  if (cfg.pausedAt) {
    return {
      code: "paused",
      message: `Sending through the WhatsApp app number is paused for safety: ${cfg.pausedReason ?? "paused"}. Resume it on Engagement → Channels.`,
    };
  }
  if (!inSendingHours(cfg, now)) {
    return {
      code: "outside_window",
      message: `The WhatsApp app number only sends campaigns between ${cfg.windowStartHour}:00 and ${cfg.windowEndHour}:00 (Riyadh).`,
    };
  }
  const { limit, day, warmingUp } = dailyLimit(cfg, now);
  if (sentToday >= limit) {
    return {
      code: "daily_limit",
      message: warmingUp
        ? `Today's limit for the WhatsApp app number is reached (${limit}, warm-up day ${day} of ${WARMUP_DAYS}).`
        : `Today's limit for the WhatsApp app number is reached (${limit} a day).`,
    };
  }
  return null;
}

/** "Number is not on WhatsApp" — the recipient's problem, not a sign of trouble with our number. */
export function isRecipientNotOnWhatsApp(error: string | null | undefined): boolean {
  return /"exists"\s*:\s*false|not (?:on|a) whatsapp|no whatsapp account/i.test(error ?? "");
}

export interface HealthStats {
  /** Business-initiated sends through the app number today (accepted by Evolution). */
  sentToday: number;
  /** Last ≤10 sends, newest first: ok + error text. */
  recent: { ok: boolean; error: string | null }[];
  /** STOP replies today. */
  optOutsToday: number;
  /** Of today's sends older than 2 hours: how many are still without a delivered tick. */
  undelivered: { total: number; notDelivered: number };
}

export interface HealthVerdict {
  /** Reason to pause now, or null. */
  pause: string | null;
  warnings: string[];
}

export function healthVerdict(s: HealthStats): HealthVerdict {
  const warnings: string[] = [];
  const counted = s.recent.filter((r) => r.ok || !isRecipientNotOnWhatsApp(r.error));
  const failed = counted.filter((r) => !r.ok).length;
  if (counted.length >= 5 && failed >= 4) {
    return { pause: `${failed} of the last ${counted.length} sends failed`, warnings };
  }
  const optRate = s.sentToday > 0 ? s.optOutsToday / s.sentToday : 0;
  if (s.optOutsToday >= 10 || (s.sentToday >= 20 && s.optOutsToday >= 3 && optRate >= 0.05)) {
    return { pause: `${s.optOutsToday} customers replied STOP today (${Math.round(optRate * 100)}% of ${s.sentToday} sent) — too many opt-outs get numbers reported`, warnings };
  }
  if (s.optOutsToday >= 2 && optRate >= 0.03) warnings.push(`${s.optOutsToday} STOP replies today (${Math.round(optRate * 100)}% of sends) — watch the wording and audience.`);
  if (failed >= 2) warnings.push(`${failed} of the last ${counted.length} sends failed.`);
  if (s.undelivered.total >= 20 && s.undelivered.notDelivered / s.undelivered.total >= 0.4) {
    warnings.push(
      `${s.undelivered.notDelivered} of ${s.undelivered.total} messages sent 2+ hours ago still show one tick — many recipients may have blocked the number or WhatsApp may be limiting it.`,
    );
  }
  return { pause: null, warnings };
}

/** Evolution connection.update statusReason that means the number itself is in trouble. */
export function connectionTroubleReason(statusReason: unknown): string | null {
  const code = typeof statusReason === "number" ? statusReason : Number(statusReason);
  if (code === 401) return "WhatsApp logged this number out (401) — reconnect it by scanning the QR code";
  if (code === 403) return "WhatsApp refused the connection (403) — the number may be banned";
  return null;
}
