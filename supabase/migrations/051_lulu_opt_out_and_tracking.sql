-- ============================================================
-- 051_lulu_opt_out_and_tracking.sql — STOP / START handling + delivery tracking
--
-- lulu_opt_outs : every phone that replied STOP (kept even if the phone is not a
--                 synced customer yet, so a later sync can never re-opt them in).
-- Unique index on campaign events so at-least-once webhook deliveries
-- (delivered / read / failed) are recorded once.
-- Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS lulu_opt_outs (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_digits text NOT NULL,                 -- digits only, e.g. 966501234567
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'whatsapp_reply',
  keyword      text,
  PRIMARY KEY (account_id, phone_digits)
);
ALTER TABLE lulu_opt_outs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lulu_opt_outs_select ON lulu_opt_outs;
CREATE POLICY lulu_opt_outs_select ON lulu_opt_outs FOR SELECT USING (is_account_member(account_id));
-- Writes: service role only (webhook receiver).

CREATE UNIQUE INDEX IF NOT EXISTS lulu_ce_dedupe_idx
  ON lulu_campaign_events (account_id, wa_message_id, event_type)
  WHERE wa_message_id IS NOT NULL;
