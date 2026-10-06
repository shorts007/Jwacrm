-- Recent delivered orders for campaign revenue attribution (read daily by the n8n sync →
-- POST /api/v1/lulu/attribution/sync). One row per order number; last 14 days; all stores
-- (an order counts for a campaign whatever store it came from).
CREATE OR REPLACE VIEW `myecomlulu.jackpot.lulu_recent_orders` AS
SELECT
  CAST(number AS STRING) AS order_id,
  CAST(shipping_address_phone_number AS STRING) AS phone,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', date_placed) AS placed_at,
  amount,
  IFNULL(discount_amount, 0) AS discount_amount
FROM `myecomlulu.jackpot.ksa_jackpot`
WHERE LOWER(status) = 'delivered'
  AND number IS NOT NULL
  AND shipping_address_phone_number IS NOT NULL
  AND date_placed >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY number
  ORDER BY (storeid IS NOT NULL) DESC, (discount_amount IS NOT NULL) DESC, date_placed DESC
) = 1;
