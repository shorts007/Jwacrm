import { describe, expect, it } from "vitest";
import { OPT_IN_CONFIRMATION, OPT_OUT_CONFIRMATION, classifyReply, normalizeReply, statusToEvent } from "./index";

describe("classifyReply", () => {
  it.each([
    ["STOP", "stop"], [" stop! ", "stop"], ["Stop messages", "stop"], ["Unsubscribe", "stop"],
    ["إيقاف", "stop"], ["ايقاف", "stop"], ["إيقاف الرسائل", "stop"], ["إلغاء", "stop"], ["الغاء الاشتراك", "stop"],
    ["START", "start"], ["ابدأ", "start"], ["Subscribe", "start"],
  ])("%s → %s", (text, intent) => expect(classifyReply(text)).toBe(intent));

  it("ignores normal conversation that merely contains the word", () => {
    expect(classifyReply("please stop the late deliveries")).toBeNull();
    expect(classifyReply("where is my order")).toBeNull();
    expect(classifyReply("")).toBeNull();
    expect(classifyReply(null)).toBeNull();
  });
  it("normalises Arabic letter forms and diacritics", () => {
    expect(normalizeReply("إِيقَاف")).toBe("ايقاف");
  });
});

describe("statusToEvent", () => {
  it("maps Meta statuses", () => {
    expect(statusToEvent("delivered")).toBe("DELIVERED");
    expect(statusToEvent("READ")).toBe("READ");
    expect(statusToEvent("failed")).toBe("FAILED");
    expect(statusToEvent("sent")).toBeNull();
  });
});

describe("confirmation texts", () => {
  it("are brand-neutral and bilingual", () => {
    for (const msg of [OPT_OUT_CONFIRMATION, OPT_IN_CONFIRMATION]) {
      expect(msg).not.toMatch(/lulu|لولو/i);
      expect(msg).toMatch(/online offers/);
      expect(msg).toMatch(/العروض الإلكترونية/);
    }
  });
});
