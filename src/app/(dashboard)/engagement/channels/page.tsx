"use client";

// WhatsApp channels — connect a phone number through Evolution API (QR code) as a second channel
// next to the Meta Cloud API connection: connect, status, default sender, test send, diagnostics.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2, LogOut, PlugZap, RefreshCw, Send, Smartphone } from "lucide-react";
import { SafetyPanel } from "./safety-panel";

interface Status {
  configured: boolean;
  baseUrl?: string;
  instance?: string;
  state?: string;
  connectedNumber?: string | null;
  profileName?: string | null;
  qr?: string | null;
  qrUpdatedAt?: string | null;
  lastEventAt?: string | null;
  webhookUrl?: string;
  isDefaultOutbound?: boolean;
  events?: { received_at: string; event: string | null; outcome: string | null }[];
}

const STATE: Record<string, { label: string; cls: string }> = {
  open: { label: "Connected", cls: "bg-emerald-500/15 text-emerald-600" },
  connecting: { label: "Waiting for QR scan", cls: "bg-amber-500/15 text-amber-600" },
  close: { label: "Disconnected", cls: "bg-red-500/10 text-red-600" },
  unknown: { label: "Not checked yet", cls: "bg-muted text-muted-foreground" },
};

export default function ChannelsPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [form, setForm] = useState({ baseUrl: "", instance: "wacrm-lulu", apiKey: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [test, setTest] = useState({ number: "", text: "" });
  const filled = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/evolution/config");
    const j = (await r.json()) as Status & { error?: string };
    if (!r.ok) {
      setMsg({ text: j.error ?? "Could not load", error: true });
      return;
    }
    setSt(j);
    if (j.configured && !filled.current) {
      filled.current = true;
      setForm({ baseUrl: j.baseUrl ?? "", instance: j.instance ?? "wacrm-lulu", apiKey: "" });
    }
    if (j.qr) setQr(j.qr);
    if (j.state === "open") {
      setQr(null);
      setPairing(null);
    }
  }, []);

  useEffect(() => {
    void fetch("/api/evolution/config")
      .then((r) => r.json())
      .then((j: Status) => {
        setSt(j);
        if (j.configured) {
          filled.current = true;
          setForm({ baseUrl: j.baseUrl ?? "", instance: j.instance ?? "wacrm-lulu", apiKey: "" });
          if (j.qr) setQr(j.qr);
        }
      });
  }, []);

  // While a QR code is on screen, poll until the phone has scanned it.
  useEffect(() => {
    if (!qr || st?.state === "open") return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [qr, st?.state, load]);

  const post = async (url: string, body?: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && (j as { needsConfirmation?: boolean }).needsConfirmation) return j as Record<string, unknown>;
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as Record<string, unknown>;
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const j = await post("/api/evolution/config", form);
      setForm((f) => ({ ...f, apiKey: "" }));
      setMsg({ text: (j.warning as string) ?? "Saved. Now click Connect.", error: !!j.warning });
      await load();
    });

  const connectNow = () =>
    run("connect", async () => {
      let j = await post("/api/evolution/connect");
      if (j.needsConfirmation) {
        const ok = window.confirm(
          `${j.error as string}\n\nOnly continue if this instance is meant for WACRM. Its webhook will be pointed at WACRM. Continue?`,
        );
        if (!ok) {
          setMsg({ text: "Cancelled — enter a new instance name (e.g. wacrm-lulu), save, then Connect.", error: true });
          return;
        }
        j = await post("/api/evolution/connect", { takeOver: true });
      }
      setQr((j.qr as string) ?? null);
      setPairing((j.pairingCode as string) ?? null);
      setMsg({ text: j.state === "open" ? "Connected." : "Scan the QR code with WhatsApp on the phone (Linked devices → Link a device)." });
      await load();
    });

  const sendTest = () =>
    run("test", async () => {
      await post("/api/evolution/test", test);
      setMsg({ text: "Sent — check the phone." });
      await load();
    });

  const setDefault = (on: boolean) =>
    run("default", async () => {
      if (
        on &&
        !window.confirm(
          "Send through this number?\n\nCampaigns, broadcasts and new conversations will go out from the WhatsApp app number. " +
            "Chats keep replying on the number the customer wrote to. Keep volumes low — app numbers can be banned for bulk sending."
        )
      )
        return;
      await post("/api/evolution/default", { on });
      setMsg({ text: on ? "Outgoing messages now go through the WhatsApp app number." : "Outgoing messages now go through Meta." });
      await load();
    });

  const unlink = () =>
    run("logout", async () => {
      if (!window.confirm("Unlink this WhatsApp number from WACRM? You will need to scan a QR code again.")) return;
      await post("/api/evolution/logout");
      setMsg({ text: "Unlinked." });
      await load();
    });

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const btn = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50";
  const primary = "inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";
  const s = STATE[st?.state ?? "unknown"] ?? STATE.unknown;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href="/engagement" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Engagement
        </Link>
        <h1 className="text-xl font-semibold text-foreground">WhatsApp channels</h1>
        <p className="text-sm text-muted-foreground">
          Connect a WhatsApp Business app number through your Evolution API server as a second channel. Your Meta connection (Settings →
          WhatsApp) stays as it is and keeps handling template approval.
        </p>
      </div>

      {msg && (
        <div className={`rounded-lg border p-3 text-sm ${msg.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border text-foreground"}`}>
          {msg.text}
        </div>
      )}

      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Smartphone className="h-4 w-4" /> Evolution API
          </h2>
          {st?.configured && <span className={`rounded-full px-3 py-1 text-xs ${s.cls}`}>{s.label}</span>}
        </div>

        {st?.state === "open" && (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Linked to <b>+{st.connectedNumber ?? "?"}</b>
            {st.profileName ? ` (${st.profileName})` : ""}
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-xs text-muted-foreground md:col-span-3">
            Server address (HTTPS)
            <input className={input} dir="ltr" placeholder="https://evo.mystonestore.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Instance name (a new one, just for WACRM)
            <input className={input} dir="ltr" value={form.instance} onChange={(e) => setForm({ ...form, instance: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
            API key {st?.configured ? "(leave empty to keep the saved one)" : "(the server's AUTHENTICATION_API_KEY)"}
            <input className={input} dir="ltr" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={!!busy} onClick={() => void save()}>
            {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
          <button type="button" className={primary} disabled={!!busy || !st?.configured} onClick={() => void connectNow()}>
            {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            {st?.state === "open" ? "Re-check connection" : "Connect"}
          </button>
          <button type="button" className={btn} disabled={!!busy || !st?.configured} onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          {st?.state === "open" && (
            <button type="button" className={`${btn} text-destructive`} disabled={!!busy} onClick={() => void unlink()}>
              <LogOut className="h-4 w-4" /> Unlink number
            </button>
          )}
        </div>

        {qr && st?.state !== "open" && (
          <div className="flex flex-wrap items-start gap-4 rounded-lg border border-dashed border-border p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="WhatsApp QR code" className="h-56 w-56 rounded bg-white p-2" />
            <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
              <li>Open <b>WhatsApp Business</b> on the phone with the new number.</li>
              <li>Settings → <b>Linked devices</b> → <b>Link a device</b>.</li>
              <li>Scan this code. The page updates by itself when it is linked.</li>
              {pairing && <li>Or enter pairing code <b className="font-mono text-foreground">{pairing}</b>.</li>}
              <li>The code expires after about a minute — click Connect again for a fresh one.</li>
            </ol>
          </div>
        )}

        {st?.configured && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="max-w-xl text-sm">
              <p className="font-medium text-foreground">Send through this number</p>
              <p className="text-xs text-muted-foreground">
                On: LuLu campaigns, broadcasts and new conversations go out from <b>+{st.connectedNumber ?? "this number"}</b> (templates are sent as
                their approved text, buttons as numbered options). Replies always use the number the customer wrote to. Off: everything uses Meta.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!st.isDefaultOutbound}
              aria-label="Send through this number"
              disabled={!!busy || (!st.isDefaultOutbound && st.state !== "open")}
              onClick={() => void setDefault(!st.isDefaultOutbound)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                st.isDefaultOutbound ? "bg-emerald-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  st.isDefaultOutbound ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        )}

        {st?.state === "open" && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <label className="space-y-1 text-xs text-muted-foreground">
              Test number
              <input className={`${input} w-48`} dir="ltr" placeholder="966546182300" value={test.number} onChange={(e) => setTest({ ...test, number: e.target.value })} />
            </label>
            <label className="flex-1 space-y-1 text-xs text-muted-foreground">
              Message
              <input className={input} placeholder="Test message from WACRM via Evolution ✅" value={test.text} onChange={(e) => setTest({ ...test, text: e.target.value })} />
            </label>
            <button type="button" className={primary} disabled={!!busy} onClick={() => void sendTest()}>
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test
            </button>
          </div>
        )}
      </section>

      {st?.configured && <SafetyPanel />}

      {st?.configured && (
        <section className="space-y-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Diagnostics</h2>
          <p className="text-xs text-muted-foreground">
            Evolution sends events to <span className="font-mono">{st.webhookUrl}</span>
            {st.lastEventAt ? ` · last event ${new Date(st.lastEventAt).toLocaleString()}` : " · no events received yet"}
          </p>
          <table className="w-full text-left text-xs">
            <tbody>
              {(st.events ?? []).map((e, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 pe-2 text-muted-foreground">{new Date(e.received_at).toLocaleString()}</td>
                  <td className="py-1 pe-2 text-foreground">{e.event}</td>
                  <td className="py-1 text-muted-foreground">{e.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            Messages to this number appear in the Inbox; messages you type on the phone appear there too, as your replies. If events stop
            arriving after an update, click <b>Re-check connection</b> once to refresh the webhook.
          </p>
        </section>
      )}
    </div>
  );
}
