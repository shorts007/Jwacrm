-- ============================================================
-- 059_lulu_items_as_of.sql — freshness of the item (picking) data per sync
-- items_as_of = last day covered by instaleap_raw. Item-based messages (Replenishment,
-- Buy Again) are only sent when the customer's last order is covered by item data —
-- otherwise we cannot know what they just bought.
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_customer_profiles ADD COLUMN IF NOT EXISTS items_as_of date;
