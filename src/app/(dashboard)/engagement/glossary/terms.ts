/**
 * Glossary content for /engagement/glossary.
 * Numbers reflect the app's default settings; where a value is configurable the entry says where.
 * Keep in sync with src/lib/lulu (lifecycle.ts, contact-policy.ts, defaults.ts, sender.ts, offers.ts, attribution.ts)
 * and docs/lulu/bigquery/customer_master.sql.
 */

export interface Term {
  term: string;
  /** Other names the term goes by on screen (also searched). */
  aka?: string[];
  meaning: string;
  example?: string;
}

export interface TermSection {
  id: string;
  title: string;
  intro?: string;
  terms: Term[];
}

export const GLOSSARY: TermSection[] = [
  {
    id: "data",
    title: "Customer base & data",
    intro:
      "Where the numbers come from. Orders live in BigQuery; once a day the n8n sync copies one summary row per customer into the app.",
    terms: [
      {
        term: "Total customers",
        aka: ["Customers"],
        meaning:
          "Every genuine customer currently in the synced customer base: phone numbers with at least one delivered order whose latest order was fulfilled by a focus store. Suspected shared/fake numbers and customers who dropped out of the feed are not counted.",
        example: "25,391 customers = everyone with a delivered order in the Jeddah stores, minus the 63 suspected shared numbers.",
      },
      {
        term: "Customer ID",
        meaning: "There is no separate customer number in the order data, so the customer's phone number (e.g. 966501234567) is used as their ID.",
      },
      {
        term: "Focus stores (Jeddah)",
        aka: ["Focus region", "focus_storeids"],
        meaning:
          "Phase 1 covers only customers whose latest order was fulfilled by a Jeddah store: 3805 Amir Fawaz, 3806 Kilo 7, 3808 Hamdaniya, 3809 Madeena Road, 3810 Al Marwa, 3814 Baghdadiya, 3818 AzizMall, 3821 Russaifa. Set in BigQuery (customer_master.sql). City names are not used because the same order can say 'Jeddah' or a district name.",
      },
      {
        term: "Suspected shared / fake number",
        aka: ["Suspect", "suspect_reason", "many_names", "many_orders_90d"],
        meaning:
          "A phone number that looks shared by many people: more than 3 different first names on its orders, or 2+ names with more than 45 orders in the last 90 days. These numbers are never messaged and are left out of every count and score. One person with many orders is NOT flagged.",
        example: "+966547438501 — 1,152 orders under 20 different names → 'many_names:20'. A family of 2 ordering weekly is not flagged.",
      },
      {
        term: "Order data as of",
        aka: ["data_as_of", "Freshness"],
        meaning:
          "Time of the newest order in the last sync. If it is more than 36 hours old the app shows an amber warning and refuses to send live messages — otherwise someone who ordered yesterday could get a 'we miss you' message.",
        example: "'Order data as of 5 Oct, 3:08 PM (50 h ago)' → refresh BigQuery and re-run the sync before sending.",
      },
      {
        term: "Item data / picking data",
        aka: ["instaleap_raw", "items_as_of"],
        meaning:
          "Item-level data (which products were in each order) from the picking system, available for Jeddah from April 2026. Used for usual items, restock reminders, cross-sell, products and departments. 'Items as of' is the last day it covers.",
      },
      {
        term: "Duplicate orders",
        meaning:
          "The order table contains several copies of some orders. The app keeps one row per order number, preferring the copy with store/channel/discount filled in, and the picking system's store when copies disagree.",
      },
      {
        term: "Synced / active profile",
        meaning:
          "A customer row the last complete sync contained. Customers who disappear from the feed are hidden (not deleted) and come back automatically if they reappear. Not the same as the lifecycle stage 'Active'.",
      },
    ],
  },
  {
    id: "lifecycle",
    title: "Lifecycle stages",
    intro:
      "Every customer is in exactly one stage, worked out from how long it has been since their last order. For customers with 3+ orders the app uses their OWN rhythm (median days between orders); otherwise fixed day limits. Day limits come from the campaigns' settings (15 / 30 / 60 by default).",
    terms: [
      {
        term: "New",
        meaning: "No delivered orders yet (rare in this data).",
      },
      {
        term: "First order",
        aka: ["New / first order"],
        meaning: "Exactly one order, placed less than 15 days ago.",
        example: "Ordered once, 6 days ago → First order.",
      },
      {
        term: "Active",
        meaning:
          "Ordering on their normal rhythm. With a known rhythm: less than 1.5× their usual gap since the last order (and never inactive within 7 days). Without one: less than 15 days.",
        example: "Usually orders every 9 days, last order 10 days ago (1.1×) → Active.",
      },
      {
        term: "At risk",
        meaning: "Overdue: 1.5× to 3× their usual gap since the last order (fixed rule: 15–29 days).",
        example: "Usually every 7 days, last order 15 days ago (2.1×) → At risk. Someone who usually orders every 45 days is still Active on day 15.",
      },
      {
        term: "Dormant",
        meaning: "Well overdue: 3× to 6× their usual gap (fixed rule: 30–59 days).",
        example: "Usually every 10 days, last order 35 days ago (3.5×) → Dormant.",
      },
      {
        term: "Lost",
        meaning: "6× their usual gap or more (fixed rule: 60+ days). Lost customers inactive for over 180 days are deliberately not messaged.",
        example: "Last order 8 months ago → Lost, and left alone by campaigns.",
      },
      {
        term: "Usual gap / purchase cycle",
        aka: ["Usually orders every", "median_interval_days"],
        meaning: "The middle value of the days between a customer's orders (counted between different order days). Needs 3+ orders.",
        example: "Gaps of 7, 9, 9, 12 days → usually orders every 9 days.",
      },
      {
        term: "Next order expected",
        meaning: "Last order date + usual gap. Shown on Customer 360.",
      },
    ],
  },
  {
    id: "attributes",
    title: "Customer attributes",
    terms: [
      {
        term: "VIP",
        meaning: "Top 5% of genuine customers by lifetime spend AND at least 3 orders. Calculated in BigQuery within the focus group.",
        example: "56 orders, SAR 25,802 lifetime → VIP.",
      },
      {
        term: "RFM scores",
        aka: ["Recency", "Frequency", "Monetary"],
        meaning:
          "Three scores from 1 to 5 (5 = best) ranking customers into fifths: Recency = how recently they ordered, Frequency = how many orders, Monetary = how much they spent.",
        example: "5 / 5 / 5 = ordered recently, orders a lot, spends a lot.",
      },
      {
        term: "Segment",
        aka: ["Champions", "Loyal", "Potential Loyalist", "Needs Attention", "RFM segment"],
        meaning:
          "A descriptive label from the RFM scores: New (1 order), Champions (recent + frequent: R≥4 and F≥4), Loyal (frequent: F≥4), Potential Loyalist (recent: R≥4), At Risk (not recent but used to buy often: R≤2, F≥3), Lost (R=1), Needs Attention (everything else), Suspect (shared number). Segments describe; lifecycle stages drive campaigns.",
        example: "The segment 'At Risk' and the lifecycle stage 'At risk' are different measures and can disagree.",
      },
      {
        term: "Price behaviour",
        aka: ["Discount behaviour", "Offer-driven", "Mixed", "Full-price", "Discount-driven", "Full-price buyers", "not enough data"],
        meaning:
          "How much a customer relies on discounts, from orders where the discount is recorded: Offer-driven = 70%+ of orders discounted; Full-price = 20% or fewer; Mixed = in between; 'not enough data' = fewer than 3 orders with discount information.",
        example: "4% of orders discounted → Full-price. Offers exclude Full-price buyers by default because they buy anyway.",
      },
      {
        term: "Preferred store",
        meaning: "The store that fulfilled most of the customer's orders (ties → most recent).",
      },
      {
        term: "Channel",
        aka: ["Preferred channel", "ios", "android", "website"],
        meaning: "How the customer orders most often: iOS app, Android app or website ('default' in the raw data means website).",
      },
      {
        term: "Usual items",
        meaning:
          "Up to 5 everyday products a customer buys repeatedly: bought 2+ times by them, bought by 20+ customers and re-bought by 20%+ of buyers, priced SAR 150 or less, repeat gap 3–90 days. Each has times bought, last bought and usual gap.",
        example: "Potato Saudi 1 kg — bought 15 times, usually every 10 days.",
      },
      {
        term: "Restock status",
        aka: ["due now", "overdue", "in N days", "habit lapsed", "unknown"],
        meaning:
          "For each usual item: 'in N days' (not yet), 'due now' (0.9–1.2× its gap), 'overdue' (1.2–2×), 'habit lapsed' (over 2× — probably stopped buying it), 'unknown' (they ordered after the item data ends, so we can't see what they bought).",
      },
      {
        term: "Cross-sell suggestion",
        meaning:
          "A product often bought together with something the customer buys regularly, which they have never bought. Shows how often baskets contain both and how much more than chance.",
        example: "Buys Almarai milk regularly; 18% of baskets with that milk also have Lusine bread (2.4× chance) → suggest the bread.",
      },
      {
        term: "Message language",
        aka: ["Language preference", "not chosen — gets both"],
        meaning:
          "Chosen by the customer by tapping العربية / English on a bilingual message or sending English / EN / انجليزي / عربي / Arabic / العربية at any time. Until they choose, they get messages in both languages.",
      },
    ],
  },
  {
    id: "permissions",
    title: "Messaging permissions & safety rules",
    terms: [
      {
        term: "Opted in",
        meaning:
          "Allowed to receive marketing messages. Everyone starts opted in because the order data has no consent field — confirm consent is collected at checkout before scaling up.",
      },
      {
        term: "Opted out",
        aka: ["Opted out of messages", "STOP", "Unsubscribe"],
        meaning:
          "The customer replied STOP, Stop messages, Unsubscribe, إيقاف, إلغاء or الغاء الاشتراك (the whole message must be just that). They get a confirmation and no further marketing, even if a later sync says otherwise. The card counts every phone that replied STOP.",
        example: "'STOP' → unsubscribed. 'Please stop the late deliveries' → just a normal message.",
      },
      {
        term: "START",
        aka: ["Re-subscribe", "ابدأ"],
        meaning: "Replying START or ابدأ subscribes the customer to online offers again.",
      },
      {
        term: "Campaign eligible",
        meaning: "Opted-in customers with no open complaint — the pool campaigns can choose from, before frequency limits, the daily cap and other rules.",
      },
      {
        term: "Quiet hours",
        meaning: "No customer messages between 22:00 and 09:00 Riyadh time.",
      },
      {
        term: "Frequency limits",
        aka: ["promo_frequency_cap", "marketing_frequency_cap"],
        meaning: "At most 3 promotional messages per 7 days and 5 marketing messages per 14 days per customer.",
      },
      {
        term: "Ordered recently",
        aka: ["ordered_recently"],
        meaning: "Nobody is messaged within 24 hours of an order.",
      },
      {
        term: "Already received",
        aka: ["already_received_campaign"],
        meaning: "A customer gets the same campaign at most once in 60 days (control-group customers count as 'received' so they stay clean).",
      },
    ],
  },
  {
    id: "campaigns",
    title: "Campaigns",
    intro:
      "A campaign is a rule that picks customers and a message to send them. Each customer gets at most one campaign per day — the one with the highest priority (Next best action).",
    terms: [
      {
        term: "Second Order",
        aka: ["SECOND_ORDER"],
        meaning: "Customers with exactly one order, 7–29 days after it. Encourages the second order — the biggest drop-off point.",
        example: "Ordered once 12 days ago → 'Ready for your next order?'",
      },
      {
        term: "15-Day Inactive",
        aka: ["INACTIVE_15"],
        meaning: "Customers in the At risk stage. Not used for one-order customers while Second Order is on.",
        example: "Usually every 7 days, 15 days since the last order → reminder.",
      },
      {
        term: "30-Day Win-back",
        aka: ["WINBACK_30", "Win-back"],
        meaning: "Customers in the Dormant stage. Its message contains an offer, so it only sends with a usable offer attached.",
      },
      {
        term: "60-Day Lost Customer",
        aka: ["LOST_60"],
        meaning: "Customers in the Lost stage, but only up to 180 days since their last order.",
      },
      {
        term: "VIP Protection",
        aka: ["VIP_PROTECTION", "VIP care"],
        meaning: "VIP customers who become At risk or Dormant. Highest priority after birthday/service messages. Needs an offer.",
      },
      {
        term: "Replenishment",
        aka: ["REPLENISHMENT", "Restock"],
        meaning:
          "Reminds an active customer that a usual item is due ('time to restock?'), naming up to 3 due products. Sent just before their next usual shop (from 70% of their usual gap, at least 2 days after any order), and only when item data covers their latest order.",
        example: "Buys potatoes every 10 days, skipped them in the last order, usually shops every 9 days → reminder around day 6–7.",
      },
      {
        term: "Buy Again",
        aka: ["BUY_AGAIN"],
        meaning: "At-risk customers with 2+ usual items get 'your favourites are waiting' with their own products. Replaces the generic 15-day message for them.",
      },
      {
        term: "Cross-sell",
        aka: ["CROSS_SELL"],
        meaning: "Active customers get one suggestion of a product often bought with something they buy regularly. Ranks below Replenishment.",
      },
      {
        term: "Promotion",
        aka: ["NEW_OFFER", "Image promotion"],
        meaning:
          "A product-image offer created on the Promotions page: image, Arabic + English text, valid-until date and audience (stage, price behaviour, store, VIP, orders, recency). Lowest priority, after lifecycle campaigns.",
      },
      {
        term: "Priority class",
        aka: ["SERVICE_RECOVERY", "BIRTHDAY", "ORDER_COMMUNICATION", "VIP", "WINBACK", "PERSONALIZED_OFFER", "GENERAL_PROMOTION"],
        meaning:
          "Decides which campaign wins when several fit the same customer, in this order: Service recovery → Birthday → Order communication → VIP → Win-back (15-day, 30-day, 60-day, Buy Again) → Personalised offer (Second Order, Replenishment, Cross-sell) → General promotion. Inside a class, the campaign's priority number decides (lower first). 'WINBACK' is a class name, not a campaign.",
        example: "An overdue VIP matches VIP Protection and 15-Day Inactive → VIP Protection is sent; the other shows 'lost to a higher-priority campaign'.",
      },
      {
        term: "Next best action",
        meaning: "The single campaign the engine would send a customer today, and why — after all rules and priorities. Shown on Customer 360.",
      },
    ],
  },
  {
    id: "running",
    title: "Running campaigns",
    terms: [
      {
        term: "Live switch",
        aka: ["On / Off"],
        meaning: "First safety step on the campaign table. On = may be made LIVE. Turning it Off stops that campaign immediately.",
      },
      {
        term: "Mode: DRY_RUN / LIVE",
        aka: ["Make LIVE", "Back to dry run"],
        meaning:
          "Second safety step (Step 3). DRY_RUN = never sends to customers. LIVE = real customers receive it on the next daily run. Make LIVE only works when the Live switch is On and template names are saved.",
      },
      {
        term: "Status",
        aka: ["DRAFT", "RUNNING", "PAUSED"],
        meaning: "DRAFT = not live; RUNNING = live and sending; PAUSED = stopped by you ('Pause all') or automatically.",
      },
      {
        term: "Dry run",
        meaning:
          "A simulation over all customers: how many each campaign matches, how many would be sent and why the rest wouldn't. Sends and saves nothing.",
      },
      {
        term: "Test mode",
        meaning: "Sends a campaign's template only to your internal test numbers — never to customers. Use it before going LIVE.",
      },
      {
        term: "Template",
        aka: ["Approved", "Pending", "Rejected", "_ar", "_en", "_bi", "Bilingual"],
        meaning:
          "A message pre-approved by Meta (WhatsApp only allows approved templates for marketing). Each campaign has an Arabic (_ar), English (_en) and bilingual (_bi, both languages with العربية / English buttons) version. Only APPROVED templates can be sent.",
      },
      {
        term: "Daily cap",
        meaning: "Maximum customer messages per day (100 by default, Step 3).",
      },
      {
        term: "Pacing",
        aka: ["60 s, 61 s, 62 s"],
        meaning: "Wait between messages, growing by 1 second each time: 60 s before the first, 61 s, 62 s … 100 messages take about 3 hours.",
      },
      {
        term: "Queue statuses",
        aka: ["SCHEDULED", "SENDING", "SENT", "FAILED", "CANCELLED", "SKIPPED"],
        meaning:
          "SCHEDULED = queued for today; SENDING = going out now; SENT = delivered to WhatsApp; FAILED = WhatsApp rejected it (reason shown); CANCELLED = no longer eligible when its turn came (e.g. ordered since, opted out, paused); SKIPPED = control group.",
      },
      {
        term: "Auto-pause",
        meaning: "All live campaigns pause automatically on a WhatsApp rate-limit or block error, or after 5 failures in a row. Check the failed rows before resuming.",
      },
      {
        term: "Step 0 — Opt-out & delivery tracking",
        aka: ["Webhook", "Check receiver"],
        meaning: "The listener that handles STOP / START / language replies and records delivered / read. Must be Enabled before any live campaign.",
      },
    ],
  },
  {
    id: "offers",
    title: "Offers & promotions",
    terms: [
      {
        term: "Offer",
        aka: ["Offer code"],
        meaning:
          "What Win-back and VIP messages promise: a code that already works at checkout, its type (free delivery, SAR off, % off) and wording. A campaign that mentions an offer cannot send without a usable one — there is no made-up default.",
        example: "WB20 — 'SAR 20 off with code WB20' / 'خصم 20 ريال بالكود WB20'.",
      },
      {
        term: "Validity",
        meaning: "An offer is valid N days after the message (7 by default), never past its end date. The message shows this date.",
      },
      {
        term: "Budget",
        aka: ["Discounts used"],
        meaning: "Maximum SAR of discounts for an offer, counted from orders attributed to its messages. When used up, the offer stops being sent.",
      },
      {
        term: "Offer eligibility",
        meaning: "Who may get an offer: price behaviour (default: not Full-price buyers), stores, segments.",
      },
      {
        term: "Valid until (promotion)",
        meaning: "The last day a promotion is sent and the date shown in its message.",
      },
    ],
  },
  {
    id: "results",
    title: "Results",
    intro: "Campaign results page. All rates are out of messages sent.",
    terms: [
      { term: "Sent", meaning: "Messages WhatsApp accepted." },
      { term: "Delivered", meaning: "Reached the customer's phone." },
      { term: "Read", meaning: "Opened (only when the customer has read receipts on)." },
      { term: "Replied", meaning: "The customer sent any message within 7 days of the campaign message." },
      {
        term: "Ordered / attributed order",
        aka: ["Ordered after message", "Revenue", "Attributed revenue"],
        meaning:
          "An order placed within 7 days after a message (the campaign's attribution window) is credited to that message — to the most recent one if there were several. Revenue = value of those orders.",
        example: "Message on Monday, order of SAR 165 on Thursday → 1 order, SAR 165 for that campaign.",
      },
      { term: "Revenue per message", aka: ["Rev / message"], meaning: "Attributed revenue ÷ messages sent." },
      {
        term: "Control group",
        aka: ["Holdout", "control group (not sent)"],
        meaning:
          "10% of the customers each campaign picks are deliberately NOT messaged (always the same customers for that campaign). They show what would have happened without the message.",
      },
      {
        term: "Lift",
        aka: ["Est. extra customers", "Control group ordered"],
        meaning:
          "Ordered rate of messaged customers minus the control group's ordered rate — the part the message actually caused. Marked * (early estimate) until there are at least 100 control and 300 messaged customers.",
        example: "12% of messaged customers ordered, 7.5% of the control group → lift +4.5 points; of 1,000 messaged ≈ 45 extra customers.",
      },
    ],
  },
  {
    id: "insights",
    title: "Customer Insights metrics",
    terms: [
      { term: "New customers (month)", meaning: "Customers whose first-ever order (in the data) was in that month." },
      { term: "Repeat customers (month)", meaning: "Customers who ordered that month and had ordered before." },
      { term: "Average basket", aka: ["AOV"], meaning: "Revenue ÷ orders." },
      { term: "Orders with a discount", meaning: "Share of orders (with discount data) that had a discount." },
      {
        term: "MTD / complete months",
        meaning: "MTD = month to date (the current, unfinished month). Month-on-month changes always compare two complete months.",
      },
      {
        term: "30-day return rate",
        aka: ["Why customers come back — or don't"],
        meaning: "Share of orders followed by another order from the same customer within 30 days, split by what happened on the order (discount, basket size, channel, store, missing items…).",
      },
      {
        term: "New → repeat (60 days)",
        meaning: "Share of new customers who placed a second order within 60 days of their first.",
      },
      {
        term: "Retention cohort",
        aka: ["M+1", "M+2"],
        meaning: "Of the customers whose first order was in a given month, the share who ordered again 1, 2, 3… months later.",
        example: "Jan cohort, M+3 = 19% → 19% of January's new customers ordered in April.",
      },
      {
        term: "Frequently bought together",
        aka: ["Likelihood vs chance", "Lift (pairs)"],
        meaning: "Product pairs found in the same basket more often than chance. 2.4× = 2.4 times more often than if they were unrelated.",
      },
      { term: "Department code", meaning: "The first 3 digits of the product category code (e.g. 006). Names need a code list." },
    ],
  },
  {
    id: "channels",
    title: "WhatsApp numbers & safety",
    terms: [
      {
        term: "WhatsApp app number",
        aka: ["Evolution", "Evolution API", "App number"],
        meaning:
          "A WhatsApp Business app number linked to WACRM by scanning a QR code (through your Evolution API server). No Meta fees and no 24-hour window, but WhatsApp can ban it for bulk or reported sending.",
      },
      {
        term: "Meta number",
        aka: ["Meta Cloud API", "Test number"],
        meaning: "The official WhatsApp Business Platform number. Used for template approval; sends approved templates with real buttons.",
      },
      {
        term: "Send through this number",
        aka: ["Default sender"],
        meaning:
          "Switch on Engagement → Channels. On = campaigns, broadcasts and new conversations go out from the WhatsApp app number. Replies always use the number the customer wrote to.",
      },
      {
        term: "Numbered options",
        meaning: "The app number cannot show buttons, so they become a numbered list. The customer answers with the number (1, ١, 1️⃣) or the words and WACRM treats it like a button tap.",
        example: "1️⃣ English  2️⃣ العربية → customer replies “2” → language set to Arabic.",
      },
      {
        term: "Warm-up",
        meaning: "A new app number may send only a few campaign messages a day at first: 20 (days 1–3), 40 (4–7), 70 (8–14), 100 (15–21), then the max per day.",
        example: "Day 5 of warm-up → at most 40 campaign messages today, even if the daily cap is 100.",
      },
      {
        term: "Sending hours",
        meaning: "Hours (Riyadh) when the app number may send campaigns and broadcasts. Default 10:00–21:00. Replies are always allowed.",
      },
      {
        term: "Auto-pause (number safety)",
        meaning:
          "Campaign sending through the app number stops by itself when: 4 of the last sends failed (numbers not on WhatsApp don't count), too many STOP replies today (5% with 20+ sent, or 10), or WhatsApp logged the number out or refused it. Resume on the Channels page.",
      },
      {
        term: "Still one tick",
        meaning: "Messages sent 2+ hours ago that never got a delivered tick. Many of them can mean recipients blocked the number or WhatsApp is limiting it — a warning, not a pause.",
      },
      {
        term: "Preview",
        meaning: "Campaigns → Step 3 → Preview: who the campaign would reach if it went live now, who is left out and why, how many days it takes at the daily limit, and the exact messages for a few real customers. Sends nothing.",
      },
      {
        term: "Audit log",
        meaning: "Engagement → Audit log: every change to campaigns, offers, contact rules, the app number and templates — who, what (old → new) and when. “system” = automatic changes.",
      },
    ],
  },
];
