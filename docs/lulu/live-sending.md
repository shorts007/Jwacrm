# Live sending (customers)

Driver: n8n workflow `docs/lulu/n8n/lulu-daily-sender.workflow.json` (daily 17:00 Riyadh + manual).

1. `POST /api/v1/lulu/campaigns/prepare` (scope `messages:send`) — builds today's queue from LIVE campaigns
   (Live switch on + mode LIVE + not paused): next-best-action engine over all active customers, STOP list,
   frequency caps, already-received (60 days), daily cap. Inserts SCHEDULED actions (idempotent per campaign+customer+day).
2. `POST /api/v1/lulu/campaigns/send-next` — sends ONE message and returns `next_wait_seconds`.
   Gap before message n of the day = base + increment × (n−1) → 60 s, 61 s, 62 s … (Campaigns → Step 3).
   100 messages ≈ 10,950 s ≈ 3 h 3 min.

Guards (server-side, cannot be bypassed from n8n): quiet hours 22:00–09:00, order data < 36 h old, Step 0 (STOP) active,
approved template, customer re-checked right before sending (opt-out, suspect, ordered since queuing, caps),
atomic claim (SCHEDULED → SENDING), minimum spacing, daily cap, auto-pause of all LIVE campaigns on Meta
rate-limit / block errors (131048, 131056, 80007, 130429, 368, 131031) or 5 failures in a row.
"Pause all" in the app cancels today's remaining queue.

## Results & attribution
- Each LIVE campaign keeps a **holdout**: `holdout_pct` (default 10 %) of eligible customers are recorded but NOT messaged
  (status SKIPPED, skip_reason `holdout`, chosen deterministically per customer+campaign). They don't use send slots.
- The daily n8n sync posts the last 14 days of delivered orders (`lulu_recent_orders` view) to
  `POST /api/v1/lulu/attribution/sync`. Orders within `attribution_days` (default 7) after a message → ORDER_ATTRIBUTED
  (last touch); orders by holdout customers in the same window → CONTROL_ORDER.
- Inbound messages within 7 days of a campaign message → REPLIED.
- `/engagement/results`: funnel, ordered %, revenue, revenue per message, control ordered %, **lift** (pts) and
  estimated extra customers. Lift is only trustworthy with ≥100 control and ≥300 messaged customers.

## Offers (PRD §53, §54, §81)
- `/engagement/offers`: code (must already work at checkout), type & value, optional AR/EN wording (else generated, e.g.
  "SAR 20 off with code WB20" / "خصم 20 ريال بالكود WB20"), validity days after the message (capped by end date),
  start/end, discount budget, eligible price behaviour (default: not Full-price buyers) and stores.
- Win-back and VIP templates contain `{{offer}}`: those campaigns are **skipped** unless an attached offer is active, in date,
  worded and under budget; customers outside the offer's eligibility are skipped. There is no default offer text anywhere.
- Budget used = discount on orders attributed to messages that carried the offer (`lulu_offer_usage()`).

## Image promotions (PRD §41)
- `/engagement/promotions`: paste / drop / choose a product image (PNG/JPEG ≤ 5 MB → public bucket `lulu-promos`),
  offer text in Arabic + English (≤ 380 chars each, one paragraph), valid-until date, audience (lifecycle, price behaviour,
  preferred store, VIP, min orders, ordered within N days) with a live estimate, and a WhatsApp-style preview.
- Saved as a `lulu_campaigns` row of type NEW_OFFER (priority class GENERAL_PROMOTION → after lifecycle campaigns).
- Sent with three brand-neutral templates `promo_image_ar / _en / _bi` (IMAGE header; created in Campaigns → Step 1 using
  `/lulu/promo-sample.png` as Meta's review sample). Each send passes the promotion's own image as the header
  (`templateMessageParams.headerMediaUrl`), so new promotions need no new Meta approval.
- Same safeguards as every campaign: test first (Step 2), Live switch + Make LIVE (Step 3), daily cap & pacing, STOP list,
  frequency limits, holdout, results page. Skipped automatically after valid-until or if image/text is missing.
- Not Meta "catalog" messages: those require a product catalogue connected in Meta Commerce Manager.

## V2 personalisation — Replenishment (§44) & Buy Again (§45)
- BigQuery `customer_master.sql` → `usual_items`: up to 5 *replenishable* products per customer from picking data
  (bought 2+ times; product bought by ≥ 20 customers and re-bought by ≥ 20 % of them; ≤ SAR 150 so phones/appliances are
  excluded) with times bought, last bought and usual gap (own median after 3+ purchases, else the product's typical gap).
- **Replenishment**: an item is due from 0.9× its gap until 2× (after that the habit is treated as lapsed); message names up to
  3 due products: "time to restock? Your usual {{items}} may be running low". Priority class PERSONALIZED_OFFER.
- **Buy Again**: AT_RISK customers with 2+ usual items: "your favourites are waiting: {{items}}". Class WINBACK with
  priority 45, so it replaces the generic 15-day message when we know their items (customers without item history still get it).
- Templates `restock_ar/_en/_bi`, `buy_again_ar/_en/_bi` (brand-neutral) — created from Campaigns → Step 1.
- Customer 360 shows each usual item with "due now / overdue / in N days / habit lapsed".
- Limits: item history only from Apr 2026 and only for orders matched to picking data; product names are the catalogue's English names.
- **Item-data freshness guard:** item messages are only sent when the customer's latest order date ≤ `items_as_of` (last day
  in `instaleap_raw`), and Replenishment waits 2 days after any order. Keep the picking table refreshed as often as the order
  table, or personalised campaigns will (correctly) stay silent for recent buyers. Customer 360 shows "unknown" in that case.

## Cross-sell (PRD §46)
- BigQuery: association rules over Jeddah picking baskets — product pairs in ≥ 20 shared orders, each product in ≥ 30 orders,
  lift ≥ 1.5 and confidence ≥ 8 %, suggested product ≤ SAR 150, size/brand variants of the same item skipped. Per customer:
  the best pair whose first product they bought 2+ times and whose second they have never bought → `cross_sell` JSON.
- Campaign CROSS_SELL (class PERSONALIZED_OFFER, priority 60 → after Replenishment): ACTIVE customers, same
  item-data guard and next-shop timing as Replenishment. Templates `cross_sell_ar/_en/_bi`:
  "customers who buy {{anchor}} often add {{product}} too".
- Insights page: "Frequently bought together" — top 40 pairs by lift (last 180 days).
