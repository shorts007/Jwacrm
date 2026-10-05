-- ============================================================
-- 049_lulu_profile_snapshot.sql — retire profiles that dropped out of the feed
--
-- The sync only ever upserted, so a customer who later falls outside the
-- feed (focus region changed, dedupe fixed, number now flagged…) stayed in
-- lulu_customer_profiles forever and kept inflating counts / dry runs.
--   sync_run : id of the sync run that last wrote the row (sent by n8n)
--   active   : false once a COMPLETE run no longer contained the customer
-- Counts, insights and the dry run read only active = true. A customer who
-- reappears in a later run is re-activated by the upsert. Idempotent.
-- ============================================================
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS active   boolean NOT NULL DEFAULT true;
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS sync_run text;

CREATE INDEX IF NOT EXISTS lulu_cp_active_idx ON lulu_customer_profiles (account_id) WHERE active;

-- Breakdown RPC now counts active profiles only.
CREATE OR REPLACE FUNCTION lulu_engagement_breakdown(p_account uuid)
RETURNS TABLE (dimension text, value text, customers bigint, sales numeric, discount numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT 'channel'::text, COALESCE(preferred_channel, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND active AND suspect_reason IS NULL
    GROUP BY COALESCE(preferred_channel, 'unknown')
  UNION ALL
  SELECT 'store', COALESCE(preferred_store, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND active AND suspect_reason IS NULL
    GROUP BY COALESCE(preferred_store, 'unknown')
  UNION ALL
  SELECT 'price', COALESCE(price_sensitivity, 'not enough data'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND active AND suspect_reason IS NULL
    GROUP BY COALESCE(price_sensitivity, 'not enough data')
  UNION ALL
  SELECT 'segment', COALESCE(customer_segment, 'unknown'), COUNT(*), COALESCE(SUM(total_sales), 0), COALESCE(SUM(total_discount), 0)
    FROM lulu_customer_profiles WHERE account_id = p_account AND active AND suspect_reason IS NULL
    GROUP BY COALESCE(customer_segment, 'unknown');
$$;
