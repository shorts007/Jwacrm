"use client";

// Agents — answer customers from your own WhatsApp (agent relay, migration 064).
// Customer → shop number (WhatsApp app number) → copy to the agent's WhatsApp → agent
// swipe-replies → answer goes to the customer from the shop number and is saved in the Inbox.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Plus, Send, Trash2, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { normalizeMobile } from "@/lib/lulu/phone";

interface Agent {
  id: string;
  name: string;
  phone_digits: string;
  enabled: boolean;
  on_duty: boolean;
  last_seen_at: string | null;
}
interface Thread {
  id: string;
  code: number;
  agent_id: string | null;
  awaiting_reply: boolean;
  last_customer_at: string | null;
  last_agent_reply_at: string | null;
  handovers: number;
  contact: { name: string | null; phone: string | null } | null;
}

const DEFAULT_OFFLINE =
  "شكراً لتواصلك معنا. فريقنا غير متاح الآن وسنرد عليك في أقرب وقت.\nThanks for your message — our team is not available right now and will reply as soon as possible.";

const mask = (p: string | null | undefined) => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length <= 7 ? d : `${d.slice(0, 4)}${"•".repeat(d.length - 7)}${d.slice(-3)}`;
};
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export default function AgentsPage() {
  const { accountId } = useAuth();
  const [settings, setSettings] = useState({ enabled: false, response_minutes: 10, offline_message: DEFAULT_OFFLINE });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [draft, setDraft] = useState({ name: "", phone: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const [s, a, t] = await Promise.all([
      db.from("relay_settings").select("enabled, response_minutes, offline_message").eq("account_id", accountId).maybeSingle(),
      db.from("relay_agents").select("id, name, phone_digits, enabled, on_duty, last_seen_at").eq("account_id", accountId).order("name"),
      db
        .from("relay_threads")
        .select("id, code, agent_id, awaiting_reply, last_customer_at, last_agent_reply_at, handovers, contact:contacts(name, phone)")
        .eq("account_id", accountId)
        .eq("status", "open")
        .order("last_customer_at", { ascending: false })
        .limit(100),
    ]);
    if (s.error && /relay_settings/.test(s.error.message)) {
      setMissing(true);
      return;
    }
    if (s.data) setSettings({ enabled: !!s.data.enabled, response_minutes: s.data.response_minutes ?? 10, offline_message: s.data.offline_message ?? "" });
    setAgents((a.data ?? []) as Agent[]);
    setThreads(((t.data ?? []) as unknown as (Thread & { contact: Thread["contact"] | Thread["contact"][] })[]).map((r) => ({ ...r, contact: Array.isArray(r.contact) ? r.contact[0] ?? null : r.contact })));
  }, [accountId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ text });
      await load();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = (patch: Partial<typeof settings> = {}) =>
    run("settings", async () => {
      const next = { ...settings, ...patch };
      if (next.enabled && !agents.some((a) => a.enabled && a.on_duty)) throw new Error("Add at least one agent who is on duty first.");
      const { error } = await createClient()
        .from("relay_settings")
        .upsert(
          {
            account_id: accountId,
            enabled: next.enabled,
            response_minutes: Math.min(240, Math.max(2, Math.round(next.response_minutes))),
            offline_message: next.offline_message.trim() || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "account_id" },
        );
      if (error) throw error;
      setSettings(next);
      return next.enabled ? "Saved — customer messages to the shop number now go to agents." : "Saved.";
    });

  const addAgent = () =>
    run("add", async () => {
      const name = draft.name.trim();
      const phone = normalizeMobile(draft.phone);
      if (!name) throw new Error("Enter the agent's name.");
      if (!phone) throw new Error("Enter the agent's WhatsApp number, e.g. 0501234567 or +966501234567.");
      const { error } = await createClient().from("relay_agents").insert({ account_id: accountId, name, phone_digits: phone.replace(/\D/g, "") });
      if (error) throw new Error(/duplicate|unique/i.test(error.message) ? "That number is already an agent." : error.message);
      setDraft({ name: "", phone: "" });
      return `${name} added. Press “Send instructions” so they receive the how-to on WhatsApp.`;
    });

  const update = (a: Agent, patch: Partial<Agent>) =>
    run(`agent-${a.id}`, async () => {
      const { error } = await createClient().from("relay_agents").update(patch).eq("id", a.id);
      if (error) throw error;
    });

  const remove = (a: Agent) =>
    run(`agent-${a.id}`, async () => {
      if (!window.confirm(`Remove ${a.name}? Their open chats move to other agents.`)) return;
      const { error } = await createClient().from("relay_agents").delete().eq("id", a.id);
      if (error) throw error;
      return `${a.name} removed.`;
    });

  const welcome = (a: Agent) =>
    run(`welcome-${a.id}`, async () => {
      const r = await fetch("/api/relay/welcome", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: a.id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      return `Instructions sent to ${a.name}.`;
    });

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const btn = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50";
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const openCount = (id: string) => threads.filter((t) => t.agent_id === id).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          <Users className="h-5 w-5" /> Agents on WhatsApp
        </h1>
        <p className="text-sm text-muted-foreground">
          Customer messages to the shop number are copied to the agent&rsquo;s own WhatsApp. The agent swipe-replies and the answer goes to the customer
          from the shop number — and is saved in the Inbox. The agent who handled the customer last time gets the chat if on duty, otherwise the
          on-duty agent with the fewest open chats. No reply in time → it moves to another agent.
        </p>
      </div>

      {missing && <p className="text-sm text-destructive">Run migration 064_agent_relay.sql in Supabase to use agents.</p>}
      {msg && (
        <div className={`rounded-lg border p-3 text-sm ${msg.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border text-foreground"}`}>{msg.text}</div>
      )}

      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Send customer messages to agents</p>
            <p className="text-xs text-muted-foreground">Works for chats on the WhatsApp app number (Engagement → Channels).</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Send customer messages to agents"
            disabled={!!busy || missing}
            onClick={() => void saveSettings({ enabled: !settings.enabled })}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${settings.enabled ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <label className="space-y-1 text-xs text-muted-foreground">
            Hand over after (minutes without reply)
            <input type="number" min={2} max={240} className={input} value={settings.response_minutes} onChange={(e) => setSettings({ ...settings, response_minutes: Number(e.target.value) })} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Message to the customer when no agent is on duty (leave empty for none; max once per 12 h)
            <textarea rows={2} dir="auto" className={input} value={settings.offline_message} onChange={(e) => setSettings({ ...settings, offline_message: e.target.value })} />
          </label>
        </div>
        <button type="button" className={btn} disabled={!!busy || missing} onClick={() => void saveSettings()}>
          {busy === "settings" && <Loader2 className="h-4 w-4 animate-spin" />} Save
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Agents</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">Name</th>
                <th className="px-2 py-1 font-medium">WhatsApp</th>
                <th className="px-2 py-1 font-medium">On duty</th>
                <th className="px-2 py-1 font-medium">Open chats</th>
                <th className="px-2 py-1 font-medium">Last active</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className={`border-t border-border ${a.enabled ? "" : "opacity-50"}`}>
                  <td className="px-2 py-1.5 text-foreground">{a.name}</td>
                  <td className="px-2 py-1.5 font-mono text-xs" dir="ltr">+{a.phone_digits}</td>
                  <td className="px-2 py-1.5">
                    <input type="checkbox" aria-label={`${a.name} on duty`} checked={a.on_duty} disabled={!!busy} onChange={(e) => void update(a, { on_duty: e.target.checked })} />
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{openCount(a.id)}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{ago(a.last_seen_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex justify-end gap-1">
                      <button type="button" className={btn} disabled={!!busy} onClick={() => void welcome(a)} title="Send the how-to to this agent on WhatsApp">
                        {busy === `welcome-${a.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send instructions
                      </button>
                      <button type="button" className={btn} disabled={!!busy} onClick={() => void update(a, { enabled: !a.enabled })}>
                        {a.enabled ? "Disable" : "Enable"}
                      </button>
                      <button type="button" className={`${btn} text-destructive`} disabled={!!busy} onClick={() => void remove(a)} aria-label={`Remove ${a.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-sm text-muted-foreground">
                    No agents yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_auto]">
          <input className={input} placeholder="Name, e.g. Sara" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className={input} dir="ltr" placeholder="WhatsApp number, e.g. 0501234567" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          <button type="button" className={btn} disabled={!!busy || missing} onClick={() => void addAgent()}>
            {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add agent
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Agents can also send <b>/on</b> or <b>/off</b> from WhatsApp. Agent numbers never get campaigns, welcome messages or bot replies.
        </p>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Open chats</h2>
        {threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open chats.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Chat</th>
                  <th className="px-2 py-1 font-medium">Customer</th>
                  <th className="px-2 py-1 font-medium">Agent</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Hand-overs</th>
                </tr>
              </thead>
              <tbody>
                {threads.map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className="px-2 py-1.5 font-mono text-xs">#{t.code}</td>
                    <td className="px-2 py-1.5">
                      {t.contact?.name ?? "—"} <span className="text-xs text-muted-foreground" dir="ltr">{mask(t.contact?.phone)}</span>
                    </td>
                    <td className="px-2 py-1.5">{t.agent_id ? (agentName.get(t.agent_id) ?? "—") : <span className="text-amber-600">nobody on duty</span>}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {t.awaiting_reply ? <span className="text-amber-600">waiting since {ago(t.last_customer_at)}</span> : <span className="text-emerald-600">answered {ago(t.last_agent_reply_at)}</span>}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{t.handovers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
