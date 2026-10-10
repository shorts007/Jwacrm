/**
 * Evolution API → CRM inbox.
 *
 *   customer messages   → the same pipeline as the Meta webhook (@/lib/whatsapp/inbound):
 *                         contact + conversation, message row, unread, flows, automations,
 *                         AI auto-reply, public webhooks (LuLu STOP/language handling included).
 *                         A typed "1" / "English" answering our numbered options is turned
 *                         into the button tap it stands for.
 *   messages typed on the phone (WhatsApp Business app) → stored as agent messages so the
 *                         inbox shows the whole conversation; they pause an active Flow, like
 *                         an agent reply from the inbox.
 *   delivery / read receipts → the same status handler as Meta (messages, broadcast recipients,
 *                         message.status_updated webhooks).
 */
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { mirrorInboundMedia, normalizeMimeType } from "@/lib/whatsapp/mirror-inbound-media";
import {
  findOrCreateContact,
  findOrCreateConversation,
  handleStatusUpdate,
  lookupInternalIdByMetaId,
  processMessage,
  type ParsedInboundContent,
  type WhatsAppMessage,
} from "@/lib/whatsapp/inbound";
import { resolveInboundIdentity } from "@/lib/whatsapp/wa-identity";
import { resolveTemplateRow } from "@/lib/whatsapp/template-body";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";
import { getBase64FromMedia, type EvolutionConn } from "./client";
import { interactiveReplyOptions, matchReplyOption, templateReplyOptions } from "./render";
import { normalizeUpdates, normalizeUpsert, type NormalizedMessage } from "./normalize";

export interface ReceiveContext {
  accountId: string;
  /** Audit user for contact / conversation inserts (NOT NULL user_id). */
  ownerUserId: string;
  conn: EvolutionConn;
}

/** The admin who connected the number, else the Meta config owner, else any account member. */
export async function resolveOwnerUserId(accountId: string, createdBy: string | null | undefined): Promise<string | null> {
  if (createdBy) return createdBy;
  const db = supabaseAdmin();
  const { data: wa } = await db.from("whatsapp_config").select("user_id").eq("account_id", accountId).maybeSingle();
  if (wa?.user_id) return wa.user_id as string;
  const { data: p } = await db.from("profiles").select("user_id").eq("account_id", accountId).order("created_at", { ascending: true }).limit(1);
  return (p?.[0]?.user_id as string | undefined) ?? null;
}

const META_TYPE: Record<NormalizedMessage["type"], string> = {
  text: "text",
  reply: "interactive",
  image: "image",
  video: "video",
  document: "document",
  audio: "audio",
  sticker: "sticker",
  location: "location",
  reaction: "reaction",
  contact: "text",
  unknown: "text",
};

/** Store media (base64 from the webhook, or fetched from Evolution) in chat-media. */
async function storeMedia(n: NormalizedMessage, ctx: ReceiveContext): Promise<{ url: string | null; mime: string | null }> {
  let b64 = n.media?.base64 ?? null;
  let mime = n.media?.mimetype ?? null;
  let fileName = n.media?.fileName ?? null;
  if (!b64) {
    try {
      const r = await getBase64FromMedia(ctx.conn, n.id);
      b64 = r.base64;
      mime = mime ?? r.mimetype;
      fileName = fileName ?? r.fileName;
    } catch (e) {
      console.warn("[evolution] media download failed:", e instanceof Error ? e.message : e);
    }
  }
  if (!b64) return { url: null, mime };
  const raw = b64.includes(",") && b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const buffer = Buffer.from(raw, "base64");
  const url = await mirrorInboundMedia({
    storage: supabaseAdmin().storage,
    accountId: ctx.accountId,
    mediaId: n.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "evo",
    downloadUrl: "",
    accessToken: "",
    mimeType: mime,
    fileSize: buffer.byteLength,
    fileName,
    messageTimestamp: n.timestamp,
    download: async () => ({ buffer, contentType: normalizeMimeType(mime) ?? "application/octet-stream" }),
  });
  return { url, mime: normalizeMimeType(mime) };
}

/** Options offered by our latest message in the chat (numbered buttons / list / template quick replies). */
async function lastOfferedOptions(accountId: string, conversationId: string) {
  const db = supabaseAdmin();
  const { data } = await db
    .from("messages")
    .select("content_type, template_name, interactive_payload, created_at")
    .eq("conversation_id", conversationId)
    .in("sender_type", ["agent", "bot"])
    .order("created_at", { ascending: false })
    .limit(1);
  const last = data?.[0] as { content_type?: string; template_name?: string | null; interactive_payload?: unknown; created_at?: string } | undefined;
  if (!last?.created_at || Date.now() - new Date(last.created_at).getTime() > 7 * 24 * 3600_000) return [];
  if (last.content_type === "interactive") return interactiveReplyOptions(last.interactive_payload as InteractiveMessagePayload);
  if (last.content_type === "template" && last.template_name) {
    const { row } = await resolveTemplateRow(db, accountId, last.template_name, null);
    return templateReplyOptions(row);
  }
  return [];
}

async function contentFor(n: NormalizedMessage, ctx: ReceiveContext, conversationId: string | null): Promise<ParsedInboundContent> {
  const empty: ParsedInboundContent = { contentText: null, mediaUrl: null, mediaType: null, interactiveReplyId: null };
  if (n.type === "reply" && n.reply) return { ...empty, contentText: n.reply.title, interactiveReplyId: n.reply.id, contentType: "interactive" };
  if (n.type === "text" && conversationId && !n.fromMe) {
    const options = await lastOfferedOptions(ctx.accountId, conversationId);
    const hit = matchReplyOption(n.text, options);
    if (hit) return { ...empty, contentText: hit.title, interactiveReplyId: hit.id, contentType: "interactive" };
  }
  if (["image", "video", "document", "audio", "sticker"].includes(n.type)) {
    const { url, mime } = await storeMedia(n, ctx);
    return { ...empty, contentText: n.text, mediaUrl: url, mediaType: mime };
  }
  return { ...empty, contentText: n.text };
}

/** A customer message → the shared inbound pipeline. */
async function receiveCustomerMessage(n: NormalizedMessage, ctx: ReceiveContext): Promise<string> {
  const phone = n.phone!;
  const message: WhatsAppMessage = {
    id: n.id,
    from: phone,
    timestamp: n.timestamp,
    type: META_TYPE[n.type],
    ...(n.type === "text" ? { text: { body: n.text ?? "" } } : {}),
    ...(n.reaction ? { reaction: { message_id: n.reaction.targetId, emoji: n.reaction.emoji } } : {}),
    ...(n.quotedId ? { context: { id: n.quotedId } } : {}),
  };
  await processMessage(
    message,
    { profile: { name: n.pushName ?? undefined }, wa_id: phone },
    ctx.accountId,
    ctx.ownerUserId,
    "",
    false,
    { channel: "evolution", parseContent: ({ conversationId }) => contentFor(n, ctx, conversationId) },
  );
  return n.type === "reaction" ? "reaction" : "received";
}

/** A message typed on the phone itself → stored as an agent message (no automations). */
async function recordPhoneMessage(n: NormalizedMessage, ctx: ReceiveContext): Promise<string> {
  const db = supabaseAdmin();
  // Our own API sends can echo back here; give the sender a moment to store its row first.
  await new Promise((r) => setTimeout(r, 4000));
  const { data: existing } = await db.from("messages").select("id").eq("message_id", n.id).limit(1);
  if (existing && existing.length > 0) return "own_send_echo";
  if (n.type === "reaction") return "own_reaction_ignored";

  const identity = resolveInboundIdentity({ from: n.phone! }, { wa_id: n.phone!, profile: {} });
  const contact = await findOrCreateContact(ctx.accountId, ctx.ownerUserId, identity);
  if (!contact) return "contact_failed";
  const conv = await findOrCreateConversation(ctx.accountId, ctx.ownerUserId, contact.contact.id);
  if (!conv) return "conversation_failed";
  const conversationId = conv.conversation.id as string;

  const parsed = await contentFor(n, ctx, null);
  const replyTo = n.quotedId ? await lookupInternalIdByMetaId(n.quotedId, conversationId) : null;
  const contentType = ["image", "video", "document", "audio", "location"].includes(n.type) ? n.type : n.type === "sticker" ? "image" : "text";
  const { error } = await db.from("messages").upsert(
    {
      conversation_id: conversationId,
      sender_type: "agent",
      content_type: contentType,
      content_text: parsed.contentText,
      media_url: parsed.mediaUrl,
      media_type: parsed.mediaType,
      message_id: n.id,
      status: "sent",
      created_at: new Date(Number(n.timestamp) * 1000).toISOString(),
      reply_to_message_id: replyTo,
    },
    { onConflict: "conversation_id,message_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[evolution] storing phone-typed message failed:", error.message);
    return "insert_failed";
  }
  const now = new Date().toISOString();
  await db
    .from("conversations")
    .update({ last_message_text: parsed.contentText || `[${contentType}]`, last_message_at: now, updated_at: now, channel: "evolution" })
    .eq("id", conversationId);
  // A human answered from the phone — let an active Flow yield, as for an inbox reply.
  await db
    .from("flow_runs")
    .update({ status: "paused_by_agent", ended_at: now, end_reason: "agent_replied" })
    .eq("account_id", ctx.accountId)
    .eq("contact_id", contact.contact.id)
    .eq("status", "active");
  return "phone_message_stored";
}

/** messages.upsert → outcome label (for the diagnostics log). */
export async function receiveUpsert(data: unknown, ctx: ReceiveContext): Promise<string> {
  const items = Array.isArray(data) ? data : [data];
  const outcomes: string[] = [];
  for (const item of items) {
    const n = normalizeUpsert(item);
    if (n.kind === "ignore") {
      outcomes.push(`ignored: ${n.reason}`);
      continue;
    }
    if (!n.phone) {
      // Addressed only by a privacy id (LID) — no phone number to file it under.
      outcomes.push("ignored: no phone number (LID only)");
      continue;
    }
    outcomes.push(n.fromMe ? await recordPhoneMessage(n, ctx) : await receiveCustomerMessage(n, ctx));
  }
  return outcomes.join(", ") || "empty";
}

/** messages.update → delivery / read ticks on our messages. */
export async function receiveUpdates(data: unknown): Promise<string> {
  const statuses = normalizeUpdates(data).filter((s) => s.fromMe && s.status !== "sent");
  for (const s of statuses) {
    await handleStatusUpdate({ id: s.id, status: s.status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: s.phone ?? "" });
  }
  return statuses.length ? statuses.map((s) => s.status).join(",") : "no_status";
}
