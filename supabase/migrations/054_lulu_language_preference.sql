-- ============================================================
-- 054_lulu_language_preference.sql — customer-chosen message language
--
-- lulu_language_prefs : set when a customer taps "العربية" / "English" on a
--   bilingual message or sends a language keyword (English / عربي …) at any
--   time. Survives every BigQuery sync (the feed has no language field).
-- lulu_campaigns.template_name_bilingual : AR+EN template sent to customers
--   who have not chosen a language yet.
-- Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS lulu_language_prefs (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_digits text NOT NULL,
  language     text NOT NULL CHECK (language IN ('ar', 'en')),
  set_at       timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'whatsapp_reply',
  PRIMARY KEY (account_id, phone_digits)
);
ALTER TABLE lulu_language_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lulu_language_prefs_select ON lulu_language_prefs;
CREATE POLICY lulu_language_prefs_select ON lulu_language_prefs FOR SELECT USING (is_account_member(account_id));
-- Writes: service role only (webhook receiver).

ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS template_name_bilingual text;
