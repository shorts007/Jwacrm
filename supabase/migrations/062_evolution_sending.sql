-- ============================================================
-- 062_evolution_sending.sql — send and receive through the Evolution (WhatsApp app) number
--
-- conversations.channel now means "the number this chat is on": set when a customer writes
-- (to the Meta number or the WhatsApp app number) and when we send. NULL = not decided yet,
-- in which case the account default applies (Engagement → Channels → "Send through this number").
--
-- 061 created the column as NOT NULL DEFAULT 'meta', which pinned every existing chat to the
-- Meta test number. Existing values are cleared so the default sender applies until the
-- customer writes again. Idempotent.
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE conversations ALTER COLUMN channel DROP NOT NULL;
ALTER TABLE conversations ALTER COLUMN channel SET DEFAULT NULL;
UPDATE conversations SET channel = NULL WHERE channel = 'meta';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IS NULL OR channel IN ('meta', 'evolution'));

-- Phone-typed replies and API sends can arrive twice (our insert + Evolution's echo);
-- messages already has a unique (conversation_id, message_id) index from 037.
