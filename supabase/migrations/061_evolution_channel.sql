-- ============================================================
-- 061_evolution_channel.sql — Evolution API as a second WhatsApp channel
--
-- whatsapp_config stays as it is (one Meta connection per account, used for
-- template approval and as a channel). Evolution gets its own table so both
-- can be connected at the same time.
--
--   evolution_config   one per account: server URL, instance, API key (encrypted),
--                      webhook secret, live connection state, latest QR code
--   evolution_event_log last raw webhook deliveries (secrets/media stripped) —
--                      used for diagnostics and to build/verify the inbound parser
--   conversations.channel  which channel a chat lives on ('meta' | 'evolution')
--
-- Only server routes (service role) read/write these tables; the API key never
-- reaches the browser. Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS evolution_config (
  account_id        uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  base_url          text NOT NULL,                 -- e.g. https://evo.example.com
  instance_name     text NOT NULL,
  api_key           text NOT NULL,                 -- encrypted (ENCRYPTION_KEY)
  webhook_secret    text NOT NULL,                 -- random; part of our webhook URL
  state             text NOT NULL DEFAULT 'unknown', -- open | connecting | close | unknown
  connected_number  text,                          -- digits of the linked WhatsApp number
  profile_name      text,
  qr_code           text,                          -- latest QR (data URL) while pairing
  qr_updated_at     timestamptz,
  last_event_at     timestamptz,
  is_default_outbound boolean NOT NULL DEFAULT false, -- new conversations / campaigns go out via Evolution
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_config_secret_idx ON evolution_config (webhook_secret);
ALTER TABLE evolution_config ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only (holds an API key).

CREATE TABLE IF NOT EXISTS evolution_event_log (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  event       text,
  outcome     text,
  payload     jsonb
);
CREATE INDEX IF NOT EXISTS evolution_event_log_idx ON evolution_event_log (account_id, received_at DESC);
ALTER TABLE evolution_event_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'meta';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('meta', 'evolution'));
