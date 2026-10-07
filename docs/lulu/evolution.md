# Evolution API channel (Baileys)

Second WhatsApp channel next to Meta Cloud API. Meta stays connected for template approval.

## Phases
1. ✅ Connect: settings, QR pairing, status, test send, diagnostics (`/engagement/channels`, migration 061)
2. Sending through Evolution for every CRM feature (transport layer; templates rendered to text; buttons → numbered fallback)
3. Receiving: messages, media, replies typed on the phone, delivered/read, LID mapping → same inbound pipeline as Meta
4. Ban-risk controls: warm-up, random gaps, typing presence, business hours, auto-pause on disconnect
5. Tests from recorded payloads, side-by-side rollout

## Server setup (once)
- Evolution must be reachable over **HTTPS on its own address** (e.g. `https://evo.mystonestore.com` → `localhost:8080`).
  `n8n.mystonestore.com` points to n8n, not Evolution.
- Use a **new instance** for WACRM (e.g. `wacrm-lulu`); the stock-alert instance is untouched. On first connect WACRM
  creates the instance with the global key and then keeps only that instance's own token.
- v2.3.7 has a known bug sending buttons/lists; WACRM will fall back to numbered text replies.
