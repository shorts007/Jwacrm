-- ============================================================
-- 058_lulu_usual_items.sql — V2 personalisation (PRD §44 Replenishment, §45 Buy Again)
-- usual_items: up to 5 replenishable products per customer from BigQuery picking data:
--   [{ "name": "Banana Ecuador 1 kg", "times": 6, "last": "2026-09-28", "every": 7 }, …]
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS usual_items jsonb;
