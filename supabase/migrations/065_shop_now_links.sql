-- ============================================================
-- 065_shop_now_links.sql — "Shop now" link in campaign and promotion messages
--
--   lulu_contact_policy.default_shop_url  link used by every campaign that has none of its own
--   lulu_campaigns.shop_url               per campaign / promotion link (overrides the default)
--
-- On the WhatsApp app number the link is added under the message ("🛒 Shop now: https://…").
-- Must be https:// (WhatsApp only makes https links tappable). Idempotent.
-- ============================================================
ALTER TABLE lulu_contact_policy ADD COLUMN IF NOT EXISTS default_shop_url text;
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS shop_url text;

ALTER TABLE lulu_contact_policy DROP CONSTRAINT IF EXISTS lulu_contact_policy_shop_url_check;
ALTER TABLE lulu_contact_policy ADD CONSTRAINT lulu_contact_policy_shop_url_check
  CHECK (default_shop_url IS NULL OR default_shop_url ~ '^https://[^[:space:]]+$');
ALTER TABLE lulu_campaigns DROP CONSTRAINT IF EXISTS lulu_campaigns_shop_url_check;
ALTER TABLE lulu_campaigns ADD CONSTRAINT lulu_campaigns_shop_url_check
  CHECK (shop_url IS NULL OR shop_url ~ '^https://[^[:space:]]+$');
