/**
 * App-number safety — database side: today's counts, the send gate, the send log, health checks
 * and the automatic pause. Pure rules live in ./safety.ts.
 */
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { riyadhDayStart } from "@/lib/lulu/sender";
import { dailyLimit, healthVerdict, outreachBlock, type GateCode, type HealthStats, type HealthVerdict, type SafetyConfig } from "./safety";

interface SafetyRow {
  warmup_started_at: string | null;
  max_daily: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  auto_pause: boolean | null;
  paused_at: string | null;
  paused_reason: string | null;
}

const COLUMNS = "warmup_started_at, max_daily, window_start_hour, window_end_hour, auto_pause, paused_at, paused_reason";

export function safetyFromRow(r: SafetyRow): SafetyConfig {
  return {
    warmupStartedAt: r.warmup_started_at ? new Date(r.warmup_started_at) : null,
    maxDaily: r.max_daily ?? 100,
    windowStartHour: r.window_start_hour ?? 10,
    windowEndHour: r.window_end_hour ?? 21,
    autoPause: r.auto_pause ?? true,
    pausedAt: r.paused_at ? new Date(r.paused_at) : null,
    pausedReason: r.paused_reason,
  };
}

/** Safety settings, or null when migration 063 has not been run (no limits then). */
export async function loadSafety(accountId: string): Promise<SafetyConfig | null> {
  try {
    const { data, error } = await supabaseAdmin().from("evolution_config").select(COLUMNS).eq("account_id", accountId).maybeSingle();
    if (error || !data) return null;
    return safetyFromRow(data as SafetyRow);
  } catch {
    return null;
  }
}

/** Business-initiated sends through the app number accepted today. */
export async function sentTodayCount(accountId: string, now = new Date()): Promise<number> {
  const { count } = await supabaseAdmin()
    .from("evolution_send_log")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("ok", true)
    .gte("sent_at", riyadhDayStart(now).toISOString());
  return count ?? 0;
}

/** Null when a business-initiated send may go out now, else why not. */
export async function outreachGate(accountId: string, now = new Date()): Promise<{ code: GateCode; message: string } | null> {
  const cfg = await loadSafety(accountId);
  if (!cfg) return null;
  return outreachBlock(cfg, await sentTodayCount(accountId, now), now);
}

export async function recordOutreach(accountId: string, r: { ok: boolean; messageId?: string | null; recipient?: string | null; error?: string | null }): Promise<void> {
  try {
    await supabaseAdmin()
      .from("evolution_send_log")
      .insert({ account_id: accountId, ok: r.ok, message_id: r.messageId ?? null, recipient: r.recipient ?? null, error: r.error?.slice(0, 500) ?? null });
  } catch (e) {
    console.warn("[safety] send log failed:", e instanceof Error ? e.message : e);
  }
}

export async function healthStats(accountId: string, now = new Date()): Promise<HealthStats> {
  const db = supabaseAdmin();
  const dayStart = riyadhDayStart(now).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const [sentToday, { data: recent }, { count: optOuts }, { data: older }] = await Promise.all([
    sentTodayCount(accountId, now),
    db.from("evolution_send_log").select("ok, error").eq("account_id", accountId).order("sent_at", { ascending: false }).limit(10),
    db.from("lulu_opt_outs").select("phone_digits", { count: "exact", head: true }).eq("account_id", accountId).gte("opted_out_at", dayStart),
    db
      .from("evolution_send_log")
      .select("message_id")
      .eq("account_id", accountId)
      .eq("ok", true)
      .gte("sent_at", dayStart)
      .lte("sent_at", twoHoursAgo)
      .not("message_id", "is", null)
      .limit(500),
  ]);
  const ids = (older ?? []).map((r) => r.message_id as string);
  let delivered = 0;
  if (ids.length) {
    const { count } = await db.from("messages").select("id", { count: "exact", head: true }).in("message_id", ids).in("status", ["delivered", "read"]);
    delivered = count ?? 0;
  }
  return {
    sentToday,
    recent: (recent ?? []) as { ok: boolean; error: string | null }[],
    optOutsToday: optOuts ?? 0,
    undelivered: { total: ids.length, notDelivered: Math.max(0, ids.length - delivered) },
  };
}

/** Stop business-initiated sends through the app number and pause LIVE LuLu campaigns. */
export async function pauseAppNumber(accountId: string, reason: string): Promise<void> {
  const db = supabaseAdmin();
  const { data } = await db.from("evolution_config").select("auto_pause, paused_at").eq("account_id", accountId).maybeSingle();
  if (!data || data.paused_at || data.auto_pause === false) return;
  await db.from("evolution_config").update({ paused_at: new Date().toISOString(), paused_reason: reason, updated_by: null }).eq("account_id", accountId);
  // Campaigns only go through the app number when it is the default sender.
  const { data: cfg } = await db.from("evolution_config").select("is_default_outbound").eq("account_id", accountId).maybeSingle();
  if (cfg?.is_default_outbound) {
    await db.from("lulu_campaigns").update({ status: "PAUSED" }).eq("account_id", accountId).eq("mode", "LIVE").eq("active", true);
  }
  try {
    await db.from("evolution_event_log").insert({ account_id: accountId, event: "safety", outcome: `auto-paused: ${reason}`.slice(0, 300) });
  } catch {
    /* diagnostics only */
  }
}

/** Evaluate health now; pauses automatically when a rule trips (if auto-pause is on). */
export async function checkHealth(accountId: string, now = new Date()): Promise<HealthVerdict & { stats: HealthStats }> {
  const stats = await healthStats(accountId, now);
  const verdict = healthVerdict(stats);
  if (verdict.pause) await pauseAppNumber(accountId, verdict.pause);
  return { ...verdict, stats };
}

/** Everything the Channels page shows about safety. */
export async function safetySummary(accountId: string, now = new Date()) {
  const cfg = await loadSafety(accountId);
  if (!cfg) return null;
  const stats = await healthStats(accountId, now);
  const verdict = healthVerdict(stats);
  const { limit, day, warmingUp } = dailyLimit(cfg, now);
  return {
    config: {
      maxDaily: cfg.maxDaily,
      windowStartHour: cfg.windowStartHour,
      windowEndHour: cfg.windowEndHour,
      autoPause: cfg.autoPause,
      warmupStartedAt: cfg.warmupStartedAt?.toISOString() ?? null,
    },
    paused: cfg.pausedAt ? { at: cfg.pausedAt.toISOString(), reason: cfg.pausedReason } : null,
    today: { limit, sent: stats.sentToday, warmupDay: day, warmingUp, optOuts: stats.optOutsToday },
    undelivered: stats.undelivered,
    recentFailures: stats.recent.filter((r) => !r.ok).length,
    warnings: verdict.warnings,
    wouldPause: verdict.pause,
  };
}
