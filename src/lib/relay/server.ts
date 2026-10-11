/**
 * Agent relay — database + WhatsApp side. Rules live in ./logic.ts.
 *
 *   customer → app number → onCustomerMessage → copy to the assigned agent's WhatsApp
 *   agent    → app number → onAgentMessage    → reply to the customer (or a /command)
 *   sweep (every 1–2 min, and opportunistically on webhook traffic) → hand over chats that
 *   waited too long, assign chats nobody had, close chats idle for 24 h.
 *
 * Messages to agents go straight through Evolution (not "outreach": no daily limit) and are
 * never stored as customer chats.
 */
import { supabaseAdmin } from "@/lib/automations/admin-client";
import * as evo from "@/lib/evolution/client";
import { connFromRow, loadEvolutionConfig } from "@/lib/evolution/server";
import { sendMessageToConversation } from "@/lib/whatsapp/send-message";
import {
  AUTO_CLOSE_HOURS,
  HELP_TEXT,
  forwardText,
  isAvailable,
  isOverdue,
  maskPhone,
  parseAgentMessage,
  pickAgent,
  type CustomerCard,
  type RelayAgent,
} from "./logic";

const db = () => supabaseAdmin();

interface Settings {
  enabled: boolean;
  responseMinutes: number;
  offlineMessage: string | null;
  lastSweepAt: string | null;
}

interface ThreadRow {
  id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string | null;
  code: number;
  agent_id: string | null;
  status: "open" | "closed";
  awaiting_reply: boolean;
  assigned_at: string | null;
  last_customer_at: string | null;
  last_agent_reply_at: string | null;
  reminded_at: string | null;
  offline_sent_at: string | null;
  handovers: number;
  created_at: string;
}

const agentFromRow = (r: Record<string, unknown>): RelayAgent => ({
  id: r.id as string,
  name: r.name as string,
  phoneDigits: r.phone_digits as string,
  enabled: r.enabled !== false,
  onDuty: r.on_duty !== false,
});

/** Settings + agents, or null when the relay is off / not installed (migration 064). */
export async function loadRelay(accountId: string): Promise<{ settings: Settings; agents: RelayAgent[] } | null> {
  try {
    const [{ data: s, error: sErr }, { data: a, error: aErr }] = await Promise.all([
      db().from("relay_settings").select("enabled, response_minutes, offline_message, last_sweep_at").eq("account_id", accountId).maybeSingle(),
      db().from("relay_agents").select("id, name, phone_digits, enabled, on_duty").eq("account_id", accountId),
    ]);
    if (sErr || aErr || !s || !s.enabled) return null;
    return {
      settings: {
        enabled: true,
        responseMinutes: (s.response_minutes as number) ?? 10,
        offlineMessage: (s.offline_message as string | null) ?? null,
        lastSweepAt: (s.last_sweep_at as string | null) ?? null,
      },
      agents: (a ?? []).map((r) => agentFromRow(r as Record<string, unknown>)),
    };
  } catch {
    return null;
  }
}

async function evoConn(accountId: string): Promise<evo.EvolutionConn | null> {
  const row = await loadEvolutionConfig(accountId).catch(() => null);
  return row ? connFromRow(row) : null;
}

async function tell(conn: evo.EvolutionConn, agent: RelayAgent, text: string): Promise<string | null> {
  try {
    return (await evo.sendText(conn, agent.phoneDigits, text)).id;
  } catch (e) {
    console.warn(`[relay] could not message agent ${agent.name}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function customerCard(accountId: string, contactId: string | null): Promise<CustomerCard> {
  const { data: c } = contactId ? await db().from("contacts").select("name, phone").eq("id", contactId).maybeSingle() : { data: null };
  const digits = String(c?.phone ?? "").replace(/\D/g, "");
  const card: CustomerCard = { name: (c?.name as string | null) ?? null, phoneDigits: digits };
  if (digits) {
    const { data: p } = await db()
      .from("lulu_customer_profiles")
      .select("name, customer_segment, total_orders, last_order_date, vip_flag")
      .eq("account_id", accountId)
      .eq("mobile", `+${digits}`)
      .maybeSingle();
    if (p) {
      card.name = card.name && !/^\+?\d+$/.test(card.name) ? card.name : ((p.name as string | null) ?? card.name);
      card.segment = (p.customer_segment as string | null) ?? null;
      card.totalOrders = (p.total_orders as number | null) ?? null;
      card.lastOrderDate = (p.last_order_date as string | null) ?? null;
      card.vip = (p.vip_flag as boolean | null) ?? null;
    }
  }
  return card;
}

const mediaKind = (mime: string | null | undefined): "image" | "video" | "audio" | "document" | null => {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
};

export interface CustomerMessage {
  accountId: string;
  conversationId: string;
  contactId: string;
  messageId: string;
  text: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  /**
   * Why the automatic replies already cover this message (relay/logic botHandles), or null.
   * 'keyword' / 'menu_choice' never go to an agent; small talk / emoji only reach the agent
   * while they are in the middle of answering this customer.
   */
  botHandled?: string | null;
}

/** An agent answered this customer within this window → their "ok" / "thanks" still reaches the agent. */
const ACTIVE_CHAT_MS = 2 * 3_600_000;

interface ForwardItem {
  messageId: string;
  text: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
}

/** Send one customer message to an agent and remember the copy (so a swipe-reply finds the chat). */
async function forward(conn: evo.EvolutionConn, thread: ThreadRow, agent: RelayAgent, card: CustomerCard, item: ForwardItem, intro: boolean, handedOverFrom?: string | null) {
  const { data: dup } = await db()
    .from("relay_forwards")
    .select("id")
    .eq("thread_id", thread.id)
    .eq("agent_id", agent.id)
    .eq("source_message_id", item.messageId)
    .limit(1);
  if (dup && dup.length) return;
  const text = forwardText({ code: thread.code, card, body: item.text, intro, now: new Date(), handedOverFrom });
  const kind = mediaKind(item.mediaType);
  let id: string | null = null;
  try {
    if (item.mediaUrl && kind === "audio") {
      id = (await evo.sendText(conn, agent.phoneDigits, text)).id;
      await evo.sendAudio(conn, agent.phoneDigits, item.mediaUrl).catch(() => undefined);
    } else if (item.mediaUrl && kind && kind !== "audio") {
      id = (await evo.sendMedia(conn, agent.phoneDigits, { kind, url: item.mediaUrl, caption: text })).id;
    } else {
      id = (await evo.sendText(conn, agent.phoneDigits, text)).id;
    }
  } catch (e) {
    console.warn(`[relay] forward to ${agent.name} failed:`, e instanceof Error ? e.message : e);
    return;
  }
  await db()
    .from("relay_forwards")
    .insert({ account_id: thread.account_id, thread_id: thread.id, agent_id: agent.id, forward_message_id: id, source_message_id: item.messageId });
}

async function openCounts(accountId: string) {
  const { data } = await db().from("relay_threads").select("agent_id, assigned_at").eq("account_id", accountId).eq("status", "open");
  const counts = new Map<string, number>();
  const lastAssigned = new Map<string, number>();
  for (const r of data ?? []) {
    const a = r.agent_id as string | null;
    if (!a) continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    const t = r.assigned_at ? new Date(r.assigned_at as string).getTime() : 0;
    lastAssigned.set(a, Math.max(lastAssigned.get(a) ?? 0, t));
  }
  return { counts, lastAssigned };
}

/** Customer messages since the agent last answered (for a hand-over), oldest first. */
async function backlog(thread: ThreadRow, limit = 5): Promise<ForwardItem[]> {
  let q = db()
    .from("messages")
    .select("message_id, content_text, media_url, media_type, created_at")
    .eq("conversation_id", thread.conversation_id)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(limit);
  // Only what is still unanswered, and never older than a day.
  const dayAgo = Date.now() - 24 * 3_600_000;
  const since = Math.max(dayAgo, thread.last_agent_reply_at ? new Date(thread.last_agent_reply_at).getTime() : 0);
  q = q.gt("created_at", new Date(since).toISOString());
  const { data } = await q;
  return (data ?? [])
    .reverse()
    .map((m) => ({ messageId: m.message_id as string, text: (m.content_text as string | null) ?? null, mediaUrl: (m.media_url as string | null) ?? null, mediaType: (m.media_type as string | null) ?? null }));
}

/** Give a thread to `agent` and send them the waiting messages. */
async function assign(conn: evo.EvolutionConn, thread: ThreadRow, agent: RelayAgent, opts: { handedOverFrom?: string | null; items?: ForwardItem[] } = {}) {
  const now = new Date().toISOString();
  await db()
    .from("relay_threads")
    .update({
      agent_id: agent.id,
      assigned_at: now,
      reminded_at: null,
      updated_at: now,
      ...(opts.handedOverFrom ? { handovers: thread.handovers + 1 } : {}),
    })
    .eq("id", thread.id);
  const card = await customerCard(thread.account_id, thread.contact_id);
  const items = opts.items ?? (await backlog(thread));
  const fresh = { ...thread, agent_id: agent.id };
  if (items.length === 0) {
    await forward(conn, fresh, agent, card, { messageId: `intro-${thread.id}-${now}`, text: null, mediaUrl: null, mediaType: null }, true, opts.handedOverFrom);
    return;
  }
  for (let i = 0; i < items.length; i++) await forward(conn, fresh, agent, card, items[i], i === 0, i === 0 ? opts.handedOverFrom : null);
}

/** A customer wrote to the app number. Returns true when it was relayed (or queued for an agent). */
export async function onCustomerMessage(m: CustomerMessage): Promise<boolean> {
  const relay = await loadRelay(m.accountId);
  if (!relay) return false;
  const conn = await evoConn(m.accountId);
  if (!conn) return false;
  const now = new Date().toISOString();

  if (m.botHandled === "keyword" || m.botHandled === "menu_choice") return false;
  if (m.botHandled) {
    const { data: open } = await db()
      .from("relay_threads")
      .select("status, last_agent_reply_at")
      .eq("conversation_id", m.conversationId)
      .maybeSingle();
    const activeChat =
      open?.status === "open" && !!open.last_agent_reply_at && Date.now() - new Date(open.last_agent_reply_at as string).getTime() < ACTIVE_CHAT_MS;
    if (!activeChat) return false;
  }

  let { data: t } = await db().from("relay_threads").select("*").eq("conversation_id", m.conversationId).maybeSingle();
  let reopened = false;
  if (!t) {
    const ins = await db()
      .from("relay_threads")
      .insert({ account_id: m.accountId, conversation_id: m.conversationId, contact_id: m.contactId, last_customer_at: now, awaiting_reply: true })
      .select("*")
      .single();
    if (ins.error) {
      // lost a race with a parallel message — read the winner
      ({ data: t } = await db().from("relay_threads").select("*").eq("conversation_id", m.conversationId).maybeSingle());
    } else {
      t = ins.data;
      reopened = true;
    }
  } else if (t.status === "closed") {
    reopened = true;
  }
  if (!t) return false;
  const thread = t as ThreadRow;
  await db()
    .from("relay_threads")
    .update({ status: "open", awaiting_reply: true, last_customer_at: now, updated_at: now, ...(reopened ? { reminded_at: null } : {}) })
    .eq("id", thread.id);

  const item: ForwardItem = { messageId: m.messageId, text: m.text, mediaUrl: m.mediaUrl, mediaType: m.mediaType };
  const current = relay.agents.find((a) => a.id === thread.agent_id);
  if (isAvailable(current)) {
    const card = await customerCard(m.accountId, thread.contact_id);
    await forward(conn, thread, current, card, item, reopened);
    return true;
  }
  const { counts, lastAssigned } = await openCounts(m.accountId);
  const next = pickAgent({ previousAgentId: thread.agent_id, agents: relay.agents, openCounts: counts, lastAssignedAt: lastAssigned });
  if (next) {
    await assign(conn, { ...thread, status: "open" }, next, { items: undefined });
    return true;
  }
  // Nobody on duty: tell the customer once in a while (if a message is set) and wait for the sweep.
  const lastOffline = thread.offline_sent_at ? new Date(thread.offline_sent_at).getTime() : 0;
  if (relay.settings.offlineMessage && Date.now() - lastOffline > 12 * 3_600_000) {
    try {
      await sendMessageToConversation(db(), m.accountId, { conversationId: m.conversationId, messageType: "text", contentText: relay.settings.offlineMessage });
      await db().from("relay_threads").update({ offline_sent_at: now }).eq("id", thread.id);
    } catch (e) {
      console.warn("[relay] offline message failed:", e instanceof Error ? e.message : e);
    }
  }
  return true;
}

/** The agent registered under this number (enabled), when the relay is on. */
export async function findAgent(accountId: string, phoneDigits: string): Promise<{ agent: RelayAgent; settings: Settings; agents: RelayAgent[] } | null> {
  const relay = await loadRelay(accountId);
  if (!relay) return null;
  const agent = relay.agents.find((a) => a.phoneDigits === phoneDigits && a.enabled);
  return agent ? { agent, settings: relay.settings, agents: relay.agents } : null;
}

/** Is this number one of the account's agents (enabled or not)? Used to keep staff out of the customer inbox. */
export async function isAgentNumber(accountId: string, phoneDigits: string): Promise<boolean> {
  try {
    const { data } = await db().from("relay_agents").select("id").eq("account_id", accountId).eq("phone_digits", phoneDigits).limit(1);
    return !!data && data.length > 0;
  } catch {
    return false;
  }
}

export interface AgentMessage {
  id: string;
  text: string | null;
  quotedId: string | null;
  /** Public URL of a photo / document / voice note the agent sent (already stored). */
  mediaUrl: string | null;
  mediaType: string | null;
}

async function threadByCode(accountId: string, code: number): Promise<ThreadRow | null> {
  const { data } = await db().from("relay_threads").select("*").eq("account_id", accountId).eq("code", code).maybeSingle();
  return (data as ThreadRow | null) ?? null;
}

async function myOpenThreads(accountId: string, agentId: string): Promise<ThreadRow[]> {
  const { data } = await db()
    .from("relay_threads")
    .select("*")
    .eq("account_id", accountId)
    .eq("agent_id", agentId)
    .eq("status", "open")
    .order("last_customer_at", { ascending: false })
    .limit(20);
  return (data ?? []) as ThreadRow[];
}

async function listText(accountId: string, threads: ThreadRow[]): Promise<string> {
  if (threads.length === 0) return "You have no open chats.";
  const lines = await Promise.all(
    threads.map(async (t) => {
      const card = await customerCard(accountId, t.contact_id);
      const wait = t.awaiting_reply && t.last_customer_at ? ` — waiting ${Math.max(1, Math.round((Date.now() - new Date(t.last_customer_at).getTime()) / 60_000))} min` : "";
      return `#${t.code} ${card.name ?? maskPhone(card.phoneDigits)}${wait}`;
    }),
  );
  return `*Your open chats*\n${lines.join("\n")}`;
}

/** An agent wrote to the app number: a reply for a customer, or a /command. */
export async function onAgentMessage(accountId: string, found: { agent: RelayAgent; agents: RelayAgent[]; settings: Settings }, msg: AgentMessage): Promise<string> {
  const conn = await evoConn(accountId);
  if (!conn) return "no_connection";
  const { agent } = found;
  const now = new Date().toISOString();
  await db().from("relay_agents").update({ last_seen_at: now }).eq("id", agent.id);
  const cmd = parseAgentMessage(msg.text);
  const react = (emoji: string) =>
    evo.sendReaction(conn, { remoteJid: evo.userJid(agent.phoneDigits), fromMe: false, id: msg.id }, emoji).catch(() => undefined);

  if (cmd.kind === "on" || cmd.kind === "off") {
    await db().from("relay_agents").update({ on_duty: cmd.kind === "on" }).eq("id", agent.id);
    await tell(conn, agent, cmd.kind === "on" ? "✅ You are on duty — new chats will come to you." : "⏸️ You are off duty — your waiting chats go to other agents.");
    if (cmd.kind === "off") await sweep(accountId, { force: true });
    return `agent_${cmd.kind}`;
  }
  if (cmd.kind === "help") {
    await tell(conn, agent, HELP_TEXT);
    return "agent_help";
  }
  if (cmd.kind === "list") {
    await tell(conn, agent, await listText(accountId, await myOpenThreads(accountId, agent.id)));
    return "agent_list";
  }

  // Which chat? A swipe-reply on a forwarded message, else "#482", else the agent's only open chat.
  let thread: ThreadRow | null = null;
  if (msg.quotedId) {
    const { data: f } = await db().from("relay_forwards").select("thread_id").eq("account_id", accountId).eq("forward_message_id", msg.quotedId).limit(1);
    if (f?.[0]) {
      const { data } = await db().from("relay_threads").select("*").eq("id", f[0].thread_id).maybeSingle();
      thread = (data as ThreadRow | null) ?? null;
    }
  }
  if (!thread && cmd.code) thread = await threadByCode(accountId, cmd.code);
  if (!thread) {
    const mine = await myOpenThreads(accountId, agent.id);
    if (mine.length === 1) thread = mine[0];
    else {
      await tell(
        conn,
        agent,
        `⚠️ Not sent — which customer is this for? Swipe-reply to their message, or start with their number (e.g. #${mine[0]?.code ?? 482}).\n\n${await listText(accountId, mine)}`,
      );
      return "agent_no_target";
    }
  }
  const card = await customerCard(accountId, thread.contact_id);
  const label = `#${thread.code} ${card.name ?? maskPhone(card.phoneDigits)}`;

  switch (cmd.kind) {
    case "close":
      await db().from("relay_threads").update({ status: "closed", awaiting_reply: false, updated_at: now }).eq("id", thread.id);
      await tell(conn, agent, `✅ ${label} closed.`);
      return "agent_close";
    case "info": {
      const { data: recent } = await db()
        .from("messages")
        .select("sender_type, content_text, created_at")
        .eq("conversation_id", thread.conversation_id)
        .order("created_at", { ascending: false })
        .limit(4);
      const last = (recent ?? [])
        .reverse()
        .map((r) => `${r.sender_type === "customer" ? "👤" : "🏪"} ${(r.content_text as string | null)?.slice(0, 80) ?? "[media]"}`)
        .join("\n");
      const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
      await tell(
        conn,
        agent,
        [`*${label}* (${maskPhone(card.phoneDigits)})`, [card.vip ? "VIP" : card.segment, card.totalOrders != null ? `${card.totalOrders} orders` : null, card.lastOrderDate ? `last order ${card.lastOrderDate}` : null].filter(Boolean).join(" · "), "", last, site ? `\n${site}/inbox?c=${thread.conversation_id}` : ""]
          .filter((l) => l !== undefined)
          .join("\n")
          .trim(),
      );
      return "agent_info";
    }
    case "note": {
      if (!cmd.text) {
        await tell(conn, agent, "Write the note after /note, e.g. /note customer will call back at 5 pm");
        return "agent_note_empty";
      }
      const { data: conv } = await db().from("conversations").select("user_id").eq("id", thread.conversation_id).maybeSingle();
      if (thread.contact_id && conv?.user_id) {
        await db().from("contact_notes").insert({ contact_id: thread.contact_id, account_id: accountId, user_id: conv.user_id, note_text: `[${agent.name} via WhatsApp] ${cmd.text}` });
      }
      await react("📝");
      return "agent_note";
    }
    case "transfer": {
      const want = cmd.to.trim().toLowerCase();
      const target = found.agents.find((a) => a.enabled && a.id !== agent.id && want && a.name.toLowerCase().startsWith(want));
      if (!target) {
        const names = found.agents.filter((a) => a.enabled && a.id !== agent.id).map((a) => `${a.name}${a.onDuty ? "" : " (off duty)"}`);
        await tell(conn, agent, `⚠️ No agent called “${cmd.to}”. Agents: ${names.join(", ") || "none"}`);
        return "agent_transfer_unknown";
      }
      await assign(conn, thread, target, { handedOverFrom: null, items: await backlog(thread, 5) });
      await tell(conn, target, `↪️ ${agent.name} transferred ${label} to you.`);
      await tell(conn, agent, `✅ ${label} transferred to ${target.name}.`);
      return "agent_transfer";
    }
    case "reply": {
      const text = cmd.text;
      if (!text && !msg.mediaUrl) return "agent_empty";
      const kind = mediaKind(msg.mediaType);
      try {
        await sendMessageToConversation(db(), accountId, {
          conversationId: thread.conversation_id,
          messageType: msg.mediaUrl && kind ? kind : "text",
          contentText: text || null,
          mediaUrl: msg.mediaUrl,
        });
      } catch (e) {
        await tell(conn, agent, `⚠️ Not delivered to ${label}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600));
        return "agent_reply_failed";
      }
      await db()
        .from("relay_threads")
        .update({ agent_id: agent.id, status: "open", awaiting_reply: false, last_agent_reply_at: now, reminded_at: null, updated_at: now })
        .eq("id", thread.id);
      await react("✅");
      return "agent_reply_sent";
    }
  }
  return "agent_unhandled";
}

/**
 * Hand over / assign / close. Throttled to once a minute per account unless forced.
 * Returns what it did (for logs and the sweep API).
 */
export async function sweep(accountId: string, opts: { force?: boolean } = {}): Promise<{ handedOver: number; assigned: number; reminded: number; closed: number } | null> {
  const relay = await loadRelay(accountId);
  if (!relay) return null;
  const nowMs = Date.now();
  if (!opts.force && relay.settings.lastSweepAt && nowMs - new Date(relay.settings.lastSweepAt).getTime() < 55_000) return null;
  await db().from("relay_settings").update({ last_sweep_at: new Date().toISOString() }).eq("account_id", accountId);
  const conn = await evoConn(accountId);
  if (!conn) return null;

  const { data } = await db().from("relay_threads").select("*").eq("account_id", accountId).eq("status", "open").limit(500);
  const threads = (data ?? []) as ThreadRow[];
  const byId = new Map(relay.agents.map((a) => [a.id, a]));
  const result = { handedOver: 0, assigned: 0, reminded: 0, closed: 0 };
  const now = new Date(nowMs);

  for (const t of threads) {
    const lastActivity = Math.max(...[t.last_customer_at, t.last_agent_reply_at, t.assigned_at, t.created_at].map((x) => (x ? new Date(x).getTime() : 0)));
    if (nowMs - lastActivity > AUTO_CLOSE_HOURS * 3_600_000) {
      await db().from("relay_threads").update({ status: "closed", awaiting_reply: false, updated_at: now.toISOString() }).eq("id", t.id);
      result.closed++;
      continue;
    }
    if (!t.awaiting_reply) continue;
    const current = t.agent_id ? byId.get(t.agent_id) : undefined;
    const overdue = isOverdue(
      {
        status: t.status,
        awaitingReply: t.awaiting_reply,
        agentId: t.agent_id,
        assignedAt: t.assigned_at ? new Date(t.assigned_at) : null,
        lastCustomerAt: t.last_customer_at ? new Date(t.last_customer_at) : null,
        remindedAt: t.reminded_at ? new Date(t.reminded_at) : null,
      },
      relay.settings.responseMinutes,
      now,
    );
    if (isAvailable(current) && !overdue) continue;

    const { counts, lastAssigned } = await openCounts(accountId);
    const exclude = new Set<string>(current ? [current.id] : []);
    const next = pickAgent({ previousAgentId: null, agents: relay.agents, openCounts: counts, lastAssignedAt: lastAssigned, exclude });
    if (next) {
      const from = current?.name ?? null;
      await assign(conn, t, next, { handedOverFrom: current ? from : null });
      if (current && isAvailable(current)) {
        const card = await customerCard(accountId, t.contact_id);
        await tell(conn, current, `↪️ #${t.code} ${card.name ?? ""} moved to ${next.name} — no reply within ${relay.settings.responseMinutes} min.`.replace(/\s+—/, " —"));
      }
      if (current) result.handedOver++;
      else result.assigned++;
    } else if (isAvailable(current) && !t.reminded_at) {
      const card = await customerCard(accountId, t.contact_id);
      await tell(conn, current, `⏰ #${t.code} ${card.name ?? maskPhone(card.phoneDigits)} has been waiting ${relay.settings.responseMinutes}+ min — nobody else is on duty.`);
      await db().from("relay_threads").update({ reminded_at: now.toISOString() }).eq("id", t.id);
      result.reminded++;
    }
  }
  return result;
}
