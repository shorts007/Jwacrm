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
