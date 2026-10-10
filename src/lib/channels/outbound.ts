/**
 * Outbound transport — one place that decides which WhatsApp number a message leaves from and
 * sends it there: Meta Cloud API (official, templates, 24h window) or Evolution API (a WhatsApp
 * Business app number linked by QR; no templates, no 24h window).
 *
 * Which channel?
 *   1. `channel: 'meta' | 'evolution'` asked for explicitly → that one.
 *   2. `channel: 'default'` (campaigns, broadcasts, tests: business-initiated outreach)
 *      → the account default: Evolution when "Send through this number" is on, else Meta.
 *   3. Otherwise (replies: inbox, flows, automations, AI) → the conversation's channel, i.e. the
 *      number the customer last wrote to or we last wrote from; the account default if unknown.
 *
 * Every CRM send path (inbox, public API, LuLu campaigns, broadcasts, flows, automations, AI
 * replies, reactions, typing) goes through these helpers, so all features work on both numbers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt, encrypt, isLegacyFormat } from "@/lib/whatsapp/encryption";
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  sendTypingIndicator,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from "@/lib/whatsapp/meta-api";
import type { MessageTemplate } from "@/types";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";
import * as evo from "@/lib/evolution/client";
import { renderInteractive, renderTemplate } from "@/lib/evolution/render";

export type Channel = "meta" | "evolution";
export type ChannelRequest = Channel | "default";

export type Transport =
  | { channel: "meta"; phoneNumberId: string; accessToken: string }
  | { channel: "evolution"; conn: evo.EvolutionConn; /** business-initiated: add a human-like typing pause */ outreach: boolean };

export class ChannelError extends Error {
  constructor(
    message: string,
    public code: "not_configured" | "disconnected" | "unsupported",
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface EvolutionAvailability {
  configured: boolean;
  isDefault: boolean;
}

/** Pure channel decision (see the header). */
export function pickChannel(args: { requested?: ChannelRequest | null; conversationChannel?: string | null; evolution: EvolutionAvailability }): Channel {
  const accountDefault: Channel = args.evolution.configured && args.evolution.isDefault ? "evolution" : "meta";
  if (args.requested === "meta" || args.requested === "evolution") return args.requested;
  if (args.requested === "default") return accountDefault;
  if (args.conversationChannel === "evolution") return args.evolution.configured ? "evolution" : "meta";
  if (args.conversationChannel === "meta") return "meta";
  return accountDefault;
}

interface EvoRow {
  base_url: string;
  instance_name: string;
  api_key: string;
  state: string;
  is_default_outbound: boolean;
}

async function loadEvolution(accountId: string): Promise<EvoRow | null> {
  let res: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    res = await supabaseAdmin()
      .from("evolution_config")
      .select("base_url, instance_name, api_key, state, is_default_outbound")
      .eq("account_id", accountId)
      .maybeSingle();
  } catch (e) {
    console.warn("[outbound] evolution_config unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
  if (res.error) {
    // Table missing (migration 061 not run) → behave as "Meta only".
    if (res.error.code === "42P01" || res.error.code === "PGRST205" || /evolution_config/.test(res.error.message ?? "")) return null;
    throw new Error(`Could not read the sending setup: ${res.error.message}`);
  }
  return (res.data as EvoRow | null) ?? null;
}

/** Account-level sending setup, for UI hints (no secrets). */
export async function outboundSummary(accountId: string): Promise<{ evolutionConfigured: boolean; evolutionDefault: boolean; evolutionState: string | null }> {
  const row = await loadEvolution(accountId);
  return { evolutionConfigured: !!row, evolutionDefault: !!row?.is_default_outbound, evolutionState: row?.state ?? null };
}

/**
 * Resolve the transport for a send. `db` is only used for the Meta config (account-scoped);
 * the Evolution config is read with the service role (it holds an API key and has no RLS policies).
 */
type ResolveOpts = {
  conversationId?: string | null;
  conversationChannel?: string | null;
  channel?: ChannelRequest | null;
  /** Re-encrypt a legacy CBC Meta token (the inbox send path has always done this). */
  healLegacyToken?: boolean;
};

async function decide(accountId: string, opts: ResolveOpts): Promise<{ channel: Channel; evoRow: EvoRow | null }> {
  const evoRow = await loadEvolution(accountId);
  let conversationChannel = opts.conversationChannel ?? null;
  if (conversationChannel === null && opts.conversationId && !opts.channel && evoRow) {
    const { data } = await supabaseAdmin().from("conversations").select("channel").eq("id", opts.conversationId).eq("account_id", accountId).maybeSingle();
    conversationChannel = (data as { channel?: string | null } | null)?.channel ?? null;
  }
  const channel = pickChannel({
    requested: opts.channel ?? null,
    conversationChannel,
    evolution: { configured: !!evoRow, isDefault: !!evoRow?.is_default_outbound },
  });
  return { channel, evoRow };
}

/** Which number a send would use, without loading any credentials. */
export async function channelFor(accountId: string, opts: ResolveOpts = {}): Promise<Channel> {
  return (await decide(accountId, opts)).channel;
}

export async function resolveTransport(db: SupabaseClient, accountId: string, opts: ResolveOpts = {}): Promise<Transport> {
  const { channel, evoRow } = await decide(accountId, opts);

  if (channel === "evolution") {
    if (!evoRow) throw new ChannelError("The WhatsApp app number (Evolution) is not set up — Engagement → Channels.", "not_configured");
    const conn = { baseUrl: evoRow.base_url, instance: evoRow.instance_name, apiKey: decrypt(evoRow.api_key) };
    if (evoRow.state === "close") {
      // The last event said "closed" — Baileys usually reconnects by itself, so ask before failing.
      const live = await evo.connectionState(conn).catch(() => "unknown" as const);
      if (live !== "open") {
        throw new ChannelError("The WhatsApp app number is disconnected — reconnect it on Engagement → Channels (scan the QR code).", "disconnected");
      }
      await supabaseAdmin().from("evolution_config").update({ state: "open" }).eq("account_id", accountId);
    }
    return { channel: "evolution", conn, outreach: opts.channel === "default" };
  }

  const { data: config, error } = await db.from("whatsapp_config").select("id, phone_number_id, access_token").eq("account_id", accountId).single();
  if (error || !config) {
    throw new ChannelError("WhatsApp not configured. Please set up your WhatsApp integration first.", "not_configured");
  }
  const accessToken = decrypt(config.access_token);
  // Self-heal legacy CBC ciphertexts (fire-and-forget, idempotent) — as send-message always did.
  if (opts.healLegacyToken && isLegacyFormat(config.access_token)) {
    void db
      .from("whatsapp_config")
      .update({ access_token: encrypt(accessToken) })
      .eq("id", config.id)
      .then(({ error: e }: { error: { message: string } | null }) => {
        if (e) console.warn("[outbound] access_token GCM upgrade failed:", e.message);
      });
  }
  return { channel: "meta", phoneNumberId: config.phone_number_id, accessToken };
}

/** After a successful send, remember the conversation's channel so replies use the same number. */
export async function rememberConversationChannel(accountId: string, conversationId: string | null | undefined, t: Transport): Promise<void> {
  // Only the WhatsApp app number needs remembering: an unset channel already falls back to the
  // account default, and Meta chats are stamped by the Meta webhook when the customer writes.
  if (!conversationId || t.channel !== "evolution") return;
  try {
    const { error } = await supabaseAdmin()
      .from("conversations")
      .update({ channel: "evolution" })
      .eq("id", conversationId)
      .eq("account_id", accountId);
    if (error) console.warn("[outbound] channel stamp failed:", error.message);
  } catch (e) {
    console.warn("[outbound] channel stamp failed:", e instanceof Error ? e.message : e);
  }
}

// ------------------------------------------------------------------ sending

/**
 * Gap between broadcast recipients on the WhatsApp app number (2–4 s, random) — a burst of
 * identical messages is the quickest way to get an app number banned. Meta: no pause.
 * Large sends belong in Engagement → Campaigns, which paces 100/day with 60 s+ gaps.
 */
export async function evolutionBroadcastPause(t: Transport): Promise<void> {
  if (t.channel !== "evolution") return;
  await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
}

const humanPause = (t: Transport) => (t.channel === "evolution" && t.outreach ? 1500 + Math.floor(Math.random() * 2500) : undefined);

function needPhone(t: Transport, to: string): string {
  const d = to.replace(/\D/g, "");
  if (t.channel === "evolution" && d.length < 8) {
    throw new ChannelError("This contact has no phone number — the WhatsApp app number can only message phone numbers.", "unsupported");
  }
  return d;
}

const evoId = (id: string | null) => id ?? `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function sendTextVia(t: Transport, a: { to: string; text: string; contextMessageId?: string }): Promise<{ messageId: string }> {
  if (t.channel === "meta") return sendTextMessage({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, ...a });
  const r = await evo.sendText(t.conn, needPhone(t, a.to), a.text, { delayMs: humanPause(t) });
  return { messageId: evoId(r.id) };
}

export async function sendMediaVia(
  t: Transport,
  a: { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; contextMessageId?: string },
): Promise<{ messageId: string }> {
  if (t.channel === "meta") return sendMediaMessage({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, ...a });
  const to = needPhone(t, a.to);
  if (a.kind === "audio") return { messageId: evoId((await evo.sendAudio(t.conn, to, a.link)).id) };
  const r = await evo.sendMedia(t.conn, to, { kind: a.kind, url: a.link, caption: a.caption, fileName: a.filename, delayMs: humanPause(t) });
  return { messageId: evoId(r.id) };
}

export async function sendTemplateVia(
  t: Transport,
  a: {
    to: string;
    templateName: string;
    language?: string;
    template?: MessageTemplate | null;
    messageParams?: SendTimeParams;
    params?: string[];
    contextMessageId?: string;
  },
): Promise<{ messageId: string }> {
  if (t.channel === "meta") {
    return sendTemplateMessage({
      phoneNumberId: t.phoneNumberId,
      accessToken: t.accessToken,
      to: a.to,
      templateName: a.templateName,
      language: a.language,
      template: a.template ?? undefined,
      messageParams: a.messageParams,
      params: a.params,
      contextMessageId: a.contextMessageId,
    });
  }
  const to = needPhone(t, a.to);
  let rendered;
  try {
    rendered = renderTemplate(a.template, a.messageParams, a.params);
  } catch (e) {
    throw new ChannelError(e instanceof Error ? e.message : String(e), "unsupported");
  }
  if (rendered.media) {
    const r = await evo.sendMedia(t.conn, to, { kind: rendered.media.kind, url: rendered.media.url, caption: rendered.text, delayMs: humanPause(t) });
    return { messageId: evoId(r.id) };
  }
  const r = await evo.sendText(t.conn, to, rendered.text, { delayMs: humanPause(t) });
  return { messageId: evoId(r.id) };
}

export async function sendButtonsVia(
  t: Transport,
  a: { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: InteractiveButton[]; contextMessageId?: string },
): Promise<{ messageId: string }> {
  if (t.channel === "meta") return sendInteractiveButtons({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, ...a });
  const text = renderInteractive({ kind: "buttons", body: a.bodyText, header: a.headerText, footer: a.footerText, buttons: a.buttons });
  const r = await evo.sendText(t.conn, needPhone(t, a.to), text, { delayMs: humanPause(t) });
  return { messageId: evoId(r.id) };
}

export async function sendListVia(
  t: Transport,
  a: { to: string; bodyText: string; buttonLabel: string; headerText?: string; footerText?: string; sections: InteractiveListSection[]; contextMessageId?: string },
): Promise<{ messageId: string }> {
  if (t.channel === "meta") return sendInteractiveList({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, ...a });
  const text = renderInteractive({ kind: "list", body: a.bodyText, header: a.headerText, footer: a.footerText, button_label: a.buttonLabel, sections: a.sections });
  const r = await evo.sendText(t.conn, needPhone(t, a.to), text, { delayMs: humanPause(t) });
  return { messageId: evoId(r.id) };
}

/** React to a message. `targetFromMe` = the target is one of ours (agent/bot), not the customer's. */
export async function sendReactionVia(t: Transport, a: { to: string; targetMessageId: string; targetFromMe: boolean; emoji: string }): Promise<void> {
  if (t.channel === "meta") {
    await sendReactionMessage({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, to: a.to, targetMessageId: a.targetMessageId, emoji: a.emoji });
    return;
  }
  await evo.sendReaction(t.conn, { remoteJid: evo.userJid(needPhone(t, a.to)), fromMe: a.targetFromMe, id: a.targetMessageId }, a.emoji);
}

/** Mark the customer's message read and show "typing…" (best effort — never throws). */
export async function typingVia(t: Transport, a: { to: string; inboundMessageId: string }): Promise<void> {
  try {
    if (t.channel === "meta") {
      await sendTypingIndicator({ phoneNumberId: t.phoneNumberId, accessToken: t.accessToken, messageId: a.inboundMessageId });
      return;
    }
    const to = needPhone(t, a.to);
    await evo.markRead(t.conn, [{ remoteJid: evo.userJid(to), fromMe: false, id: a.inboundMessageId }]).catch(() => undefined);
    // Evolution holds the request open for the whole typing period — don't make the reply wait for it.
    void evo.sendPresence(t.conn, to, 3000).catch(() => undefined);
  } catch (e) {
    console.warn("[outbound] typing indicator failed:", e instanceof Error ? e.message : e);
  }
}
