-- ============================================================
-- 048_lulu_customer_insights.sql — store / channel / discount insights
--
-- New synced fields on lulu_customer_profiles (from ksa_jackpot's new
-- discount_amount, client_type, storeid columns) plus an RPC that powers
-- the breakdown tables on /engagement. The RPC is SECURITY INVOKER, so the
-- caller's RLS applies (account members only). Idempotent.
-- ============================================================
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS preferred_store_id   integer;
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS stores_used          smallint;
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS preferred_channel    text;
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS price_sensitivity    text;  -- Offer-driven | Mixed | Full-price
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS discount_order_share numeric(5,4);
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS avg_discount_pct     numeric(5,1);
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS total_discount       numeric(14,2);

CREATE OR REPLACE FUNCTION lulu_engagement_breakdown(p_account uuid)
RETURNS TABLE (dimension text, value text, customers bigint, sales numeric, discount numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT 'channel'::text, COALESCE(preferred_channel, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND suspect_reason IS NULL
    GROUP BY COALESCE(preferred_channel, 'unknown')
  UNION ALL
  SELECT 'store', COALESCE(preferred_store, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND suspect_reason IS NULL
    GROUP BY COALESCE(preferred_store, 'unknown')
  UNION ALL
  SELECT 'price', COALESCE(price_sensitivity, 'not enough data'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND suspect_reason IS NULL
    GROUP BY COALESCE(price_sensitivity, 'not enough data')
  UNION ALL
  SELECT 'segment', COALESCE(customer_segment, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND suspect_reason IS NULL
    GROUP BY COALESCE(customer_segment, 'unknown');
$$;
