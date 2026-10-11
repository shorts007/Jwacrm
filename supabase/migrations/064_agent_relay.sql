-- ============================================================
-- 064_agent_relay.sql — agents answer customers from their own WhatsApp
--
-- A customer writes to the WhatsApp app number (Evolution) → the message is forwarded to the
-- assigned agent's personal WhatsApp → the agent swipe-replies → the reply goes to the customer
-- from the app number and is saved in the Inbox. Assignment: the agent who handled the customer
-- last time if on duty, otherwise the on-duty agent with the fewest open chats; no reply within
-- N minutes (default 10) → handed to another on-duty agent.
--
--   relay_settings  one per account: on/off, minutes before hand-over, offline message
--   relay_agents    agents: name, WhatsApp number, enabled, on duty
--   relay_threads   one per conversation: #code, current agent, open/closed, waiting state
--   relay_forwards  each message forwarded to an agent (so a swipe-reply finds its chat)
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS relay_settings (
  account_id        uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT false,
  response_minutes  integer NOT NULL DEFAULT 10 CHECK (response_minutes BETWEEN 2 AND 240),
  offline_message   text,            -- sent to the customer when no agent is on duty (max once per 12 h)
  last_sweep_at     timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone_digits  text NOT NULL CHECK (phone_digits ~ '^[0-9]{8,15}$'),
  enabled       boolean NOT NULL DEFAULT true,
  on_duty       boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, phone_digits)
);

CREATE SEQUENCE IF NOT EXISTS relay_thread_code_seq START 100;

CREATE TABLE IF NOT EXISTS relay_threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  code                bigint NOT NULL DEFAULT nextval('relay_thread_code_seq'),
  agent_id            uuid REFERENCES relay_agents(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  awaiting_reply      boolean NOT NULL DEFAULT true,
  assigned_at         timestamptz,
  last_customer_at    timestamptz,
  last_agent_reply_at timestamptz,
  reminded_at         timestamptz,
  offline_sent_at     timestamptz,
  handovers           integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id),
  UNIQUE (code)
);
CREATE INDEX IF NOT EXISTS relay_threads_open_idx ON relay_threads (account_id, status, awaiting_reply);
CREATE INDEX IF NOT EXISTS relay_threads_agent_idx ON relay_threads (agent_id, status);

CREATE TABLE IF NOT EXISTS relay_forwards (
  id                  bigserial PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id           uuid NOT NULL REFERENCES relay_threads(id) ON DELETE CASCADE,
  agent_id            uuid REFERENCES relay_agents(id) ON DELETE SET NULL,
  forward_message_id  text,            -- id of the copy sent to the agent (what a swipe-reply quotes)
  source_message_id   text,            -- the customer's message id (dedupe)
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_forwards_fwd_idx ON relay_forwards (account_id, forward_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS relay_forwards_source_idx ON relay_forwards (thread_id, agent_id, source_message_id);

-- Members read; admins configure. Server routes (service role) do the relaying.
ALTER TABLE relay_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_agents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay_forwards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS relay_settings_select ON relay_settings;
CREATE POLICY relay_settings_select ON relay_settings FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS relay_settings_admin ON relay_settings;
CREATE POLICY relay_settings_admin ON relay_settings FOR ALL USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS relay_agents_select ON relay_agents;
CREATE POLICY relay_agents_select ON relay_agents FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS relay_agents_admin ON relay_agents;
CREATE POLICY relay_agents_admin ON relay_agents FOR ALL USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS relay_threads_select ON relay_threads;
CREATE POLICY relay_threads_select ON relay_threads FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS relay_threads_admin ON relay_threads;
CREATE POLICY relay_threads_admin ON relay_threads FOR UPDATE USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS relay_forwards_select ON relay_forwards;
CREATE POLICY relay_forwards_select ON relay_forwards FOR SELECT USING (is_account_member(account_id));

-- Audit (063): who added / removed agents or changed relay settings.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'lulu_audit_trigger') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS lulu_audit ON relay_agents';
    EXECUTE 'CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON relay_agents FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger(''last_seen_at'', '''')';
    EXECUTE 'DROP TRIGGER IF EXISTS lulu_audit ON relay_settings';
    EXECUTE 'CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON relay_settings FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger(''last_sweep_at'', '''')';
  END IF;
END $$;
