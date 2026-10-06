-- ============================================================
-- 053_lulu_live_sending.sql — settings + statuses for live customer sends
--   daily_send_cap               max customer messages per Riyadh day (default 100)
--   send_gap_base_seconds        wait before the 1st message of the day (default 60)
--   send_gap_increment_seconds   +N s for every following message (default 1 → 60, 61, 62 …)
--   SENDING                      in-flight status so two runners can never send the same action
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_contact_policy ADD COLUMN IF NOT EXISTS daily_send_cap             integer NOT NULL DEFAULT 100;
ALTER TABLE lulu_contact_policy ADD COLUMN IF NOT EXISTS send_gap_base_seconds      integer NOT NULL DEFAULT 60;
ALTER TABLE lulu_contact_policy ADD COLUMN IF NOT EXISTS send_gap_increment_seconds integer NOT NULL DEFAULT 1;

ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS finished_at timestamptz;  -- when SENT / FAILED / CANCELLED

ALTER TABLE lulu_customer_next_actions DROP CONSTRAINT IF EXISTS lulu_customer_next_actions_status_check;
ALTER TABLE lulu_customer_next_actions ADD CONSTRAINT lulu_customer_next_actions_status_check
  CHECK (status IN ('READY','SCHEDULED','SENDING','SENT','SKIPPED','CANCELLED','FAILED'));

CREATE INDEX IF NOT EXISTS lulu_nba_live_idx
  ON lulu_customer_next_actions (account_id, created_at)
  WHERE is_test = false;
