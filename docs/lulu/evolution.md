# Evolution API channel (WhatsApp app number)

WACRM can send and receive through two WhatsApp numbers at once:

| | Meta Cloud API | Evolution API (Baileys) |
|---|---|---|
| Number | Meta-registered number | a WhatsApp Business **app** number linked by QR |
| Templates | approved by Meta, sent as templates | sent as their approved **text** (variables filled in) |
| Buttons / lists | native | **numbered options** (1️⃣ 2️⃣ …); the customer answers with the number or the words |
| 24-hour window | yes (templates outside it) | none |
| Cost | per conversation | none |
| Risk | — | the number can be banned for bulk / reported sending — keep volumes low |

Meta stays connected for template approval (Settings → Templates) and as a channel.

## Which number sends (src/lib/channels/outbound.ts)

* **Replies** (Inbox, Flows, automations, AI auto-reply, reactions, typing) use the chat's number —
  the one the customer last wrote to (`conversations.channel`).
* **Outreach** (LuLu campaigns, LuLu test sends, Broadcasts, public broadcast API) uses the
  account default: Engagement → Channels → **Send through this number** (on = Evolution).
* A chat with no channel yet (new contact) uses the default.

If the app number is disconnected, sends through it fail with a clear error and LuLu campaigns
auto-pause — they never silently switch to the Meta number.

## What arrives in the Inbox (src/lib/evolution/receive.ts)

* Customer text, images, video, documents, voice notes, stickers, locations, contacts, reactions,
  swipe-replies — through the same pipeline as Meta (`src/lib/whatsapp/inbound.ts`), so flows,
  automations, AI auto-reply, public webhooks and the LuLu STOP / START / language handling work.
* A numbered answer ("1", "1️⃣", "١", or the option's words) to our last buttons / list / template
  quick replies is stored as that button tap.
* Messages typed on the phone itself appear as agent messages and pause an active Flow.
* Delivered / read ticks update messages and broadcast recipients.
* Ignored: groups, status updates, channels; chats known only by a privacy id (LID) — logged.

Every event is listed (redacted) under Diagnostics on the Channels page.

## Ban-risk controls

* Campaign / broadcast messages show "typing…" for 1.5–4 s before sending.
* Broadcasts through the app number wait 2–4 s between recipients; big sends belong in
  Engagement → Campaigns (daily cap, 60 s+ gaps, quiet hours, opt-outs, frequency caps).
* Warm up a new number: small daily caps for the first 1–2 weeks.

## Setup

1. Evolution v2 behind HTTPS (e.g. Cloudflare Tunnel `evo.example.com → localhost:8080`), port 8080 closed.
2. Run migrations **061** and **062**.
3. Engagement → Channels: server address, a **new** instance name (e.g. `wacrm-lulu`), the server's
   `AUTHENTICATION_API_KEY` → Save → Connect → scan the QR in WhatsApp Business → Linked devices.
4. Send a test. Turn on **Send through this number** when ready.
5. After updating WACRM, click **Re-check connection** once so Evolution gets the current webhook events.
