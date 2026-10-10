/**
 * Turning CRM messages into what a regular WhatsApp account (Evolution API / Baileys) can send.
 *
 * Baileys has no Meta templates and its native buttons/lists are unreliable (Evolution 2.3.x),
 * so everything becomes plain text (or one image/video/document with a caption):
 *   - a template → its approved text with the variables filled in, header image as the media,
 *     footer in italics, quick-reply buttons as a numbered list, URL / phone / copy-code
 *     buttons as plain lines;
 *   - reply buttons / list messages → the same numbered list.
 * Customers answer with the number (1, 1️⃣, ١) or the option's words; `matchReplyOption`
 * maps that back to the button id so Flows, automations and the LuLu STOP/language handling
 * behave exactly as if a Meta button had been tapped.
 *
 * Pure functions only — tested in render.test.ts.
 */
import type { MessageTemplate, TemplateButton } from "@/types";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";

export interface ReplyOption {
  /** What the CRM treats as the tapped button id (Meta: button id / template payload). */
  id: string;
  /** Visible label. */
  title: string;
  description?: string;
}

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const numberLabel = (i: number) => KEYCAPS[i] ?? `${i + 1}.`;

/** Numbered option lines ("1️⃣ English"). */
export function optionLines(options: ReplyOption[]): string[] {
  return options.map((o, i) => `${numberLabel(i)} ${o.title}${o.description ? ` — ${o.description}` : ""}`);
}

const join = (parts: (string | null | undefined | false)[]) =>
  parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n\n");

const italic = (s?: string | null) => (s && s.trim() ? `_${s.trim()}_` : null);
const bold = (s?: string | null) => (s && s.trim() ? `*${s.trim()}*` : null);

/** Quick-reply buttons of a template, as reply options (id = label, like Meta's default payload). */
export function templateReplyOptions(template: Pick<MessageTemplate, "buttons"> | null | undefined): ReplyOption[] {
  return (template?.buttons ?? [])
    .filter((b): b is Extract<TemplateButton, { type: "QUICK_REPLY" }> => b.type === "QUICK_REPLY" && !!b.text)
    .map((b) => ({ id: b.text, title: b.text }));
}

/** Options carried by an interactive (buttons / list) payload. */
export function interactiveReplyOptions(p: InteractiveMessagePayload | null | undefined): ReplyOption[] {
  if (!p) return [];
  if (p.kind === "buttons") return p.buttons.map((b) => ({ id: b.id, title: b.title }));
  return p.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })));
}

export interface RenderedMessage {
  text: string;
  /** Header media to send with `text` as its caption. */
  media?: { kind: "image" | "video" | "document"; url: string; filename?: string };
}

/**
 * A template as plain WhatsApp text. Throws when the template has no local copy (we would not
 * know what to send) — run "Sync from Meta" in Settings → Templates.
 */
export function renderTemplate(template: MessageTemplate | null | undefined, params: SendTimeParams | undefined, legacyBody?: string[]): RenderedMessage {
  if (!template?.body_text) {
    throw new Error("This template has no local copy to send through the WhatsApp app number — open Settings → Templates and sync from Meta.");
  }
  const bodyParams = params?.body && params.body.length ? params.body : (legacyBody ?? []);
  const body = renderTemplateBody(template.body_text, bodyParams);

  let headerText: string | null = null;
  let media: RenderedMessage["media"];
  if (template.header_type === "text" && template.header_content) {
    headerText = template.header_content.replace(/\{\{1\}\}/g, params?.headerText ?? "");
  } else if (template.header_type === "image" || template.header_type === "video" || template.header_type === "document") {
    const url = params?.headerMediaUrl || template.header_media_url;
    if (url && /^https?:\/\//i.test(url)) media = { kind: template.header_type, url };
  }

  const buttons = template.buttons ?? [];
  const quick = templateReplyOptions(template);
  const extra: string[] = [];
  buttons.forEach((b, i) => {
    if (b.type === "URL") {
      const value = params?.buttonParams?.[i];
      const url = b.url.includes("{{1}}") ? b.url.replace("{{1}}", value ?? b.example ?? "") : b.url;
      extra.push(`🔗 ${b.text}: ${url}`);
    } else if (b.type === "PHONE_NUMBER") {
      extra.push(`📞 ${b.text}: ${b.phone_number}`);
    } else if (b.type === "COPY_CODE") {
      extra.push(`🏷️ ${b.text}: ${params?.buttonParams?.[i] ?? b.example}`);
    }
  });

  const text = join([bold(headerText), body, italic(template.footer_text), extra.join("\n"), optionLines(quick).join("\n")]);
  return { text, media };
}

/** Reply buttons / list as plain text with numbered options. */
export function renderInteractive(p: InteractiveMessagePayload): string {
  if (p.kind === "buttons") {
    return join([bold(p.header), p.body, italic(p.footer), optionLines(interactiveReplyOptions(p)).join("\n")]);
  }
  let n = 0;
  const sectionBlocks = p.sections.map((s) => {
    const lines = s.rows.map((r) => `${numberLabel(n++)} ${r.title}${r.description ? ` — ${r.description}` : ""}`);
    return [bold(s.title), ...lines].filter(Boolean).join("\n");
  });
  return join([bold(p.header), p.body, italic(p.footer), sectionBlocks.join("\n\n")]);
}

/** Arabic-Indic / Persian digits → ASCII, keycap emoji → digit. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/🔟/g, "10")
    .replace(/([0-9])️?⃣/g, "$1");
}

const simplify = (s: string) =>
  normalizeDigits(s)
    .toLowerCase()
    .replace(/[*_~`]/g, "")
    .replace(/[\s.،,!?؟]+/g, " ")
    .trim();

/**
 * Map a typed answer to one of the options we offered: "2", "2️⃣", "٢", "2." or the option's
 * title ("english", "العربية"). Returns null when it is not clearly one of them.
 */
export function matchReplyOption(input: string | null | undefined, options: ReplyOption[]): ReplyOption | null {
  if (!input || options.length === 0) return null;
  const t = simplify(input);
  if (!t) return null;
  const num = /^(\d{1,2})$/.exec(t);
  if (num) {
    const i = Number(num[1]) - 1;
    return options[i] ?? null;
  }
  return options.find((o) => simplify(o.title) === t || simplify(o.id) === t) ?? null;
}
