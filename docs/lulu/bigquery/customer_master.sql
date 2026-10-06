-- ============================================================
-- LuLu customer master  →  feeds POST /api/v1/lulu/customers/sync
--
-- Sources
--   myecomlulu.jackpot.ksa_jackpot     one row per order: phone, name, amount, status, city,
--                                      discount_amount, client_type (ios/android/default…), storeid
--   myecomlulu.jackpot.instaleap_raw   one row per order item (category, price) — used ONLY for
--                                      preferred category and the storeid → store-name lookup
--
-- Output: ONE ROW PER CUSTOMER, column names match the sync API exactly.
--
-- Assumptions (verify with diagnostics.sql)
--   1. No customer_id exists → the normalised phone number IS the customer id.
--   2. Only orders with status in `valid_statuses` count as purchases.
--   3. `amount` is what the customer PAID (net of discount): in the samples
--      discount ÷ (amount + discount) = 20.0 % on several orders. If `amount` is the
--      PRE-discount total instead, set amount_is_net_of_discount = FALSE.
--   4. discount_amount NULL = "not recorded" (older rows), 0 = "no discount". Discount
--      statistics use only orders where it is recorded.
--   5. A phone used by many different FIRST NAMES, or by 2+ names with an implausible number of
--      orders, is a shared/dummy number. It is KEPT but flagged (`suspect_reason`) so the app can
--      show it and exclude it from campaigns, counts and scoring.
--   6. first_order_date is the first order in the data (history currently starts Jan/Feb 2025).
--      Duplicate rows per order `number` are removed (see orders_raw).
--   7. Region: phase 1 = Jeddah, defined by STORE (focus_storeids) because copies of the same order name the
--      city inconsistently ('Jeddah' vs 'Al Bawadi', 'Al Safa'…). A customer is kept if their latest order was
--      fulfilled by a Jeddah store. RFM quintiles and the VIP cut-off are computed within that focus group.
--      Store of an order = picking-system store when known (Apr 2026+), else the order table's storeid
--      (duplicate copies resolved by preferring a store that is not `unreliable_default_storeid`).
--   8. Categories come out as 3-digit department CODES (e.g. '006'); a code → name table is needed
--      to show names. Category exists only for orders that match the item table.
--   9. Not available in these tables → not emitted: birthday, loyalty_id, marketing_opt_in,
--      language (defaults to 'ar'), active_complaint.
-- ============================================================
WITH params AS (
  SELECT
    ['delivered'] AS valid_statuses,   -- add other "completed" status values if any
    -- Store ids that are a known-wrong DEFAULT on some appended rows. When copies of the same order
    -- disagree, the copy with a different store wins (business: 3810 Al Marwa, not 3805).
    3805 AS unreliable_default_storeid,
    -- Where the picking system (instaleap_raw, Apr 2026+) says which store fulfilled the order, trust it
    -- over the order table. Set FALSE to use only the order table's storeid.
    TRUE AS prefer_picking_store,
    3    AS max_names_per_phone,       -- families share a phone; > 3 different first names = suspect
    45   AS max_orders_90d_per_phone,  -- with 2+ names: more orders than this in the last 90 days = suspect
    0.05 AS vip_top_share,             -- top 5% by lifetime sales ...
    3    AS vip_min_orders,            -- ... with at least 3 orders
    180  AS item_lookback_days,        -- window for preferred category
    TRUE AS amount_is_net_of_discount, -- see assumption 3
    0.70 AS offer_driven_share,        -- >= 70 % of (known) orders discounted  → 'Offer-driven'
    0.20 AS full_price_share,          -- <= 20 % of (known) orders discounted  → 'Full-price'
    3    AS min_orders_for_sensitivity,
    -- Usual items (replenishment / buy again), from picking data (Apr 2026+):
    150  AS max_item_price,            -- skip expensive one-off items (phones, appliances)
    20   AS min_product_buyers,        -- product must be bought by at least N customers …
    0.20 AS min_repeat_rate,           -- … and re-bought by >= 20 % of them (a "replenishable" product)
    -- PHASE 1 FOCUS: Jeddah. City names are unreliable (copies of the same order say 'Jeddah' or a district
    -- such as 'Al Bawadi', 'Al Safa'…), so the focus is defined by STORE: a customer is kept if their latest
    -- order was fulfilled by one of these stores. Jeddah stores: 3805 Amir Fawaz, 3806 Kilo 7, 3808 Hamdaniya,
    -- 3809 Madeena Road, 3810 Al Marwa, 3814 Baghdadiya, 3818 AzizMall, 3821 Russaifa (confirmed).
    [3805, 3806, 3808, 3809, 3810, 3814, 3818, 3821] AS focus_storeids,
    'Jeddah' AS focus_region_name,     -- shown as the customer's city when the store matches
    -- Fallback used ONLY when focus_storeids is empty: latest order's city (case-insensitive). [] = everyone.
    ['jeddah'] AS focus_cities,
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

-- Per-phone data-quality stats (computed on ALL delivered orders).
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

-- Store that actually fulfilled each order, from the picking system (only Apr 2026+; most-used store if an order was split).
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

-- Personal purchase cycle, measured between distinct order DAYS so two
-- orders on the same day don't produce a 0-day "cycle".
order_days AS (
  SELECT DISTINCT phone, order_date FROM orders
),
gaps AS (
  SELECT
    phone,
    DATE_DIFF(order_date, LAG(order_date) OVER (PARTITION BY phone ORDER BY order_date), DAY) AS gap_days
  FROM order_days
),
cycle AS (
  SELECT
    phone,
    APPROX_QUANTILES(gap_days, 100)[OFFSET(50)] AS median_interval_days,
    ROUND(STDDEV_POP(gap_days), 2) AS stddev_interval_days
  FROM gaps
  WHERE gap_days IS NOT NULL
  GROUP BY phone
),

cust AS (
  SELECT
    phone,
    COUNT(*) AS total_orders,
    ROUND(SUM(amount), 2) AS total_sales,
    ROUND(AVG(amount), 2) AS average_order_value,
    MIN(order_date) AS first_order_date,
    MAX(order_date) AS last_order_date,
    COUNTIF(order_date >= DATE_SUB(CURRENT_DATE((SELECT tz FROM params)), INTERVAL 30 DAY)) AS orders_30d,
    COUNTIF(order_date >= DATE_SUB(CURRENT_DATE((SELECT tz FROM params)), INTERVAL 90 DAY)) AS orders_90d,
    ARRAY_AGG(full_name IGNORE NULLS ORDER BY date_placed DESC LIMIT 1)[SAFE_OFFSET(0)] AS name,
    ARRAY_AGG(city IGNORE NULLS ORDER BY date_placed DESC LIMIT 1)[SAFE_OFFSET(0)] AS city,
    ARRAY_AGG(storeid IGNORE NULLS ORDER BY date_placed DESC LIMIT 1)[SAFE_OFFSET(0)] AS latest_storeid,
    COUNT(DISTINCT storeid) AS stores_used,
    -- discount behaviour (only orders where discount_amount is recorded)
    COUNTIF(discount_amount IS NOT NULL) AS orders_with_discount_data,
    COUNTIF(discount_amount > 0) AS discounted_orders,
    ROUND(SUM(IFNULL(discount_amount, 0)), 2) AS total_discount,
    SUM(IF(discount_amount IS NOT NULL,
           IF((SELECT amount_is_net_of_discount FROM params), amount + discount_amount, amount),
           0)) AS gross_with_discount_data
  FROM orders
  GROUP BY phone
),

-- Most-used store and channel (ties → most recent).
pref_store_id AS (
  SELECT phone, storeid AS preferred_store_id
  FROM (
    SELECT phone, storeid, COUNT(*) AS n, MAX(date_placed) AS last_at
    FROM orders WHERE storeid IS NOT NULL GROUP BY phone, storeid
  )
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY phone ORDER BY n DESC, last_at DESC) = 1
),
pref_channel AS (
  SELECT phone, client_type AS preferred_channel
  FROM (
    SELECT phone, client_type, COUNT(*) AS n, MAX(date_placed) AS last_at
    FROM orders WHERE client_type IS NOT NULL GROUP BY phone, client_type
  )
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY phone ORDER BY n DESC, last_at DESC) = 1
),

-- storeid → readable store name, from the item table's store labels
-- ('3805-LH,AMIR FAWAZ,KSA' → 'AMIR FAWAZ'). Falls back to the bare id.
store_names AS (
  SELECT
    CAST(REGEXP_EXTRACT(store_name_1, r'^(\d{4})') AS INT64) AS storeid,
    ARRAY_AGG(
      TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(store_name_1, r'^\d{4}\s*-\s*', ''), r'^LH[,_ -]*', ''), r',?\s*KSA$', ''))
      ORDER BY created_at DESC LIMIT 1
    )[SAFE_OFFSET(0)] AS store_name
  FROM `myecomlulu.jackpot.instaleap_raw`
  WHERE REGEXP_CONTAINS(store_name_1, r'^\d{4}')
  GROUP BY storeid
),

-- Preferred category (3-digit department code) from the item table, last N days.
items AS (
  SELECT
    REGEXP_EXTRACT(i.job_number, r'^Lulu-(\d+)') AS order_number_str,  -- strips 'Lulu-' prefix and 'INP1' suffix
    -- regex instead of JSON_VALUE: BigQuery has no SAFE.JSON_VALUE and JSON_VALUE errors on malformed JSON
    SUBSTR(REGEXP_EXTRACT(i.attributes, r'"category"\s*:\s*"(\d+)"'), 1, 3) AS dept,
    -- found_quantity is often empty on older rows: fall back to the ordered quantity
    IFNULL(i.price, 0) * COALESCE(i.found_quantity, i.quantity, 0) AS item_sales
  FROM `myecomlulu.jackpot.instaleap_raw` AS i
  CROSS JOIN params AS p
  WHERE i.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL p.item_lookback_days DAY)
    AND NOT REGEXP_CONTAINS(UPPER(IFNULL(i.job_state, '')), r'CANCEL')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY i.updated_at DESC) = 1
),
joined AS (
  SELECT o.phone, it.dept, it.item_sales
  FROM orders AS o
  JOIN items AS it ON CAST(o.order_number AS STRING) = it.order_number_str
),
pref_dept AS (
  SELECT phone, dept AS preferred_category
  FROM (
    SELECT phone, dept, SUM(item_sales) AS spend
    FROM joined
    WHERE dept IS NOT NULL
    GROUP BY phone, dept
  )
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY phone ORDER BY spend DESC, dept) = 1
),

-- ---------------------------------------------------------------- usual items (V2 personalisation)
item_hist AS (
  SELECT REGEXP_EXTRACT(i.job_number, r'^Lulu-(\d+)') AS order_number_str,
         TRIM(i.name) AS name,
         IFNULL(i.price, 0) AS price
  FROM `myecomlulu.jackpot.instaleap_raw` AS i
  WHERE i.name IS NOT NULL
    AND NOT REGEXP_CONTAINS(UPPER(IFNULL(i.job_state, '')), r'CANCEL')
    AND NOT IFNULL(i.is_substitute, FALSE)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY i.updated_at DESC) = 1
),
cust_item_days AS (
  SELECT o.phone, h.name, o.order_date, AVG(h.price) AS price
  FROM orders AS o
  JOIN item_hist AS h ON CAST(o.order_number AS STRING) = h.order_number_str
  GROUP BY o.phone, h.name, o.order_date
),
cust_item_gaps AS (
  SELECT *, DATE_DIFF(order_date, LAG(order_date) OVER (PARTITION BY phone, name ORDER BY order_date), DAY) AS gap
  FROM cust_item_days
),
cust_item AS (
  SELECT phone, name, COUNT(*) AS times, MAX(order_date) AS last_d, AVG(price) AS avg_price,
         APPROX_QUANTILES(gap, 100 IGNORE NULLS)[SAFE_OFFSET(50)] AS own_gap
  FROM cust_item_gaps
  GROUP BY phone, name
),
product_stats AS (
  SELECT name, COUNT(*) AS buyers, COUNTIF(times >= 2) / COUNT(*) AS repeat_rate,
         APPROX_QUANTILES(own_gap, 100 IGNORE NULLS)[SAFE_OFFSET(50)] AS typical_gap
  FROM cust_item
  GROUP BY name
),
usual AS (
  -- Up to 5 replenishable items per customer: name, times bought, last bought, usual gap in days
  -- (the customer's own gap after 3+ purchases, else the product's typical gap among repeat buyers).
  SELECT ci.phone,
         TO_JSON_STRING(ARRAY_AGG(STRUCT(
           ci.name AS name,
           ci.times AS times,
           CAST(ci.last_d AS STRING) AS last,
           CAST(COALESCE(IF(ci.times >= 3, ci.own_gap, NULL), ps.typical_gap) AS INT64) AS every
         ) ORDER BY ci.times DESC, ci.last_d DESC LIMIT 5)) AS usual_items
  FROM cust_item AS ci
  JOIN product_stats AS ps USING (name)
  WHERE ci.times >= 2
    AND ci.avg_price <= (SELECT max_item_price FROM params)
    AND ps.buyers >= (SELECT min_product_buyers FROM params)
    AND ps.repeat_rate >= (SELECT min_repeat_rate FROM params)
    AND COALESCE(IF(ci.times >= 3, ci.own_gap, NULL), ps.typical_gap) BETWEEN 3 AND 90
  GROUP BY ci.phone
),

scored AS (
  SELECT
    c.*,
    q.distinct_names,
    q.distinct_emails,
    q.suspect_reason,
    -- Scoring is done only among genuine customers: suspects get their own
    -- partition so they cannot distort the quintiles or the VIP cut-off.
    NTILE(5) OVER (PARTITION BY q.suspect_reason IS NULL ORDER BY c.last_order_date ASC) AS rfm_recency,   -- 5 = most recent
    NTILE(5) OVER (PARTITION BY q.suspect_reason IS NULL ORDER BY c.total_orders ASC)    AS rfm_frequency, -- 5 = most orders
    NTILE(5) OVER (PARTITION BY q.suspect_reason IS NULL ORDER BY c.total_sales ASC)     AS rfm_monetary,  -- 5 = highest spend
    PERCENT_RANK() OVER (PARTITION BY q.suspect_reason IS NULL ORDER BY c.total_sales ASC) AS sales_pct
  FROM cust AS c
  JOIN phone_quality AS q ON q.phone = c.phone
  WHERE IF(ARRAY_LENGTH((SELECT focus_storeids FROM params)) > 0,
           c.latest_storeid IN UNNEST((SELECT focus_storeids FROM params)),
           ARRAY_LENGTH((SELECT focus_cities FROM params)) = 0
             OR LOWER(c.city) IN UNNEST((SELECT focus_cities FROM params)))
)

SELECT
  s.phone                                   AS customer_id,
  s.phone                                   AS mobile,            -- API normalises 966… / 05… to +966…
  s.name,
  'ar'                                      AS language,          -- no language source yet
  CAST(s.first_order_date AS STRING)        AS first_order_date,
  CAST(s.last_order_date AS STRING)         AS last_order_date,
  s.total_orders,
  s.total_sales,
  s.average_order_value,
  s.orders_30d,
  s.orders_90d,
  cy.median_interval_days,
  cy.stddev_interval_days,
  -- store: name from the item-table labels, else the bare id
  CASE WHEN ps.preferred_store_id IS NULL THEN NULL
       ELSE CONCAT(IFNULL(sn.store_name, 'Store'), ' (', CAST(ps.preferred_store_id AS STRING), ')') END AS preferred_store,
  ps.preferred_store_id,
  s.stores_used,
  pc.preferred_channel,                     -- ios / android / website
  pd.preferred_category,
  -- discount behaviour: 'Offer-driven' | 'Mixed' | 'Full-price' | NULL (too little data)
  CASE
    WHEN s.orders_with_discount_data < (SELECT min_orders_for_sensitivity FROM params) THEN NULL
    WHEN SAFE_DIVIDE(s.discounted_orders, s.orders_with_discount_data) >= (SELECT offer_driven_share FROM params) THEN 'Offer-driven'
    WHEN SAFE_DIVIDE(s.discounted_orders, s.orders_with_discount_data) <= (SELECT full_price_share FROM params) THEN 'Full-price'
    ELSE 'Mixed'
  END                                       AS price_sensitivity,
  ROUND(SAFE_DIVIDE(s.discounted_orders, s.orders_with_discount_data), 4) AS discount_order_share,
  ROUND(100 * SAFE_DIVIDE(s.total_discount, s.gross_with_discount_data), 1) AS avg_discount_pct,
  s.total_discount,
  CASE
    WHEN s.suspect_reason IS NOT NULL                THEN 'Suspect'
    WHEN s.total_orders = 1                          THEN 'New'
    WHEN s.rfm_recency >= 4 AND s.rfm_frequency >= 4 THEN 'Champions'
    WHEN s.rfm_frequency >= 4                        THEN 'Loyal'
    WHEN s.rfm_recency >= 4                          THEN 'Potential Loyalist'
    WHEN s.rfm_recency <= 2 AND s.rfm_frequency >= 3 THEN 'At Risk'
    WHEN s.rfm_recency = 1                           THEN 'Lost'
    ELSE 'Needs Attention'
  END                                       AS customer_segment,
  s.rfm_recency,
  s.rfm_frequency,
  s.rfm_monetary,
  s.total_sales                             AS lifetime_value,
  (s.suspect_reason IS NULL
     AND s.sales_pct >= 1 - (SELECT vip_top_share FROM params)
     AND s.total_orders >= (SELECT vip_min_orders FROM params)) AS vip_flag,
  s.distinct_names,
  s.distinct_emails,
  s.suspect_reason,
  IF(ARRAY_LENGTH((SELECT focus_storeids FROM params)) > 0
       AND s.latest_storeid IN UNNEST((SELECT focus_storeids FROM params)),
     (SELECT focus_region_name FROM params), s.city) AS city,
  u.usual_items,                            -- JSON array: [{name, times, last, every}] (V2 personalisation)
  -- newest order in the source data; lets the app warn when the feed is stale
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', (SELECT MAX(date_placed) FROM orders_raw)) AS data_as_of
FROM scored AS s
LEFT JOIN cycle         AS cy ON cy.phone = s.phone
LEFT JOIN pref_store_id AS ps ON ps.phone = s.phone
LEFT JOIN store_names   AS sn ON sn.storeid = ps.preferred_store_id
LEFT JOIN pref_channel  AS pc ON pc.phone = s.phone
LEFT JOIN pref_dept     AS pd ON pd.phone = s.phone
LEFT JOIN usual         AS u  ON u.phone  = s.phone
ORDER BY s.phone;
