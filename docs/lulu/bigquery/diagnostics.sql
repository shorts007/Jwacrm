-- Run these ONE AT A TIME before the first sync. Each answers a question the
-- customer_master.sql assumptions depend on.

-- 1) Which order statuses exist, and how much money is in each?
--    → decide the contents of `valid_statuses` in customer_master.sql
SELECT status, COUNT(*) AS orders, ROUND(SUM(amount), 0) AS sales,
       MIN(date_placed) AS first_seen, MAX(date_placed) AS last_seen
FROM `myecomlulu.jackpot.ksa_jackpot`
GROUP BY status ORDER BY orders DESC;

-- 2) Suspected shared / dummy phones, using the same rules as customer_master.sql
--    (> 3 different first names OR > 60 orders). Review the top of this list.
SELECT shipping_address_phone_number AS phone,
       COUNT(*) AS orders,
       COUNT(DISTINCT LOWER(TRIM(customer__first_name))) AS distinct_first_names,
       COUNT(DISTINCT LOWER(TRIM(customer__email))) AS distinct_emails,
       COUNT(DISTINCT DATE(date_placed)) AS active_days
FROM `myecomlulu.jackpot.ksa_jackpot`
WHERE LOWER(status) = 'delivered'
GROUP BY phone
HAVING COUNT(DISTINCT LOWER(TRIM(customer__first_name))) > 3 OR COUNT(*) > 60
ORDER BY orders DESC LIMIT 100;

-- 3) Does the item table join to the order table?
--    Expect a high match % for recent orders. Low % → the job_number
--    assumption is wrong and preferred store/category will be empty.
WITH o AS (
  SELECT CAST(number AS STRING) AS n FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE date_placed >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
),
i AS (
  SELECT DISTINCT REGEXP_EXTRACT(job_number, r'^Lulu-(\d+)') AS n
  FROM `myecomlulu.jackpot.instaleap_raw`
)
SELECT COUNT(*) AS orders_30d,
       COUNTIF(i.n IS NOT NULL) AS matched_to_items,
       ROUND(100 * COUNTIF(i.n IS NOT NULL) / COUNT(*), 1) AS match_pct
FROM o LEFT JOIN i ON o.n = i.n;

-- 4) Phone formats (length of the integer). Expect 12 digits starting 966.
SELECT LENGTH(CAST(shipping_address_phone_number AS STRING)) AS digits,
       SUBSTR(CAST(shipping_address_phone_number AS STRING), 1, 3) AS prefix,
       COUNT(*) AS orders
FROM `myecomlulu.jackpot.ksa_jackpot`
GROUP BY digits, prefix ORDER BY orders DESC LIMIT 20;

-- 6) The rows with NULL status (≈ 92k): what are they?
--    They have no amount and no date, so customer_master.sql ignores them.
--    Check whether they carry a phone / number and are real orders.
SELECT COUNT(*) AS rows_, COUNTIF(shipping_address_phone_number IS NOT NULL) AS with_phone,
       COUNTIF(number IS NOT NULL) AS with_number, COUNTIF(customer__email IS NOT NULL) AS with_email
FROM `myecomlulu.jackpot.ksa_jackpot` WHERE status IS NULL;

-- 7) Data window: is this a rolling window, or is older history somewhere else?
SELECT DATE_TRUNC(DATE(date_placed), MONTH) AS month, COUNT(*) AS orders,
       COUNT(DISTINCT shipping_address_phone_number) AS customers
FROM `myecomlulu.jackpot.ksa_jackpot` WHERE LOWER(status) = 'delivered'
GROUP BY month ORDER BY month;

-- 5) How many customers will the master produce?
--    (run customer_master.sql wrapped in SELECT COUNT(*) FROM ( ... ))

-- 8) Shapes of job_number. The customer master only understands 'Lulu-<digits>INP1'.
--    Any other shape here is a source of unmatched orders.
SELECT REGEXP_REPLACE(job_number, r'\d{6,}', '<N>') AS shape,
       COUNT(*) AS item_rows, COUNT(DISTINCT job_number) AS jobs,
       MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
FROM `myecomlulu.jackpot.instaleap_raw`
GROUP BY shape ORDER BY item_rows DESC LIMIT 20;

-- 9a) Which stores does the item table cover? (orders / jobs per store)
SELECT store_name_1 AS store, COUNT(DISTINCT job_number) AS jobs,
       MIN(DATE(created_at)) AS first_day, MAX(DATE(created_at)) AS last_day
FROM `myecomlulu.jackpot.instaleap_raw`
GROUP BY store ORDER BY jobs DESC LIMIT 30;

-- 9b) Item-table coverage by month vs the order table
WITH it AS (
  SELECT DATE_TRUNC(DATE(created_at), MONTH) AS month,
         COUNT(DISTINCT REGEXP_EXTRACT(job_number, r'(\d{9,})')) AS item_orders
  FROM `myecomlulu.jackpot.instaleap_raw` GROUP BY month
),
od AS (
  SELECT DATE_TRUNC(DATE(date_placed), MONTH) AS month, COUNT(*) AS orders
  FROM `myecomlulu.jackpot.ksa_jackpot` WHERE LOWER(status) = 'delivered' GROUP BY month
)
SELECT od.month, od.orders, it.item_orders, ROUND(100 * it.item_orders / od.orders, 1) AS pct
FROM od LEFT JOIN it USING (month) ORDER BY od.month;

-- 10) Which cities are matched / unmatched (last 30 days)?
WITH i AS (
  SELECT DISTINCT REGEXP_EXTRACT(job_number, r'(\d{9,})') AS n
  FROM `myecomlulu.jackpot.instaleap_raw`
)
SELECT o.shipping_address_city_name AS city, COUNT(*) AS orders,
       COUNTIF(i.n IS NOT NULL) AS matched,
       ROUND(100 * COUNTIF(i.n IS NOT NULL) / COUNT(*), 1) AS match_pct
FROM `myecomlulu.jackpot.ksa_jackpot` AS o
LEFT JOIN i ON CAST(o.number AS STRING) = i.n
WHERE o.date_placed >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY city ORDER BY orders DESC LIMIT 20;

-- 11) Freshness: when did the order table last receive data?
SELECT MAX(date_placed) AS latest_order, TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(date_placed), HOUR) AS hours_behind
FROM `myecomlulu.jackpot.ksa_jackpot`;

-- 12) Summary of the customer master. First save it as a view:
--       CREATE OR REPLACE VIEW `myecomlulu.jackpot.lulu_customer_master` AS
--       <paste customer_master.sql here, without the trailing ORDER BY / semicolon>;
--     (n8n can then simply SELECT * FROM that view.) Then run:
SELECT
  COUNT(*) AS customers,
  COUNTIF(suspect_reason IS NOT NULL) AS suspects,
  COUNTIF(suspect_reason IS NULL AND total_orders = 1) AS one_order_customers,
  COUNTIF(suspect_reason IS NULL AND total_orders >= 3) AS three_plus_orders,
  COUNTIF(vip_flag) AS vips,
  COUNTIF(preferred_store IS NOT NULL) AS with_store,
  ROUND(AVG(IF(suspect_reason IS NULL, total_orders, NULL)), 2) AS avg_orders
FROM `myecomlulu.jackpot.lulu_customer_master`;

-- 13) Why do only ~4% of customers have a preferred store (expected ~15%+ for the western region)?
--     Compare matched orders by item job_state, and how many have a store name.
WITH i AS (
  SELECT REGEXP_EXTRACT(job_number, r'^Lulu-(\d+)') AS n, job_state,
         ANY_VALUE(store_name_1) AS store
  FROM `myecomlulu.jackpot.instaleap_raw`
  GROUP BY n, job_state
)
SELECT i.job_state, COUNT(DISTINCT i.n) AS orders, COUNTIF(i.store IS NULL) AS without_store
FROM `myecomlulu.jackpot.ksa_jackpot` AS o
JOIN i ON CAST(o.number AS STRING) = i.n
WHERE LOWER(o.status) = 'delivered'
GROUP BY i.job_state ORDER BY orders DESC;

-- 14) Every city in the delivered orders, with order count and item-table match rate.
--     Use it to set `focus_cities` (western province) in customer_master.sql — spellings must match.
WITH i AS (
  SELECT DISTINCT REGEXP_EXTRACT(job_number, r'^Lulu-(\d+)') AS n FROM `myecomlulu.jackpot.instaleap_raw`
)
SELECT o.shipping_address_city_name AS city, COUNT(*) AS orders,
       COUNT(DISTINCT o.shipping_address_phone_number) AS customers,
       ROUND(100 * COUNTIF(i.n IS NOT NULL) / COUNT(*), 1) AS item_match_pct
FROM `myecomlulu.jackpot.ksa_jackpot` AS o
LEFT JOIN i ON CAST(o.number AS STRING) = i.n
WHERE LOWER(o.status) = 'delivered'
GROUP BY city ORDER BY orders DESC;

-- 15) How well are the new columns filled? (by month)
SELECT DATE_TRUNC(DATE(date_placed), MONTH) AS month, COUNT(*) AS orders,
       ROUND(100 * COUNTIF(discount_amount IS NOT NULL) / COUNT(*), 1) AS pct_with_discount_value,
       ROUND(100 * COUNTIF(discount_amount > 0) / COUNT(*), 1) AS pct_discounted,
       ROUND(100 * COUNTIF(client_type IS NOT NULL) / COUNT(*), 1) AS pct_with_client_type,
       ROUND(100 * COUNTIF(storeid IS NOT NULL) / COUNT(*), 1) AS pct_with_store
FROM `myecomlulu.jackpot.ksa_jackpot` WHERE LOWER(status) = 'delivered'
GROUP BY month ORDER BY month;

-- 16) client_type values and stores (Jeddah)
SELECT client_type, COUNT(*) AS orders, ROUND(AVG(amount), 1) AS avg_basket,
       ROUND(100 * COUNTIF(discount_amount > 0) / NULLIF(COUNTIF(discount_amount IS NOT NULL), 0), 1) AS pct_discounted
FROM `myecomlulu.jackpot.ksa_jackpot`
WHERE LOWER(status) = 'delivered' AND LOWER(shipping_address_city_name) = 'jeddah'
GROUP BY client_type ORDER BY orders DESC;

SELECT storeid, COUNT(*) AS orders, COUNT(DISTINCT shipping_address_phone_number) AS customers
FROM `myecomlulu.jackpot.ksa_jackpot`
WHERE LOWER(status) = 'delivered' AND LOWER(shipping_address_city_name) = 'jeddah'
GROUP BY storeid ORDER BY orders DESC;

-- 17) Is `amount` net or gross of discount?  discount ÷ (amount + discount) should cluster on round
--     promo percentages (10 %, 15 %, 20 %…) if amount is NET; discount ÷ amount if it is GROSS.
SELECT ROUND(100 * discount_amount / (amount + discount_amount)) AS pct_if_net,
       ROUND(100 * discount_amount / amount) AS pct_if_gross, COUNT(*) AS orders
FROM `myecomlulu.jackpot.ksa_jackpot`
WHERE discount_amount > 0 AND amount > 0 AND LOWER(status) = 'delivered'
GROUP BY pct_if_net, pct_if_gross ORDER BY orders DESC LIMIT 15;

-- 18) Duplicate orders (old data was appended). How many order numbers have more than one row,
--     and does one copy have the new columns while the other doesn't?
SELECT COUNT(*) AS total_rows, COUNT(DISTINCT number) AS unique_orders,
       COUNT(*) - COUNT(DISTINCT number) AS duplicate_rows
FROM `myecomlulu.jackpot.ksa_jackpot` WHERE number IS NOT NULL;

WITH d AS (
  SELECT number, COUNT(*) AS copies, COUNTIF(storeid IS NOT NULL) AS copies_with_store
  FROM `myecomlulu.jackpot.ksa_jackpot` WHERE number IS NOT NULL
  GROUP BY number HAVING COUNT(*) > 1
)
SELECT copies, copies_with_store, COUNT(*) AS orders FROM d GROUP BY copies, copies_with_store ORDER BY orders DESC;

-- 19) How long ago did the Jeddah customers last order? (run after creating the view)
SELECT CASE
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 15  THEN '0-14 days'
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 30  THEN '15-29 days'
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 60  THEN '30-59 days'
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 90  THEN '60-89 days'
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 180 THEN '90-179 days'
         WHEN DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY) < 365 THEN '180-364 days'
         ELSE '1 year +' END AS last_order_ago,
       COUNT(*) AS customers
FROM `myecomlulu.jackpot.lulu_customer_master`
WHERE suspect_reason IS NULL
GROUP BY last_order_ago ORDER BY MIN(DATE_DIFF(CURRENT_DATE('Asia/Riyadh'), DATE(last_order_date), DAY));

-- 20) Store distribution of Jeddah customers, computed EXACTLY like the customer master (deduped).
--     Compare with the "By store" table on /engagement.
WITH o AS (
  SELECT * FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE LOWER(status) = 'delivered' AND number IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY number
    ORDER BY (storeid IS NOT NULL) DESC, (client_type IS NOT NULL) DESC, (discount_amount IS NOT NULL) DESC, date_placed DESC) = 1
)
SELECT storeid, COUNT(*) AS orders, COUNT(DISTINCT shipping_address_phone_number) AS customers,
       MIN(DATE(date_placed)) AS first_day, MAX(DATE(date_placed)) AS last_day
FROM o WHERE LOWER(shipping_address_city_name) = 'jeddah'
GROUP BY storeid ORDER BY orders DESC;

-- 21) Do duplicate copies of the same order DISAGREE? (a wrong default storeid on appended rows would show here)
SELECT
  COUNTIF(stores > 1)  AS orders_with_conflicting_store,
  COUNTIF(amounts > 1) AS orders_with_conflicting_amount,
  COUNTIF(cities > 1)  AS orders_with_conflicting_city,
  COUNTIF(phones > 1)  AS orders_with_conflicting_phone,
  COUNT(*)             AS duplicated_orders
FROM (
  SELECT number, COUNT(DISTINCT storeid) AS stores, COUNT(DISTINCT amount) AS amounts,
         COUNT(DISTINCT shipping_address_city_name) AS cities, COUNT(DISTINCT shipping_address_phone_number) AS phones
  FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE number IS NOT NULL
  GROUP BY number HAVING COUNT(*) > 1
);

-- 22) WHICH stores disagree? (store values found in the copies of the same order)
WITH g AS (
  SELECT number,
         ARRAY_TO_STRING(ARRAY_AGG(DISTINCT CAST(storeid AS STRING) ORDER BY CAST(storeid AS STRING)), ' vs ') AS stores,
         COUNT(DISTINCT storeid) AS n
  FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE number IS NOT NULL AND storeid IS NOT NULL
  GROUP BY number
)
SELECT stores, COUNT(*) AS orders FROM g WHERE n > 1 GROUP BY stores ORDER BY orders DESC LIMIT 20;

-- 23) GROUND TRUTH: for orders whose copies disagree on store, which value matches the picking system?
--     (instaleap_raw records the store that actually fulfilled the order; available from Apr 2026.)
WITH items AS (
  SELECT DISTINCT REGEXP_EXTRACT(job_number, r'^Lulu-(\d+)') AS n,
         CAST(REGEXP_EXTRACT(store_name_1, r'^(\d{4})') AS INT64) AS item_store
  FROM `myecomlulu.jackpot.instaleap_raw`
  WHERE store_name_1 IS NOT NULL
),
conflicting AS (
  SELECT number FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE number IS NOT NULL AND storeid IS NOT NULL
  GROUP BY number HAVING COUNT(DISTINCT storeid) > 1
)
SELECT o.storeid AS store_in_this_copy, i.item_store AS store_that_fulfilled,
       o.storeid = i.item_store AS copy_is_correct, COUNT(*) AS copies
FROM `myecomlulu.jackpot.ksa_jackpot` AS o
JOIN conflicting AS c USING (number)
JOIN items AS i ON CAST(o.number AS STRING) = i.n
WHERE o.storeid IS NOT NULL
GROUP BY 1, 2, 3 ORDER BY copies DESC LIMIT 30;

-- 24) WHICH cities disagree between copies of the same order? (decides who is "in Jeddah")
WITH g AS (
  SELECT number,
         ARRAY_TO_STRING(ARRAY_AGG(DISTINCT shipping_address_city_name ORDER BY shipping_address_city_name), ' vs ') AS cities,
         COUNT(DISTINCT shipping_address_city_name) AS n
  FROM `myecomlulu.jackpot.ksa_jackpot`
  WHERE number IS NOT NULL AND shipping_address_city_name IS NOT NULL
  GROUP BY number
)
SELECT cities, COUNT(*) AS orders FROM g WHERE n > 1 GROUP BY cities ORDER BY orders DESC LIMIT 20;

-- Supabase (SQL editor, not BigQuery): how many profiles are stale / when were they last written?
--   select active, date_trunc('hour', synced_at) as last_written, count(*) from lulu_customer_profiles group by 1, 2 order by 2 desc;
