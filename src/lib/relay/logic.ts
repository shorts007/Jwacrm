/**
 * Agent relay — pure rules (tested in logic.test.ts).
 *
 * Customers write to the WhatsApp app number; each chat (thread, "#482") is given to one agent,
 * whose personal WhatsApp receives a copy of every customer message. The agent swipe-replies
 * (or starts the message with #482) and the answer goes to the customer from the app number.
 */

export interface RelayAgent {
  id: string;
  name: string;
  phoneDigits: string;
  enabled: boolean;
  onDuty: boolean;
}

export const isAvailable = (a: RelayAgent | null | undefined): a is RelayAgent => !!a && a.enabled && a.onDuty;

/**
 * Who gets the chat: the agent who handled this customer last time if available, otherwise
 * the available agent with the fewest open chats (ties: the one who got a chat longest ago,
 * then by name). `exclude` = agents not to use (e.g. the one who did not answer in time).
 */
export function pickAgent(args: {
  previousAgentId: string | null;
  agents: RelayAgent[];
  openCounts: Map<string, number>;
  lastAssignedAt?: Map<string, number>;
  exclude?: Set<string>;
}): RelayAgent | null {
  const pool = args.agents.filter((a) => isAvailable(a) && !args.exclude?.has(a.id));
  const previous = pool.find((a) => a.id === args.previousAgentId);
  if (previous) return previous;
  const sorted = [...pool].sort(
    (a, b) =>
      (args.openCounts.get(a.id) ?? 0) - (args.openCounts.get(b.id) ?? 0) ||
      (args.lastAssignedAt?.get(a.id) ?? 0) - (args.lastAssignedAt?.get(b.id) ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return sorted[0] ?? null;
}

export type AgentCommand =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "close"; code: number | null }
  | { kind: "info"; code: number | null }
  | { kind: "transfer"; to: string; code: number | null }
  | { kind: "note"; text: string; code: number | null }
  | { kind: "reply"; text: string; code: number | null };

const CODE = /#(\d{2,9})\b/;

/** "#482 thanks" → { code: 482, rest: "thanks" } */
export function splitCode(text: string): { code: number | null; rest: string } {
  const m = CODE.exec(text);
  if (!m) return { code: null, rest: text.trim() };
  return { code: Number(m[1]), rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

/** What an agent's message means. Anything that is not a /command is a reply to the customer. */
export function parseAgentMessage(raw: string | null | undefined): AgentCommand {
  const text = (raw ?? "").trim();
  const cmd = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text);
  if (!cmd) {
    const { code, rest } = splitCode(text);
    // Only treat a leading "#482" as the target; a "#" inside the reply stays as typed.
    const leading = /^#\d{2,9}\b/.test(text);
    return { kind: "reply", text: leading ? rest : text, code: leading ? code : null };
  }
  const name = cmd[1].toLowerCase();
  const { code, rest } = splitCode(cmd[2] ?? "");
  switch (name) {
    case "on":
    case "online":
    case "start":
      return { kind: "on" };
    case "off":
    case "offline":
    case "away":
      return { kind: "off" };
    case "close":
    case "done":
      return { kind: "close", code };
    case "info":
      return { kind: "info", code };
    case "list":
    case "chats":
      return { kind: "list" };
    case "transfer":
    case "move":
      return { kind: "transfer", to: rest, code };
    case "note":
      return { kind: "note", text: rest, code };
    default:
      return { kind: "help" };
  }
}

export const HELP_TEXT = [
  "*How to answer customers*",
  "↩️ Swipe-reply to a customer's message (or start with its number, e.g. #482) and type your answer — it goes to the customer from the shop number.",
  "",
  "/close — finish the chat",
  "/transfer Sara — give the chat to another agent",
  "/note text — internal note (customer does not see it)",
  "/info — customer details",
  "/list — your open chats",
  "/off — stop receiving new chats · /on — start again",
].join("\n");

/** "9665•••••300" */
export const maskPhone = (digits: string) => {
  const d = digits.replace(/\D/g, "");
  return d.length <= 7 ? d : `${d.slice(0, 4)}${"•".repeat(Math.max(0, d.length - 7))}${d.slice(-3)}`;
};

export interface CustomerCard {
  name: string | null;
  phoneDigits: string;
  segment?: string | null;
  totalOrders?: number | null;
  lastOrderDate?: string | null;
  vip?: boolean | null;
}

const daysAgo = (date: string, now: Date) => {
  const d = Math.floor((now.getTime() - new Date(`${date}T12:00:00+03:00`).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

export function cardLine(c: CustomerCard, now: Date): string {
  const facts = [
    c.vip ? "VIP" : c.segment || null,
    typeof c.totalOrders === "number" ? `${c.totalOrders} order${c.totalOrders === 1 ? "" : "s"}` : null,
    c.lastOrderDate ? `last order ${daysAgo(c.lastOrderDate, now)}` : null,
  ].filter(Boolean);
  return facts.join(" · ");
}

/** What the agent sees for a customer message. `intro` = first message of a newly assigned chat. */
export function forwardText(args: {
  code: number;
  card: CustomerCard;
  body: string | null;
  intro: boolean;
  now: Date;
  handedOverFrom?: string | null;
}): string {
  const who = `${args.card.name?.trim() || "Customer"}`;
  const quote = args.body?.trim() ? `“${args.body.trim()}”` : "";
  if (!args.intro) return [`*#${args.code} ${who}:*`, quote].filter(Boolean).join(" ");
  const facts = cardLine(args.card, args.now);
  return [
    `🟢 *#${args.code} · ${who}* (${maskPhone(args.card.phoneDigits)})`,
    facts || null,
    args.handedOverFrom ? `↪️ Handed over from ${args.handedOverFrom} (no reply in time)` : null,
    "",
    quote || null,
    "",
    "_Swipe-reply to answer · /close · /transfer name · /info_",
  ]
    .filter((l) => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ThreadTiming {
  status: "open" | "closed";
  awaitingReply: boolean;
  agentId: string | null;
  assignedAt: Date | null;
  lastCustomerAt: Date | null;
  remindedAt: Date | null;
}

/**
 * Time to hand the chat to someone else: the customer is waiting, and the current agent has had
 * `minutes` since both the customer's message and the assignment without answering.
 */
export function isOverdue(t: ThreadTiming, minutes: number, now: Date): boolean {
  if (t.status !== "open" || !t.awaitingReply || !t.lastCustomerAt) return false;
  const limit = now.getTime() - minutes * 60_000;
  if (!t.agentId) return true; // nobody had it — try to assign whenever someone is on duty
  return t.lastCustomerAt.getTime() <= limit && (!t.assignedAt || t.assignedAt.getTime() <= limit);
}

/** Open chats with no customer or agent activity for this long are closed silently. */
export const AUTO_CLOSE_HOURS = 24;

// ------------------------------------------------------------------ what the bot handles

const SMALL_TALK = new Set(
  [
    "hi", "hello", "hey", "hii", "helo", "salam", "salaam", "assalamualaikum", "assalam alaikum", "good morning", "good evening",
    "ok", "okay", "k", "thanks", "thank you", "thank u", "thx", "ty", "noted", "fine", "great", "good", "nice", "sure", "yes", "no",
    "السلام عليكم", "سلام عليكم", "السلام", "سلام", "مرحبا", "مرحبا بك", "اهلا", "اهلين", "هلا", "صباح الخير", "مساء الخير",
    "شكرا", "شكرا لك", "شكرا جزيلا", "مشكور", "يعطيك العافيه", "تمام", "طيب", "اوكي", "اوك", "حسنا", "نعم", "لا", "جزاك الله خير",
  ].map((t) =>
    t
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .trim(),
  ),
);

/**
 * Messages the automatic replies already handle, so no agent is needed:
 *   - STOP / START and language choices (English / العربية) — LuLu opt-out & language handling;
 *   - a tap or numbered answer to our buttons / options ("1", "2", "English") — Flows / campaigns;
 *   - greetings, thanks, "ok", emoji-only and empty messages — the welcome / auto reply covers them.
 * Everything else (a real question, a photo, a voice note, a location…) goes to an agent.
 */
export function botHandles(m: {
  text: string | null;
  /** Set when the message answered our buttons / numbered options. */
  interactiveReplyId: string | null;
  hasMedia: boolean;
  isStopStartOrLanguage: boolean;
}): string | null {
  if (m.isStopStartOrLanguage) return "keyword";
  if (m.interactiveReplyId) return "menu_choice";
  if (m.hasMedia) return null;
  const raw = (m.text ?? "").trim();
  if (!raw) return "empty";
  // Only emoji / punctuation / digits-free symbols
  if (!/[\p{L}\p{N}]/u.test(raw)) return "emoji";
  const t = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= 30 && SMALL_TALK.has(t)) return "small_talk";
  return null;
}

