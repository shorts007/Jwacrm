-- ============================================================
-- 047_lulu_queue_send_fields.sql — action-queue columns used by the sender
--   is_test      : message went to an internal test number, not a customer
--   recipient    : E.164 number actually messaged (test number or customer)
--   template_*   : what was sent (audit / replay)
--   wa_message_id, sent_at : delivery bookkeeping
-- Idempotent. Rows are written by server routes with the service-role key.
-- ============================================================
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS recipient text;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS template_name text;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS template_language text;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS template_params jsonb;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS wa_message_id text;
ALTER TABLE lulu_customer_next_actions ADD COLUMN IF NOT EXISTS sent_at timestamptz;
