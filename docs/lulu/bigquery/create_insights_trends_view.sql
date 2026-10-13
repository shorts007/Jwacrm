-- Creates the view the insights sync reads for the month-on-month sections:
--   SELECT * FROM `myecomlulu.jackpot.lulu_insights_trends`
-- Same order base as lulu_insights_metrics: delivered orders, Jeddah stores, suspected shared phones excluded.
-- Separate from lulu_insights_metrics because one combined query is too complex for BigQuery
-- ("Number of stages in query is high"), which n8n treats as an error.
--
-- Groups:
--   dept             per month × department code: revenue, orders, customers (+ *_td = first N days, N = days of the current month)
--   product_monthly  per month × product (top 150 by orders + top 40 by revenue, last 3 months), same metrics
--   group_monthly    same per product GROUP (9-digit category: all tomatoes, all 30-pc egg trays…) — SKU swaps cancel out
--   group_label      best-selling product of each group (dim = group code, dim_value = name, value = products in group)
--   picking_coverage per month: all orders / customers / revenue and how many orders have picking detail
CREATE OR REPLACE VIEW `myecomlulu.jackpot.lulu_insights_trends` AS
WITH params AS (
  SELECT
    ['delivered'] AS valid_statuses,
    3805 AS unreliable_default_storeid,
    TRUE AS prefer_picking_store,
    3    AS max_names_per_phone,
    45   AS max_orders_90d_per_phone,
    [3805, 3806, 3808, 3809, 3810, 3814, 3818, 3821] AS focus_storeids,   -- Jeddah stores incl. 3821 Russaifa (same as customer_master.sql)
    12   AS cohort_months,
    30   AS return_window_days,
    90   AS product_window_days,
    40   AS top_products,
    6    AS trend_months,      -- month-on-month tables: current month + 6 before (6 columns, each with its previous month)
    150  AS trend_products,    -- products tracked month by month (by orders, last 3 months) + top 40 by revenue
    'Asia/Riyadh' AS tz
),

orders_raw AS (
  SELECT
    CAST(o.shipping_address_phone_number AS STRING) AS phone,
    o.number AS order_number,
    o.amount,
    o.discount_amount,
    -- 'default' = the website
    CASE WHEN LOWER(TRIM(o.client_type)) = 'default' THEN 'website' ELSE NULLIF(LOWER(TRIM(o.client_type)), '') END AS client_type,
    o.storeid,
    o.date_placed,
    DATE(o.date_placed, p.tz) AS order_date,
    LOWER(TRIM(o.customer__email)) AS email,
    NULLIF(LOWER(TRIM(o.customer__first_name)), '') AS first_name,
    NULLIF(TRIM(CONCAT(IFNULL(o.customer__first_name, ''), ' ', IFNULL(o.customer__last_name, ''))), '') AS full_name,
    NULLIF(TRIM(o.shipping_address_city_name), '') AS city
  FROM `myecomlulu.jackpot.ksa_jackpot` AS o
  CROSS JOIN params AS p
  WHERE o.shipping_address_phone_number IS NOT NULL
    AND o.number IS NOT NULL
    AND o.date_placed IS NOT NULL
    AND LOWER(o.status) IN UNNEST(p.valid_statuses)
  -- One row per order number. The table contains duplicates (old data was appended) whose copies can
  -- disagree on store: prefer a copy whose store is NOT the known-wrong default, then the copy with the
  -- new columns filled in, then the latest timestamp.
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY o.number
    ORDER BY (o.storeid IS NOT NULL AND o.storeid != p.unreliable_default_storeid) DESC,
             (o.storeid IS NOT NULL) DESC, (o.client_type IS NOT NULL) DESC,
             (o.discount_amount IS NOT NULL) DESC, o.date_placed DESC
  ) = 1
),

phone_quality AS (
  SELECT
    phone,
    COUNT(DISTINCT first_name) AS distinct_names,
    COUNT(DISTINCT email)      AS distinct_emails,
    NULLIF(ARRAY_TO_STRING([
      IF(COUNT(DISTINCT first_name) > (SELECT max_names_per_phone FROM params),
         CONCAT('many_names:', CAST(COUNT(DISTINCT first_name) AS STRING)), NULL),
      -- a single named person with many orders is a heavy buyer / small business, NOT a fake; and the rule looks
      -- at the LAST 90 DAYS so a long-standing heavy household (e.g. 87 orders over 20 months) is not flagged
      IF(COUNTIF(order_date >= DATE_SUB(CURRENT_DATE((SELECT tz FROM params)), INTERVAL 90 DAY)) > (SELECT max_orders_90d_per_phone FROM params)
           AND COUNT(DISTINCT first_name) >= 2,
         CONCAT('many_orders_90d:', CAST(COUNTIF(order_date >= DATE_SUB(CURRENT_DATE((SELECT tz FROM params)), INTERVAL 90 DAY)) AS STRING)), NULL)
    ], ','), '') AS suspect_reason
  FROM orders_raw
  GROUP BY phone
),

picking_store AS (
  SELECT order_number_str, ARRAY_AGG(item_store ORDER BY n DESC LIMIT 1)[OFFSET(0)] AS item_store
  FROM (
    SELECT REGEXP_EXTRACT(job_number, r'^Lulu-(\d+)') AS order_number_str,
           CAST(store_reference AS INT64) AS item_store,   -- the order table's storeid IS this store_reference
           COUNT(*) AS n
    FROM `myecomlulu.jackpot.instaleap_raw`
    WHERE store_reference IS NOT NULL AND job_number IS NOT NULL
    GROUP BY order_number_str, item_store
  )
  GROUP BY order_number_str
),

orders AS (
  SELECT r.* EXCEPT (storeid),
         COALESCE(IF((SELECT prefer_picking_store FROM params), ps.item_store, NULL), r.storeid) AS storeid
  FROM orders_raw AS r
  LEFT JOIN picking_store AS ps ON CAST(r.order_number AS STRING) = ps.order_number_str
),

base0 AS (
  SELECT o.*
  FROM orders AS o
  WHERE o.storeid IN UNNEST((SELECT focus_storeids FROM params))
    AND o.phone NOT IN (SELECT phone FROM phone_quality WHERE suspect_reason IS NOT NULL)
),
as_of AS (
  SELECT MAX(order_date) AS d, MAX(date_placed) AS ts FROM base0
),
base AS (
  SELECT b.*, FORMAT_DATE('%Y-%m', b.order_date) AS month, DATE_TRUNC(b.order_date, MONTH) AS month_date
  FROM base0 AS b
),

items_d AS (
  SELECT
    REGEXP_EXTRACT(i.job_number, r'^Lulu-(\d+)') AS order_number_str,
    CAST(i.store_reference AS INT64) AS item_store,
    TRIM(i.name) AS name,
    SUBSTR(REGEXP_EXTRACT(i.attributes, r'"category"\s*:\s*"(\d+)"'), 1, 3) AS dept,
    -- full 9-digit category = product group (e.g. all 30-pc egg trays, all tomatoes): SKU swaps don't look like collapses
    REGEXP_EXTRACT(i.attributes, r'"category"\s*:\s*"(\d+)"') AS fam,
    -- found_quantity is often empty on older rows: fall back to the ordered quantity
    IFNULL(i.price, 0) * COALESCE(i.found_quantity, i.quantity, 0) AS sales,
    COALESCE(i.found_quantity, i.quantity, 0) AS units,
    DATE(i.created_at, (SELECT tz FROM params)) AS d
  FROM `myecomlulu.jackpot.instaleap_raw` AS i
  WHERE NOT REGEXP_CONTAINS(UPPER(IFNULL(i.job_state, '')), r'CANCEL') AND i.name IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY i.updated_at DESC) = 1
),

-- ---------------------------------------------------------------- month-on-month by department / product
-- Picking items of the orders in `base` (same orders as the monthly figures), dated by ORDER date.
-- Picking detail is missing for some orders (Apr 2026 partly, ~6-9% from Aug 2026), so `picking_coverage`
-- gives the share of orders that have it; the page scales by it so a feed gap does not look like a drop.
-- *_td = first N days of each month, N = days elapsed in the current month (like-for-like with month-to-date).
td_day AS (SELECT EXTRACT(DAY FROM d) AS dom FROM as_of),
items_b AS (
  SELECT it.order_number_str, it.name, IFNULL(it.dept, 'unknown') AS dept, IFNULL(it.fam, 'unknown') AS fam, it.sales, it.units,
         b.phone, b.month, b.month_date, EXTRACT(DAY FROM b.order_date) <= (SELECT dom FROM td_day) AS in_td
  FROM items_d AS it
  JOIN base AS b ON CAST(b.order_number AS STRING) = it.order_number_str
  WHERE b.month_date >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL (SELECT trend_months FROM params) MONTH)
),
cover AS (
  SELECT b.month,
         COUNT(*) AS orders,
         COUNT(DISTINCT b.phone) AS customers,
         SUM(b.amount) AS revenue,
         COUNTIF(p.order_number_str IS NOT NULL) AS picked_orders,
         COUNTIF(EXTRACT(DAY FROM b.order_date) <= (SELECT dom FROM td_day)) AS orders_td,
         COUNT(DISTINCT IF(EXTRACT(DAY FROM b.order_date) <= (SELECT dom FROM td_day), b.phone, NULL)) AS customers_td,
         SUM(IF(EXTRACT(DAY FROM b.order_date) <= (SELECT dom FROM td_day), b.amount, 0)) AS revenue_td,
         COUNTIF(EXTRACT(DAY FROM b.order_date) <= (SELECT dom FROM td_day) AND p.order_number_str IS NOT NULL) AS picked_orders_td
  FROM base AS b
  LEFT JOIN (SELECT DISTINCT order_number_str FROM items_b) AS p ON CAST(b.order_number AS STRING) = p.order_number_str
  WHERE b.month_date >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL (SELECT trend_months FROM params) MONTH)
  GROUP BY b.month
),
m_cover AS (
  SELECT 'picking_coverage' AS grp, a.month AS period, 'all' AS dim, 'all' AS dim_value, x.metric, x.value
  FROM cover AS a,
  UNNEST([
    -- ALL orders of the month (the yardstick), and how many of them have picking detail
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('picked_orders' AS metric, CAST(a.picked_orders AS FLOAT64) AS value),
    STRUCT('orders_td' AS metric, CAST(a.orders_td AS FLOAT64) AS value),
    STRUCT('customers_td' AS metric, CAST(a.customers_td AS FLOAT64) AS value),
    STRUCT('revenue_td' AS metric, CAST(a.revenue_td AS FLOAT64) AS value),
    STRUCT('picked_orders_td' AS metric, CAST(a.picked_orders_td AS FLOAT64) AS value)
  ]) AS x
),
dept_month AS (
  SELECT month, dept,
         SUM(sales) AS revenue,
         COUNT(DISTINCT order_number_str) AS orders,
         COUNT(DISTINCT phone) AS customers,
         SUM(IF(in_td, sales, 0)) AS revenue_td,
         COUNT(DISTINCT IF(in_td, order_number_str, NULL)) AS orders_td,
         COUNT(DISTINCT IF(in_td, phone, NULL)) AS customers_td
  FROM items_b
  GROUP BY month, dept
),
m_dept AS (
  SELECT 'dept' AS grp, a.month AS period, 'dept' AS dim, a.dept AS dim_value, x.metric, x.value
  FROM dept_month AS a,
  UNNEST([
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue_td' AS metric, CAST(a.revenue_td AS FLOAT64) AS value),
    STRUCT('orders_td' AS metric, CAST(a.orders_td AS FLOAT64) AS value),
    STRUCT('customers_td' AS metric, CAST(a.customers_td AS FLOAT64) AS value)
  ]) AS x
),
prod_univ AS (
  SELECT name FROM (
    SELECT name, COUNT(DISTINCT order_number_str) AS o, SUM(sales) AS r
    FROM items_b
    WHERE month_date >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 2 MONTH)
    GROUP BY name
  )
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (ORDER BY o DESC) <= (SELECT trend_products FROM params)
       OR ROW_NUMBER() OVER (ORDER BY r DESC) <= (SELECT top_products FROM params)
),
prod_month AS (
  SELECT month, name,
         SUM(sales) AS revenue,
         COUNT(DISTINCT order_number_str) AS orders,
         COUNT(DISTINCT phone) AS customers,
         SUM(IF(in_td, sales, 0)) AS revenue_td,
         COUNT(DISTINCT IF(in_td, order_number_str, NULL)) AS orders_td,
         COUNT(DISTINCT IF(in_td, phone, NULL)) AS customers_td
  FROM items_b
  WHERE name IN (SELECT name FROM prod_univ)
  GROUP BY month, name
),
m_prod_month AS (
  SELECT 'product_monthly' AS grp, a.month AS period, 'product' AS dim, a.name AS dim_value, x.metric, x.value
  FROM prod_month AS a,
  UNNEST([
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    -- like-for-like days are only needed for the last two months (current month vs the same days before)
    STRUCT('revenue_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.revenue_td AS FLOAT64), NULL) AS value),
    STRUCT('orders_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.orders_td AS FLOAT64), NULL) AS value),
    STRUCT('customers_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.customers_td AS FLOAT64), NULL) AS value)
  ]) AS x
),
-- Product groups (9-digit category): same metrics, top 150 groups by orders + top 40 by revenue (last 3 months).
fam_univ AS (
  SELECT fam FROM (
    SELECT fam, COUNT(DISTINCT order_number_str) AS o, SUM(sales) AS r
    FROM items_b
    WHERE fam != 'unknown'
      AND month_date >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 2 MONTH)
    GROUP BY fam
  )
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (ORDER BY o DESC) <= (SELECT trend_products FROM params)
       OR ROW_NUMBER() OVER (ORDER BY r DESC) <= (SELECT top_products FROM params)
),
fam_month AS (
  SELECT month, fam,
         SUM(sales) AS revenue,
         COUNT(DISTINCT order_number_str) AS orders,
         COUNT(DISTINCT phone) AS customers,
         SUM(IF(in_td, sales, 0)) AS revenue_td,
         COUNT(DISTINCT IF(in_td, order_number_str, NULL)) AS orders_td,
         COUNT(DISTINCT IF(in_td, phone, NULL)) AS customers_td
  FROM items_b
  WHERE fam IN (SELECT fam FROM fam_univ)
  GROUP BY month, fam
),
m_fam_month AS (
  SELECT 'group_monthly' AS grp, a.month AS period, 'group' AS dim, a.fam AS dim_value, x.metric, x.value
  FROM fam_month AS a,
  UNNEST([
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.revenue_td AS FLOAT64), NULL) AS value),
    STRUCT('orders_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.orders_td AS FLOAT64), NULL) AS value),
    STRUCT('customers_td' AS metric, IF(a.month >= FORMAT_DATE('%Y-%m', DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 1 MONTH)), CAST(a.customers_td AS FLOAT64), NULL) AS value)
  ]) AS x
),
-- Label for each group: its best-selling product (last 3 months) and how many products it has.
m_fam_label AS (
  SELECT 'group_label' AS grp, 'all' AS period, fam AS dim, top_name AS dim_value, 'products' AS metric, CAST(skus AS FLOAT64) AS value
  FROM (
    SELECT fam, ARRAY_AGG(name ORDER BY o DESC, name LIMIT 1)[OFFSET(0)] AS top_name, COUNT(*) AS skus
    FROM (
      SELECT fam, name, COUNT(DISTINCT order_number_str) AS o
      FROM items_b
      WHERE fam IN (SELECT fam FROM fam_univ)
        AND month_date >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL 2 MONTH)
      GROUP BY fam, name
    )
    GROUP BY fam
  )
)

SELECT grp, period, dim, dim_value, metric, ROUND(value, 2) AS value
FROM (
  SELECT * FROM m_dept
  UNION ALL SELECT * FROM m_cover
  UNION ALL SELECT * FROM m_prod_month
  UNION ALL SELECT * FROM m_fam_month
  UNION ALL SELECT * FROM m_fam_label
)
WHERE value IS NOT NULL;
