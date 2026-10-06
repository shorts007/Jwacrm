-- ============================================================
-- 056_lulu_offer_engine.sql — offers as first-class objects (PRD §53, §54, §81)
--   text_ar / text_en           wording inserted into the message ({{offer}}); auto-generated if empty
--   validity_days               offer expires N days after the message (capped by end_date)
--   budget_sar                  max discount cost; when attributed discounts reach it the offer stops
--   eligible_price_behaviour    e.g. {Offer-driven,Mixed,Unknown} — keep discounts away from full-price buyers
-- lulu_offer_usage()             sends / orders / revenue / discount cost per offer (budget used)
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS text_ar                  text;
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS text_en                  text;
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS validity_days            integer NOT NULL DEFAULT 7;
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS budget_sar               numeric(14,2);
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS eligible_price_behaviour text[] NOT NULL DEFAULT '{}';
ALTER TABLE lulu_offers ADD COLUMN IF NOT EXISTS updated_at               timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION lulu_offer_usage(p_account uuid)
RETURNS TABLE (offer_id uuid, sends bigint, converted bigint, orders bigint, revenue numeric, discount_cost numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH a AS (
    SELECT id, offer_id FROM lulu_customer_next_actions
    WHERE account_id = p_account AND is_test = false AND status = 'SENT' AND offer_id IS NOT NULL
  ),
  ev AS (
    SELECT e.action_id, count(*) AS orders, sum(e.order_value) AS revenue, sum(e.discount_cost) AS discount_cost
    FROM lulu_campaign_events e
    WHERE e.account_id = p_account AND e.event_type = 'ORDER_ATTRIBUTED' AND e.action_id IN (SELECT id FROM a)
    GROUP BY e.action_id
  )
  SELECT a.offer_id, count(*), count(ev.action_id), coalesce(sum(ev.orders), 0),
         coalesce(sum(ev.revenue), 0), coalesce(sum(ev.discount_cost), 0)
  FROM a LEFT JOIN ev ON ev.action_id = a.id
  GROUP BY a.offer_id;
$$;
