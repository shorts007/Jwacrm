/**
 * Server helpers for the Evolution channel: load the account's config (API key decrypted),
 * build the webhook URL, log/redact webhook deliveries.
 */
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import type { EvolutionConn } from "./client";

export interface EvolutionConfigRow {
  account_id: string;
  base_url: string;
  instance_name: string;
  api_key: string;
  webhook_secret: string;
  state: string;
  connected_number: string | null;
  profile_name: string | null;
  qr_code: string | null;
  qr_updated_at: string | null;
  last_event_at: string | null;
  is_default_outbound: boolean;
  created_by?: string | null;
}

/** Friendly message for setup problems that would otherwise surface as "Internal server error". */
export function evolutionSetupError(err: unknown): string | null {
  const e = err as { message?: string; code?: string } | null;
  const msg = String(e?.message ?? err ?? "");
  if (e?.code === "42P01" || e?.code === "PGRST205" || /evolution_(config|event_log)|schema cache|does not exist/i.test(msg))
    return "The Evolution tables are missing — run migration 061_evolution_channel.sql in Supabase (SQL Editor), then try again.";
  if (/ENCRYPTION_KEY|Invalid key length/i.test(msg)) return "ENCRYPTION_KEY is not set correctly in Vercel environment variables.";
  return null;
}

export async function loadEvolutionConfig(accountId: string): Promise<EvolutionConfigRow | null> {
  const { data, error } = await supabaseAdmin().from("evolution_config").select("*").eq("account_id", accountId).maybeSingle();
  if (error) throw error;
  return (data as EvolutionConfigRow | null) ?? null;
}

export function connFromRow(r: EvolutionConfigRow): EvolutionConn {
  return { baseUrl: r.base_url, instance: r.instance_name, apiKey: decrypt(r.api_key) };
}

export const newWebhookSecret = () => randomBytes(24).toString("hex");

/** Public URL Evolution should call. Uses NEXT_PUBLIC_SITE_URL (https) or the request origin. */
export function webhookUrl(request: Request, secret: string): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
  const base = site && site.startsWith("https://") ? site : new URL(request.url).origin;
  return `${base}/api/evolution/webhook/${secret}`;
}

/** Strip secrets and inline media before storing a payload for diagnostics. */
export function redactPayload(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (typeof v === "string") return v.length > 1500 ? `[${v.length} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redactPayload(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(apikey|api_key|token|hash|jpegThumbnail|mediaKey|fileEncSha256|fileSha256)$/i.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactPayload(val, depth + 1);
    }
    return out;
  }
  return v;
}

export async function logEvolutionEvent(accountId: string, event: string | null, outcome: string, payload?: unknown) {
  try {
    const db = supabaseAdmin();
    await db.from("evolution_event_log").insert({
      account_id: accountId,
      event,
      outcome,
      payload: payload === undefined ? null : redactPayload(payload),
    });
    // keep the log small: last 300 rows per account
    const { data } = await db
      .from("evolution_event_log")
      .select("id")
      .eq("account_id", accountId)
      .order("id", { ascending: false })
      .range(300, 300);
    const cutoff = data?.[0]?.id as number | undefined;
    if (cutoff) await db.from("evolution_event_log").delete().eq("account_id", accountId).lte("id", cutoff);
  } catch {
    /* diagnostics must never break the receiver */
  }
}
