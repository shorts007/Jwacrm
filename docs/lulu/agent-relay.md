# Agents on WhatsApp (agent relay)

Customers write to the shop's WhatsApp app number (Evolution). Each chat gets a number (#482) and
one agent. The agent receives a copy on their **own** WhatsApp, swipe-replies, and the answer goes
to the customer **from the shop number** — saved in the Inbox like any agent reply.

```
customer ──► shop number ──► WACRM ──► agent's WhatsApp  ("🟢 #482 · Ahmed (9665•••300) …")
customer ◄── shop number ◄── WACRM ◄── agent swipe-replies
```

## Assignment
1. The agent who handled this customer last time, if enabled and on duty.
2. Otherwise the on-duty agent with the fewest open chats (tie: longest since their last chat).
3. No reply within *N* minutes (default 10) → the chat moves to another on-duty agent, with the
   unanswered messages; the first agent is told. If nobody else is free, the agent gets one reminder.
4. Nobody on duty → the customer gets the optional "offline" message (max once per 12 h) and the
   chat is assigned as soon as an agent goes on duty.
5. Chats with no activity for 24 h close by themselves; the customer writing again reopens them.

## What stays with the automatic replies (not sent to agents)
* STOP / START and language choices (English / العربية) — handled by the opt-out & language replies.
* Taps / numbered answers to our buttons and options ("1", "2", "English") — Flows and campaigns.
* Greetings, thanks, "ok", emoji-only messages — covered by the welcome / auto reply. While an agent
  is in the middle of answering this customer (replied within the last 2 hours) these still reach
  the agent.
Everything else — a real question, a photo, a voice note, a location — goes to an agent.

## What agents send
| Message | Effect |
|---|---|
| swipe-reply to a customer message | answer goes to that customer (text, photo, document, voice note) |
| `#482 your text` | same, without swiping |
| plain text with only one open chat | goes to that chat |
| `/close` | finish the chat |
| `/transfer Sara` | give the chat to Sara (with the waiting messages) |
| `/note text` | internal note on the customer (Contacts) |
| `/info` | customer details + last messages + Inbox link |
| `/list` | your open chats |
| `/off`, `/on` | stop / start receiving chats (waiting chats are handed over) |

A reply that cannot be matched to a customer is **not sent**; the agent is asked which chat it is.
✅ reaction on the agent's message = delivered to the customer.

## Privacy & safety
* Agents see the customer's name and a masked number (9665•••••300).
* Agent numbers are staff: no welcome message, campaigns, AI or automations, and they never appear
  as customer chats. Messages to agents do not count against the app number's campaign limit.

## Setup
1. Run migration **064**.
2. Engagement → **Agents**: add agents (name + WhatsApp number), press **Send instructions** for each.
3. Set the hand-over minutes and the offline message; turn on **Send customer messages to agents**.
4. Import `docs/lulu/n8n/relay-sweep.workflow.json` in n8n (runs the hand-over every 2 minutes).
