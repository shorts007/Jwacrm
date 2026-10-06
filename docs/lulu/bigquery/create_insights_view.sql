-- Creates the view the insights sync reads:  SELECT * FROM `myecomlulu.jackpot.lulu_insights_metrics`
-- (generated from insights_metrics.sql)
CREATE OR REPLACE VIEW `myecomlulu.jackpot.lulu_insights_metrics` AS
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
  SELECT
    b.*,
    FORMAT_DATE('%Y-%m', b.order_date) AS month,
    DATE_TRUNC(b.order_date, MONTH) AS month_date,
    IFNULL(b.discount_amount, 0) > 0 AS discounted,
    MIN(b.order_date) OVER (PARTITION BY b.phone) AS first_date,
    ROW_NUMBER() OVER (PARTITION BY b.phone ORDER BY b.date_placed) AS order_seq,
    LEAD(b.order_date) OVER (PARTITION BY b.phone ORDER BY b.date_placed) AS next_order_date
  FROM base0 AS b
),

-- Fulfilment quality per order from the picking system (Apr 2026+). A replaced original item is not "missing".
fulfil AS (
  SELECT order_number_str,
         CASE WHEN COUNTIF(found_known) = 0 THEN 'no item detail'
              WHEN SUM(missing) > 0 THEN 'missing items'
              WHEN SUM(subs) > 0 THEN 'substituted'
              ELSE 'complete' END AS fulfilment
  FROM (
    SELECT
      REGEXP_EXTRACT(i.job_number, r'^Lulu-(\d+)') AS order_number_str,
      i.found_quantity IS NOT NULL AS found_known,
      -- missing only when the picker actually recorded a found quantity; replaced originals are not "missing"
      IF(i.found_quantity IS NULL OR IFNULL(i.is_substitute, FALSE) OR NULLIF(i.replaced_by, '') IS NOT NULL, 0,
         GREATEST(IFNULL(i.quantity, 0) - i.found_quantity, 0)) AS missing,
      IF(IFNULL(i.is_substitute, FALSE), 1, 0) AS subs
    FROM `myecomlulu.jackpot.instaleap_raw` AS i
    WHERE NOT REGEXP_CONTAINS(UPPER(IFNULL(i.job_state, '')), r'CANCEL')
    QUALIFY ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY i.updated_at DESC) = 1
  )
  GROUP BY order_number_str
),

-- ---------------------------------------------------------------- monthly
monthly_agg AS (
  SELECT
    month,
    COUNT(*) AS orders,
    COUNT(DISTINCT phone) AS customers,
    SUM(amount) AS revenue,
    COUNT(DISTINCT IF(DATE_TRUNC(first_date, MONTH) = month_date, phone, NULL)) AS new_customers,
    SUM(IF(DATE_TRUNC(first_date, MONTH) = month_date, amount, 0)) AS new_customer_revenue,
    COUNTIF(discounted) AS discounted_orders,
    COUNTIF(discount_amount IS NOT NULL) AS orders_with_discount_data,
    SUM(IFNULL(discount_amount, 0)) AS discount_cost
  FROM base
  GROUP BY month
),
m_monthly AS (
  SELECT 'monthly' AS grp, a.month AS period, 'all' AS dim, 'all' AS dim_value, x.metric, x.value
  FROM monthly_agg AS a,
  UNNEST([
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('new_customers' AS metric, CAST(a.new_customers AS FLOAT64) AS value),
    STRUCT('new_customer_revenue' AS metric, CAST(a.new_customer_revenue AS FLOAT64) AS value),
    STRUCT('discounted_orders' AS metric, CAST(a.discounted_orders AS FLOAT64) AS value),
    STRUCT('orders_with_discount_data' AS metric, CAST(a.orders_with_discount_data AS FLOAT64) AS value),
    STRUCT('discount_cost' AS metric, CAST(a.discount_cost AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- store × month
store_agg AS (
  SELECT
    month, CAST(storeid AS STRING) AS store,
    COUNT(*) AS orders,
    COUNT(DISTINCT phone) AS customers,
    SUM(amount) AS revenue,
    COUNT(DISTINCT IF(DATE_TRUNC(first_date, MONTH) = month_date, phone, NULL)) AS new_customers,
    COUNTIF(discounted) AS discounted_orders,
    SUM(IFNULL(discount_amount, 0)) AS discount_cost
  FROM base
  GROUP BY month, store
),
m_store AS (
  SELECT 'store_monthly' AS grp, a.month AS period, 'store' AS dim, a.store AS dim_value, x.metric, x.value
  FROM store_agg AS a,
  UNNEST([
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('new_customers' AS metric, CAST(a.new_customers AS FLOAT64) AS value),
    STRUCT('discounted_orders' AS metric, CAST(a.discounted_orders AS FLOAT64) AS value),
    STRUCT('discount_cost' AS metric, CAST(a.discount_cost AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- channel × month
channel_agg AS (
  SELECT
    month, IFNULL(client_type, 'unknown') AS channel,
    COUNT(*) AS orders,
    COUNT(DISTINCT phone) AS customers,
    SUM(amount) AS revenue,
    COUNT(DISTINCT IF(DATE_TRUNC(first_date, MONTH) = month_date, phone, NULL)) AS new_customers,
    COUNTIF(discounted) AS discounted_orders,
    COUNTIF(discount_amount IS NOT NULL) AS orders_with_discount_data,
    SUM(IFNULL(discount_amount, 0)) AS discount_cost
  FROM base
  GROUP BY month, channel
),
m_channel AS (
  SELECT 'channel_monthly' AS grp, a.month AS period, 'channel' AS dim, a.channel AS dim_value, x.metric, x.value
  FROM channel_agg AS a,
  UNNEST([
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('new_customers' AS metric, CAST(a.new_customers AS FLOAT64) AS value),
    STRUCT('discounted_orders' AS metric, CAST(a.discounted_orders AS FLOAT64) AS value),
    STRUCT('orders_with_discount_data' AS metric, CAST(a.orders_with_discount_data AS FLOAT64) AS value),
    STRUCT('discount_cost' AS metric, CAST(a.discount_cost AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- 30-day return rate by condition
ret_base AS (
  SELECT
    b.*,
    f.fulfilment,
    (b.next_order_date IS NOT NULL
       AND DATE_DIFF(b.next_order_date, b.order_date, DAY) <= (SELECT return_window_days FROM params)) AS returned
  FROM base AS b
  LEFT JOIN fulfil AS f ON CAST(b.order_number AS STRING) = f.order_number_str
  WHERE b.order_date <= DATE_SUB((SELECT d FROM as_of), INTERVAL (SELECT return_window_days FROM params) DAY)
),
ret_agg AS (
  SELECT c.dim, c.dim_value, COUNT(*) AS orders, COUNTIF(r.returned) AS returned
  FROM ret_base AS r,
  UNNEST([
    STRUCT('all' AS dim, 'all' AS dim_value),
    STRUCT('discounted' AS dim, IF(r.discounted, 'yes', 'no') AS dim_value),
    STRUCT('channel' AS dim, IFNULL(r.client_type, 'unknown') AS dim_value),
    STRUCT('store' AS dim, IFNULL(CAST(r.storeid AS STRING), 'unknown') AS dim_value),
    STRUCT('basket' AS dim, CASE WHEN r.amount < 100 THEN '1: under 100'
                                 WHEN r.amount < 200 THEN '2: 100-199'
                                 WHEN r.amount < 400 THEN '3: 200-399'
                                 ELSE '4: 400+' END AS dim_value),
    STRUCT('order_number' AS dim, CASE WHEN r.order_seq = 1 THEN '1st order'
                                       WHEN r.order_seq = 2 THEN '2nd order'
                                       WHEN r.order_seq = 3 THEN '3rd order'
                                       ELSE '4th+ order' END AS dim_value),
    STRUCT('fulfilment' AS dim, IFNULL(r.fulfilment, 'no picking data') AS dim_value)
  ]) AS c
  GROUP BY c.dim, c.dim_value
),
m_return AS (
  SELECT 'return30' AS grp, 'all' AS period, a.dim, a.dim_value, x.metric, x.value
  FROM ret_agg AS a,
  UNNEST([
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('returned' AS metric, CAST(a.returned AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- first order → 2nd order within 60 days
first_base AS (
  SELECT b.*, f.fulfilment,
         (b.next_order_date IS NOT NULL AND DATE_DIFF(b.next_order_date, b.order_date, DAY) <= 60) AS second_60d
  FROM base AS b
  LEFT JOIN fulfil AS f ON CAST(b.order_number AS STRING) = f.order_number_str
  WHERE b.order_seq = 1
    AND b.order_date <= DATE_SUB((SELECT d FROM as_of), INTERVAL 60 DAY)
),
first_agg AS (
  SELECT c.dim, c.dim_value, COUNT(*) AS customers, COUNTIF(r.second_60d) AS second_order_60d
  FROM first_base AS r,
  UNNEST([
    STRUCT('all' AS dim, 'all' AS dim_value),
    STRUCT('discounted' AS dim, IF(r.discounted, 'yes', 'no') AS dim_value),
    STRUCT('channel' AS dim, IFNULL(r.client_type, 'unknown') AS dim_value),
    STRUCT('store' AS dim, IFNULL(CAST(r.storeid AS STRING), 'unknown') AS dim_value),
    STRUCT('fulfilment' AS dim, IFNULL(r.fulfilment, 'no picking data') AS dim_value)
  ]) AS c
  GROUP BY c.dim, c.dim_value
),
m_first AS (
  SELECT 'first_order' AS grp, 'all' AS period, a.dim, a.dim_value, x.metric, x.value
  FROM first_agg AS a,
  UNNEST([
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('second_order_60d' AS metric, CAST(a.second_order_60d AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- retention cohorts
m_cohort AS (
  SELECT 'cohort' AS grp, FORMAT_DATE('%Y-%m', cohort) AS period, 'month_offset' AS dim,
         CAST(off AS STRING) AS dim_value, 'customers' AS metric, CAST(COUNT(DISTINCT phone) AS FLOAT64) AS value
  FROM (
    SELECT phone, DATE_TRUNC(first_date, MONTH) AS cohort,
           DATE_DIFF(month_date, DATE_TRUNC(first_date, MONTH), MONTH) AS off
    FROM base
  )
  WHERE cohort >= DATE_SUB(DATE_TRUNC((SELECT d FROM as_of), MONTH), INTERVAL (SELECT cohort_months FROM params) MONTH)
    AND off <= (SELECT cohort_months FROM params)
  GROUP BY cohort, off
),

-- ---------------------------------------------------------------- order-frequency distribution
freq_agg AS (
  SELECT
    CASE WHEN n = 1 THEN '1' WHEN n = 2 THEN '2' WHEN n <= 5 THEN '3-5' WHEN n <= 10 THEN '6-10' ELSE '11+' END AS band,
    COUNT(*) AS customers, SUM(rev) AS revenue
  FROM (SELECT phone, COUNT(*) AS n, SUM(amount) AS rev FROM base GROUP BY phone)
  GROUP BY band
),
m_freq AS (
  SELECT 'frequency' AS grp, 'all' AS period, 'orders_band' AS dim, a.band AS dim_value, x.metric, x.value
  FROM freq_agg AS a,
  UNNEST([
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value),
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value)
  ]) AS x
),

-- ---------------------------------------------------------------- weekday × hour (Riyadh), last 180 days
m_dow AS (
  SELECT 'dow_hour' AS grp, 'last180' AS period, 'dow_hour' AS dim,
         FORMAT('%d-%02d', EXTRACT(DAYOFWEEK FROM DATETIME(date_placed, (SELECT tz FROM params))),
                EXTRACT(HOUR FROM DATETIME(date_placed, (SELECT tz FROM params)))) AS dim_value,
         'orders' AS metric, CAST(COUNT(*) AS FLOAT64) AS value
  FROM base
  WHERE order_date > DATE_SUB((SELECT d FROM as_of), INTERVAL 180 DAY)
  GROUP BY dim_value
),

-- ---------------------------------------------------------------- products & departments (picking data)
items_d AS (
  SELECT
    REGEXP_EXTRACT(i.job_number, r'^Lulu-(\d+)') AS order_number_str,
    CAST(i.store_reference AS INT64) AS item_store,
    TRIM(i.name) AS name,
    SUBSTR(REGEXP_EXTRACT(i.attributes, r'"category"\s*:\s*"(\d+)"'), 1, 3) AS dept,
    -- found_quantity is often empty on older rows: fall back to the ordered quantity
    IFNULL(i.price, 0) * COALESCE(i.found_quantity, i.quantity, 0) AS sales,
    COALESCE(i.found_quantity, i.quantity, 0) AS units,
    DATE(i.created_at, (SELECT tz FROM params)) AS d
  FROM `myecomlulu.jackpot.instaleap_raw` AS i
  WHERE NOT REGEXP_CONTAINS(UPPER(IFNULL(i.job_state, '')), r'CANCEL') AND i.name IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY i.updated_at DESC) = 1
),
items_f AS (
  SELECT it.*, b.phone
  FROM items_d AS it
  LEFT JOIN base AS b ON CAST(b.order_number AS STRING) = it.order_number_str
  WHERE it.item_store IN UNNEST((SELECT focus_storeids FROM params))
),
items_as_of AS (SELECT MAX(d) AS d FROM items_f),
prod_agg AS (
  SELECT
    name,
    SUM(IF(d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL (SELECT product_window_days FROM params) DAY), sales, 0)) AS revenue,
    SUM(IF(d <= DATE_SUB((SELECT d FROM items_as_of), INTERVAL (SELECT product_window_days FROM params) DAY), sales, 0)) AS revenue_prev,
    SUM(IF(d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL (SELECT product_window_days FROM params) DAY), units, 0)) AS units,
    COUNT(DISTINCT IF(d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL (SELECT product_window_days FROM params) DAY), order_number_str, NULL)) AS orders,
    COUNT(DISTINCT IF(d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL (SELECT product_window_days FROM params) DAY), phone, NULL)) AS customers
  FROM items_f
  WHERE d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL 2 * (SELECT product_window_days FROM params) DAY)
  GROUP BY name
),
prod_top AS (
  SELECT * FROM prod_agg
  WHERE TRUE
  -- top N by revenue PLUS top N by number of customers (everyday drivers)
  QUALIFY ROW_NUMBER() OVER (ORDER BY revenue DESC) <= (SELECT top_products FROM params)
       OR ROW_NUMBER() OVER (ORDER BY customers DESC) <= (SELECT top_products FROM params)
),
m_product AS (
  SELECT 'product' AS grp, 'last90' AS period, 'product' AS dim, a.name AS dim_value, x.metric, x.value
  FROM prod_top AS a,
  UNNEST([
    STRUCT('revenue' AS metric, CAST(a.revenue AS FLOAT64) AS value),
    STRUCT('revenue_prev' AS metric, CAST(a.revenue_prev AS FLOAT64) AS value),
    STRUCT('units' AS metric, CAST(a.units AS FLOAT64) AS value),
    STRUCT('orders' AS metric, CAST(a.orders AS FLOAT64) AS value),
    STRUCT('customers' AS metric, CAST(a.customers AS FLOAT64) AS value)
  ]) AS x
),
m_dept AS (
  SELECT 'dept' AS grp, FORMAT_DATE('%Y-%m', d) AS period, 'dept' AS dim, IFNULL(dept, 'unknown') AS dim_value,
         'revenue' AS metric, CAST(SUM(sales) AS FLOAT64) AS value
  FROM items_f
  WHERE d > DATE_SUB((SELECT d FROM items_as_of), INTERVAL 180 DAY)
  GROUP BY period, dim_value
),

m_meta AS (
  SELECT 'meta' AS grp, 'all' AS period, 'data_as_of' AS dim,
         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', (SELECT ts FROM as_of)) AS dim_value,
         'orders_in_base' AS metric, CAST((SELECT COUNT(*) FROM base0) AS FLOAT64) AS value
)

SELECT grp, period, dim, dim_value, metric, ROUND(value, 2) AS value
FROM (
  SELECT * FROM m_monthly
  UNION ALL SELECT * FROM m_store
  UNION ALL SELECT * FROM m_channel
  UNION ALL SELECT * FROM m_return
  UNION ALL SELECT * FROM m_first
  UNION ALL SELECT * FROM m_cohort
  UNION ALL SELECT * FROM m_freq
  UNION ALL SELECT * FROM m_dow
  UNION ALL SELECT * FROM m_product
  UNION ALL SELECT * FROM m_dept
  UNION ALL SELECT * FROM m_meta
)
WHERE value IS NOT NULL;
