-- ============================================================
-- 055_lulu_results_attribution.sql — campaign results, revenue attribution, holdout
--
-- FIX: 051 created a PARTIAL unique index for delivery-status dedupe. Postgres
-- cannot use a partial index for ON CONFLICT without a matching predicate, so
-- the receiver's DELIVERED / READ upserts were rejected. Replaced with full
-- unique indexes (NULLs never conflict, so rows without an id are unaffected).
--
-- New:
--   lulu_campaigns.holdout_pct       share of eligible customers deliberately NOT messaged (control group)
--   lulu_campaigns.attribution_days  an order within N days after a message counts for that campaign
--   event types CONTROL_ORDER        order by a holdout customer inside the same window
--   lulu_campaign_results()          per-campaign funnel + revenue + control comparison
-- Idempotent.
-- ============================================================
DROP INDEX IF EXISTS lulu_ce_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS lulu_ce_wamid_uq ON lulu_campaign_events (account_id, wa_message_id, event_type);
CREATE UNIQUE INDEX IF NOT EXISTS lulu_ce_order_uq ON lulu_campaign_events (account_id, event_type, order_id);
CREATE INDEX IF NOT EXISTS lulu_ce_action_idx ON lulu_campaign_events (action_id);

ALTER TABLE lulu_campaign_events DROP CONSTRAINT IF EXISTS lulu_campaign_events_event_type_check;
ALTER TABLE lulu_campaign_events ADD CONSTRAINT lulu_campaign_events_event_type_check
  CHECK (event_type IN ('SENT','DELIVERED','READ','CLICKED','REPLIED','FAILED','OPT_OUT','ORDER_ATTRIBUTED','CONTROL_ORDER'));

ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS holdout_pct      numeric(4,1) NOT NULL DEFAULT 10;
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS attribution_days integer      NOT NULL DEFAULT 7;

CREATE OR REPLACE FUNCTION lulu_campaign_results(p_account uuid, p_since timestamptz)
RETURNS TABLE (
  campaign_id uuid, sent bigint, failed bigint, queued bigint, skipped bigint, holdout bigint,
  delivered bigint, read bigint, replied bigint,
  converted bigint, orders bigint, revenue numeric, discount_cost numeric, control_converted bigint
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH a AS (
    SELECT id, campaign_id, status, skip_reason
    FROM lulu_customer_next_actions
    WHERE account_id = p_account AND is_test = false AND created_at >= p_since AND campaign_id IS NOT NULL
  ),
  ev AS (
    SELECT e.action_id,
           bool_or(e.event_type IN ('DELIVERED','READ')) AS delivered,
           bool_or(e.event_type = 'READ') AS read,
           bool_or(e.event_type = 'REPLIED') AS replied,
           count(*) FILTER (WHERE e.event_type = 'ORDER_ATTRIBUTED') AS orders,
           coalesce(sum(e.order_value) FILTER (WHERE e.event_type = 'ORDER_ATTRIBUTED'), 0) AS revenue,
           coalesce(sum(e.discount_cost) FILTER (WHERE e.event_type = 'ORDER_ATTRIBUTED'), 0) AS discount_cost,
           bool_or(e.event_type = 'CONTROL_ORDER') AS control_order
    FROM lulu_campaign_events e
    WHERE e.account_id = p_account AND e.action_id IN (SELECT id FROM a)
    GROUP BY e.action_id
  )
  SELECT a.campaign_id,
         count(*) FILTER (WHERE a.status = 'SENT'),
         count(*) FILTER (WHERE a.status = 'FAILED'),
         count(*) FILTER (WHERE a.status IN ('READY','SCHEDULED','SENDING')),
         count(*) FILTER (WHERE a.status IN ('SKIPPED','CANCELLED') AND coalesce(a.skip_reason, '') <> 'holdout'),
         count(*) FILTER (WHERE a.skip_reason = 'holdout'),
         count(*) FILTER (WHERE ev.delivered),
         count(*) FILTER (WHERE ev.read),
         count(*) FILTER (WHERE ev.replied),
         count(*) FILTER (WHERE a.status = 'SENT' AND ev.orders > 0),
         coalesce(sum(ev.orders) FILTER (WHERE a.status = 'SENT'), 0),
         coalesce(sum(ev.revenue) FILTER (WHERE a.status = 'SENT'), 0),
         coalesce(sum(ev.discount_cost) FILTER (WHERE a.status = 'SENT'), 0),
         count(*) FILTER (WHERE a.skip_reason = 'holdout' AND ev.control_order)
  FROM a LEFT JOIN ev ON ev.action_id = a.id
  GROUP BY a.campaign_id;
$$;
