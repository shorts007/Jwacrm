# Customer Insights page (`/engagement/insights`)

Pipeline: BigQuery view `lulu_insights_metrics` (docs/lulu/bigquery/insights_metrics.sql → create_insights_view.sql)
→ n8n "Insights" branch → `POST /api/v1/lulu/insights/sync` → table `lulu_insights_snapshot` (migration 050) → page.
Only aggregates leave BigQuery (no names / phones).

| Section | Source group | Question it answers |
|---|---|---|
| Customer base today | lulu_customer_profiles | How many active / at-risk / dormant / lost / VIP / discount-driven customers |
| This month vs last month | monthly | Customers, orders, revenue, basket, new vs repeat, discount share & cost — with MoM change |
| Month-on-month trend | monthly | Revenue & orders, new vs repeat customers, discount dependence over time |
| Stores — MoM | store_monthly | Which store is growing / shrinking (orders, customers, revenue, new customers, discount cost) |
| Channels | channel_monthly | iOS vs Android vs website value and growth |
| Why customers come back — or don't | return30 | 30-day return rate by fulfilment (missing items / substitutions), discount, basket size, nth order, channel, store |
| New → repeat | first_order | 2nd-order-within-60-days rate by how the first order went |
| Retention cohorts | cohort | Share of each month's new customers still ordering N months later |
| When customers order | dow_hour | Weekday × hour heatmap (send-time windows) |
| How often customers order | frequency | Customers & revenue by lifetime orders |
| Products / departments | product, dept | Top products last 90 days vs previous 90; department revenue by month (picking data, Apr 2026+) |

Caveats: return rates show association, not proof of cause; picking-based sections cover Jeddah orders from Apr 2026;
department names need a code → name list; the latest month is month-to-date.
