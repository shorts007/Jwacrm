-- ============================================================
-- 052_lulu_hook_log.sql — visibility into the WACRM → LuLu webhook receiver
-- Every verified delivery (and every signature failure for a known endpoint)
-- is logged so the Campaigns page can show what happened to a STOP reply.
-- Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS lulu_hook_log (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  event       text,
  outcome     text NOT NULL,     -- opt_out | opt_in | ignored | status_tracked | ping | bad_signature | error | confirmation_failed …
  detail      text
);
CREATE INDEX IF NOT EXISTS lulu_hook_log_account_idx ON lulu_hook_log (account_id, received_at DESC);
ALTER TABLE lulu_hook_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lulu_hook_log_select ON lulu_hook_log;
CREATE POLICY lulu_hook_log_select ON lulu_hook_log FOR SELECT USING (is_account_member(account_id));
