-- ============================================================
-- 050_lulu_insights_snapshot.sql — pre-aggregated customer insights
--
-- One row per account holding the latest BigQuery insights snapshot
-- (lulu_insights_metrics view: monthly / store / channel / cohort / product
-- aggregates — no personal data). Replaced atomically on every sync.
-- Read by /engagement/insights. Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS lulu_insights_snapshot (
  account_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  rows        jsonb NOT NULL,            -- [{grp, period, dim, dim_value, metric, value}, …]
  row_count   integer NOT NULL,
  data_as_of  timestamptz,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lulu_insights_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lulu_insights_snapshot_select ON lulu_insights_snapshot;
CREATE POLICY lulu_insights_snapshot_select ON lulu_insights_snapshot FOR SELECT
  USING (is_account_member(account_id));
-- Writes: service role only (the sync API).
