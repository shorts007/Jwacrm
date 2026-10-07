-- ============================================================
-- 060_lulu_cross_sell.sql — V2 personalisation (PRD §46 Cross-sell)
-- cross_sell: the best "often bought together" product this customer has never bought:
--   { "anchor": "Almarai Fresh Milk Full Fat 2.85 Litre", "product": "Lusine Sliced Milk Bread 600 g",
--     "confidence": 0.18, "lift": 2.4 }
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS cross_sell jsonb;
