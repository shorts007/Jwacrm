-- ============================================================
-- 063_app_number_safety_and_audit.sql
--
-- 1. WhatsApp app number (Evolution) safety
--    evolution_config gets: warm-up start, max per day, sending hours, auto-pause switch,
--    pause state. evolution_send_log records every business-initiated send through the app
--    number (campaigns, broadcasts, tests) so daily limits and health checks can be computed.
--
-- 2. Audit log (PRD §75)
--    lulu_audit_log + one trigger function on the tables people configure: campaigns, offers,
--    contact policy, the app-number settings and message templates. Records who (signed-in
--    user, or "system" for automatic / API changes), what and when, with only the changed
--    fields. Secrets are never copied. Read-only for account members.
-- Idempotent.
-- ============================================================

-- ---------- 1. App-number safety ----------
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS max_daily integer NOT NULL DEFAULT 100;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS window_start_hour integer NOT NULL DEFAULT 10;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS window_end_hour integer NOT NULL DEFAULT 21;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS auto_pause boolean NOT NULL DEFAULT true;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS paused_reason text;
ALTER TABLE evolution_config ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE evolution_config DROP CONSTRAINT IF EXISTS evolution_config_window_check;
ALTER TABLE evolution_config ADD CONSTRAINT evolution_config_window_check
  CHECK (window_start_hour BETWEEN 0 AND 23 AND window_end_hour BETWEEN 1 AND 24 AND window_start_hour < window_end_hour AND max_daily BETWEEN 1 AND 1000);

CREATE TABLE IF NOT EXISTS evolution_send_log (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  message_id  text,
  recipient   text,          -- digits
  error       text
);
CREATE INDEX IF NOT EXISTS evolution_send_log_idx ON evolution_send_log (account_id, sent_at DESC);
ALTER TABLE evolution_send_log ENABLE ROW LEVEL SECURITY;
-- No policies: written and read by server routes (service role) only.

-- ---------- 2. Audit log ----------
CREATE TABLE IF NOT EXISTS lulu_audit_log (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL,           -- no FK: rows written while an account is being deleted must not block it
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,                   -- null = system / API / automatic
  actor_name   text,
  entity       text NOT NULL,          -- table name
  entity_id    text,
  entity_label text,                   -- campaign / offer / template name
  action       text NOT NULL,          -- INSERT | UPDATE | DELETE
  changes      jsonb NOT NULL DEFAULT '{}'::jsonb  -- { field: { "from": …, "to": … } }
);
CREATE INDEX IF NOT EXISTS lulu_audit_log_idx ON lulu_audit_log (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lulu_audit_log_entity_idx ON lulu_audit_log (account_id, entity, entity_id);
ALTER TABLE lulu_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lulu_audit_log_select ON lulu_audit_log;
CREATE POLICY lulu_audit_log_select ON lulu_audit_log FOR SELECT USING (is_account_member(account_id));

-- TG_ARGV: comma-separated columns to ignore (noise) and comma-separated columns to redact.
CREATE OR REPLACE FUNCTION lulu_audit_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ignore_cols text[] := string_to_array(coalesce(TG_ARGV[0], ''), ',');
  redact_cols text[] := string_to_array(coalesce(TG_ARGV[1], ''), ',');
  old_j jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  new_j jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
  row_j jsonb := CASE WHEN TG_OP = 'DELETE' THEN old_j ELSE new_j END;
  diff jsonb := '{}'::jsonb;
  k text;
  actor uuid;
  who text;
BEGIN
  FOR k IN SELECT DISTINCT key FROM (SELECT jsonb_object_keys(old_j) AS key UNION SELECT jsonb_object_keys(new_j)) s LOOP
    CONTINUE WHEN k = ANY (ignore_cols) OR k IN ('updated_at', 'created_at', 'updated_by');
    IF (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
      IF k = ANY (redact_cols) THEN
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', CASE WHEN old_j ? k THEN '"[hidden]"'::jsonb END, 'to', CASE WHEN new_j ? k THEN '"[hidden]"'::jsonb END));
      ELSE
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k));
      END IF;
    END IF;
  END LOOP;
  IF diff = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  -- INSERT / DELETE: keep the row's identifying fields only, not every column.
  IF TG_OP <> 'UPDATE' THEN
    diff := (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(diff)
             WHERE key IN ('name', 'campaign_code', 'campaign_type', 'offer_code', 'offer_type', 'value', 'status', 'mode', 'active',
                           'language', 'category', 'instance_name', 'base_url', 'is_default_outbound'));
  END IF;

  actor := auth.uid();
  IF actor IS NULL AND row_j ? 'updated_by' THEN
    actor := nullif(row_j ->> 'updated_by', '')::uuid;
  END IF;
  IF actor IS NOT NULL THEN
    SELECT coalesce(nullif(full_name, ''), email) INTO who FROM profiles WHERE user_id = actor LIMIT 1;
  END IF;

  INSERT INTO lulu_audit_log (account_id, actor_id, actor_name, entity, entity_id, entity_label, action, changes)
  VALUES (
    (row_j ->> 'account_id')::uuid,
    actor,
    coalesce(who, CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END),
    TG_TABLE_NAME,
    coalesce(row_j ->> 'id', row_j ->> 'account_id'),
    coalesce(row_j ->> 'name', row_j ->> 'offer_code', row_j ->> 'campaign_code', row_j ->> 'instance_name'),
    TG_OP,
    diff
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lulu_audit ON lulu_campaigns;
CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON lulu_campaigns
  FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger('', '');

DROP TRIGGER IF EXISTS lulu_audit ON lulu_offers;
CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON lulu_offers
  FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger('', '');

DROP TRIGGER IF EXISTS lulu_audit ON lulu_contact_policy;
CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON lulu_contact_policy
  FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger('', '');

DROP TRIGGER IF EXISTS lulu_audit ON evolution_config;
CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON evolution_config
  FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger(
    'state,qr_code,qr_updated_at,last_event_at,connected_number,profile_name',
    'api_key,webhook_secret');

DROP TRIGGER IF EXISTS lulu_audit ON message_templates;
CREATE TRIGGER lulu_audit AFTER INSERT OR UPDATE OR DELETE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION lulu_audit_trigger('quality_score,last_submitted_at', '');
