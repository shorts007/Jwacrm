import { describe, expect, it } from "vitest";
import { botHandles, forwardText, isOverdue, parseAgentMessage, pickAgent, splitCode, type RelayAgent } from "./logic";

const agent = (id: string, over: Partial<RelayAgent> = {}): RelayAgent => ({ id, name: id, phoneDigits: "9665000000" + id.length, enabled: true, onDuty: true, ...over });

describe("pickAgent", () => {
  const agents = [agent("ali"), agent("sara"), agent("omar", { onDuty: false })];
  it("keeps the previous agent when available", () => {
    expect(pickAgent({ previousAgentId: "sara", agents, openCounts: new Map([["sara", 9]]) })?.id).toBe("sara");
  });
  it("otherwise picks the available agent with the fewest open chats", () => {
    expect(pickAgent({ previousAgentId: "omar", agents, openCounts: new Map([["ali", 3], ["sara", 1]]) })?.id).toBe("sara");
  });
  it("breaks ties by who got a chat longest ago", () => {
    expect(pickAgent({ previousAgentId: null, agents, openCounts: new Map(), lastAssignedAt: new Map([["ali", 200], ["sara", 100]]) })?.id).toBe("sara");
  });
  it("honours exclusions and returns null when nobody is on duty", () => {
    expect(pickAgent({ previousAgentId: "ali", agents, openCounts: new Map(), exclude: new Set(["ali"]) })?.id).toBe("sara");
    expect(pickAgent({ previousAgentId: null, agents: [agent("x", { enabled: false })], openCounts: new Map() })).toBeNull();
  });
});

describe("parseAgentMessage", () => {
  it("treats plain text as a reply, with an optional leading #code", () => {
    expect(parseAgentMessage("Your order is on the way")).toEqual({ kind: "reply", text: "Your order is on the way", code: null });
    expect(parseAgentMessage("#482 on the way")).toEqual({ kind: "reply", text: "on the way", code: 482 });
    expect(parseAgentMessage("Use code #123 at checkout")).toEqual({ kind: "reply", text: "Use code #123 at checkout", code: null });
  });
  it("reads commands", () => {
    expect(parseAgentMessage("/close")).toEqual({ kind: "close", code: null });
    expect(parseAgentMessage("/close #482")).toEqual({ kind: "close", code: 482 });
    expect(parseAgentMessage("/transfer Sara")).toEqual({ kind: "transfer", to: "Sara", code: null });
    expect(parseAgentMessage("/note called the store #482")).toEqual({ kind: "note", text: "called the store", code: 482 });
    expect(parseAgentMessage("/OFF")).toEqual({ kind: "off" });
    expect(parseAgentMessage("/on")).toEqual({ kind: "on" });
    expect(parseAgentMessage("/whatever")).toEqual({ kind: "help" });
  });
  it("splitCode", () => {
    expect(splitCode("#77 hello")).toEqual({ code: 77, rest: "hello" });
    expect(splitCode("no code")).toEqual({ code: null, rest: "no code" });
  });
});

describe("forwardText", () => {
  const now = new Date("2026-10-11T09:00:00Z");
  const card = { name: "Ahmed", phoneDigits: "966546182300", vip: true, totalOrders: 12, lastOrderDate: "2026-10-08" };
  it("introduces a new chat with masked number and facts", () => {
    expect(forwardText({ code: 482, card, body: "Where is my order?", intro: true, now })).toBe(
      "🟢 *#482 · Ahmed* (9665•••••300)\nVIP · 12 orders · last order 3 days ago\n\n“Where is my order?”\n\n_Swipe-reply to answer · /close · /transfer name · /info_",
    );
  });
  it("is short for follow-up messages", () => {
    expect(forwardText({ code: 482, card, body: "hello?", intro: false, now })).toBe("*#482 Ahmed:* “hello?”");
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-10-11T09:00:00Z");
  const mins = (m: number) => new Date(now.getTime() - m * 60_000);
  const base = { status: "open" as const, awaitingReply: true, agentId: "a", assignedAt: mins(30), lastCustomerAt: mins(11), remindedAt: null };
  it("is overdue after N minutes without an answer", () => {
    expect(isOverdue(base, 10, now)).toBe(true);
    expect(isOverdue({ ...base, lastCustomerAt: mins(5) }, 10, now)).toBe(false);
  });
  it("gives a newly assigned agent the full N minutes", () => {
    expect(isOverdue({ ...base, assignedAt: mins(3) }, 10, now)).toBe(false);
  });
  it("is not overdue once answered or closed; unassigned chats are always retried", () => {
    expect(isOverdue({ ...base, awaitingReply: false }, 10, now)).toBe(false);
    expect(isOverdue({ ...base, status: "closed" }, 10, now)).toBe(false);
    expect(isOverdue({ ...base, agentId: null, lastCustomerAt: mins(1) }, 10, now)).toBe(true);
  });
});

describe("botHandles", () => {
  const m = (text: string | null, extra: Partial<Parameters<typeof botHandles>[0]> = {}) =>
    botHandles({ text, interactiveReplyId: null, hasMedia: false, isStopStartOrLanguage: false, ...extra });
  it("keeps keywords, menu choices, greetings, thanks and emoji with the bot", () => {
    expect(m("STOP", { isStopStartOrLanguage: true })).toBe("keyword");
    expect(m("2", { interactiveReplyId: "العربية" })).toBe("menu_choice");
    for (const t of ["Hi", "hello!", "السلام عليكم", "مرحبا", "شكراً", "Thank you", "ok", "👍", "🙏🙏"]) expect(m(t)).not.toBeNull();
  });
  it("sends real questions, media and anything unclear to an agent", () => {
    expect(m("Where is my order?")).toBeNull();
    expect(m("وين طلبي")).toBeNull();
    expect(m("hi, my order is late")).toBeNull();
    expect(m("3")).toBeNull(); // a number that did not match any option
    expect(m(null, { hasMedia: true })).toBeNull();
  });
});
