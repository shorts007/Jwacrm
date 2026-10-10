import { describe, expect, it } from "vitest";
import { connectionTroubleReason, dailyLimit, healthVerdict, inSendingHours, isRecipientNotOnWhatsApp, outreachBlock, warmupDay, type SafetyConfig } from "./safety";

// 2026-10-11 12:00 Riyadh = 09:00 UTC
const noon = new Date("2026-10-11T09:00:00Z");
const daysBefore = (d: number) => new Date(noon.getTime() - d * 86_400_000);
const cfg = (over: Partial<SafetyConfig> = {}): SafetyConfig => ({
  warmupStartedAt: noon,
  maxDaily: 100,
  windowStartHour: 10,
  windowEndHour: 21,
  autoPause: true,
  pausedAt: null,
  pausedReason: null,
  ...over,
});

describe("warm-up", () => {
  it("counts Riyadh calendar days from the start", () => {
    expect(warmupDay(noon, noon)).toBe(1);
    expect(warmupDay(daysBefore(1), noon)).toBe(2);
    expect(warmupDay(null, noon)).toBe(1);
    // 23:30 Riyadh the day before is still "yesterday" in Riyadh
    expect(warmupDay(new Date("2026-10-10T20:30:00Z"), noon)).toBe(2);
  });
  it("ramps 20 → 40 → 70 → 100, then the max per day", () => {
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(0) }), noon)).toEqual({ limit: 20, day: 1, warmingUp: true });
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(3) }), noon).limit).toBe(40);
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(7) }), noon).limit).toBe(70);
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(14) }), noon).limit).toBe(100);
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(21), maxDaily: 150 }), noon)).toEqual({ limit: 150, day: 22, warmingUp: false });
  });
  it("never exceeds the max per day during warm-up", () => {
    expect(dailyLimit(cfg({ warmupStartedAt: daysBefore(10), maxDaily: 50 }), noon).limit).toBe(50);
  });
});

describe("outreachBlock", () => {
  it("allows sends inside hours and under the limit", () => {
    expect(outreachBlock(cfg(), 5, noon)).toBeNull();
  });
  it("blocks when paused, outside hours, or at the limit", () => {
    expect(outreachBlock(cfg({ pausedAt: noon, pausedReason: "x" }), 0, noon)?.code).toBe("paused");
    expect(outreachBlock(cfg(), 0, new Date("2026-10-11T19:30:00Z"))?.code).toBe("outside_window"); // 22:30 Riyadh
    expect(outreachBlock(cfg(), 20, noon)).toMatchObject({ code: "daily_limit" });
  });
  it("sending hours use Riyadh time", () => {
    expect(inSendingHours(cfg(), new Date("2026-10-11T07:00:00Z"))).toBe(true); // 10:00
    expect(inSendingHours(cfg(), new Date("2026-10-11T06:59:00Z"))).toBe(false); // 09:59
    expect(inSendingHours(cfg(), new Date("2026-10-11T18:00:00Z"))).toBe(false); // 21:00
  });
});

describe("healthVerdict", () => {
  const base = { sentToday: 0, recent: [], optOutsToday: 0, undelivered: { total: 0, notDelivered: 0 } };
  const ok = { ok: true, error: null };
  const bad = { ok: false, error: "Evolution POST /message/sendText → 500: boom" };
  const notOnWa = { ok: false, error: 'Evolution POST /message/sendText → 400: [{"exists":false,"number":"966"}]' };
  it("pauses on repeated failures but ignores numbers not on WhatsApp", () => {
    expect(healthVerdict({ ...base, recent: [bad, bad, bad, bad, ok, ok] }).pause).toMatch(/4 of the last 6/);
    expect(healthVerdict({ ...base, recent: [notOnWa, notOnWa, notOnWa, notOnWa, ok] }).pause).toBeNull();
  });
  it("pauses on too many STOP replies", () => {
    expect(healthVerdict({ ...base, sentToday: 40, optOutsToday: 3 }).pause).toMatch(/STOP/);
    expect(healthVerdict({ ...base, sentToday: 100, optOutsToday: 3 }).pause).toBeNull();
    expect(healthVerdict({ ...base, sentToday: 10, optOutsToday: 3 }).pause).toBeNull();
    expect(healthVerdict({ ...base, sentToday: 500, optOutsToday: 10 }).pause).toMatch(/10 customers/);
  });
  it("warns when many messages stay on one tick", () => {
    expect(healthVerdict({ ...base, undelivered: { total: 30, notDelivered: 15 } }).warnings[0]).toMatch(/one tick/);
    expect(healthVerdict({ ...base, undelivered: { total: 30, notDelivered: 5 } }).warnings).toEqual([]);
  });
  it("classifies recipient-side errors and connection trouble", () => {
    expect(isRecipientNotOnWhatsApp(notOnWa.error)).toBe(true);
    expect(isRecipientNotOnWhatsApp(bad.error)).toBe(false);
    expect(connectionTroubleReason(401)).toMatch(/logged/);
    expect(connectionTroubleReason("403")).toMatch(/banned/);
    expect(connectionTroubleReason(428)).toBeNull();
  });
});
