# Data findings (from diagnostics, Oct 2026)

| Finding | Evidence | Consequence |
|---|---|---|
| ~92k all-NULL rows in `ksa_jackpot` | no phone / number / email | Empty rows — ignored |
| Only status `delivered` | 197,633 orders, SAR 30.7M | Sales ≈ SAR 155 per order |
| Orders table starts 2026-06-30 | monthly counts | "First order" = first in the data, not truly first |
| Items table starts 2026-04-22 | `instaleap_raw` | Older item rows exist, but with no phone they can't be tied to customers |
| Shared / dummy phones | e.g. 1,268 orders on one phone, 796 names | Flagged via `suspect_reason`, excluded |
| **Item data covers only the western region** | match rate: Jeddah 92 %, Madinah 99.6 %, Tabuk 99 %, Taif 100 %; **Riyadh, Khobar, Dammam, Jubail, Dhahran, Al Ahsa ≈ 0 %** | Preferred store/category (and so replenishment, buy-again, cross-sell, category offers) only possible for western-region customers until an item source for Riyadh/Eastern exists |
| Job numbers `Lulu-<N>INP1/INP2/INP3/PRP1/PRP2` | shapes query | Regex strips prefix + suffix; handled |
| Feed freshness | newest order 103 h behind when checked | Re-check before every send (`data_as_of` gate) |

Orders ≈ Riyadh 57 %, Jeddah 15 %, Eastern Province ≈ 25 % of the last 30 days.

Decision (Oct 2026): phase 1 focuses on the **western province** — Riyadh/Eastern product data is not updated. `customer_master.sql` filters by `focus_cities`. Order history in BigQuery starts June 2026, so "first order" means first in the data; message copy for second-order / win-back must not claim "your first order".

## Update (Oct 2026): richer order table
`ksa_jackpot` now has `discount_amount`, `client_type` (ios / android / default) and `storeid`, and history goes back to **Feb 2025**
(so personal purchase cycles and "first order" are far more reliable than the June-only data we first saw).
- `amount` looks **net** of discount: discount ÷ (amount + discount) = exactly 20.0 % on three sample orders, 15.0 % on a fourth. Set `amount_is_net_of_discount` in the SQL if that is wrong.
- Store now comes from `storeid` on every order (no item-table join needed); names come from the item table's store labels.
- Phase 1 focus = **Jeddah** only; Riyadh / Dammam rows are not loaded yet.
- New per-customer insights: preferred store & channel, stores used, discount behaviour (Offer-driven / Mixed / Full-price).

## Duplicate orders disagree on store and city (Oct 2026)
81,414 order numbers appear more than once (97,982 extra rows). Copies agree on amount and phone (0 conflicts), but
**40,528 orders have conflicting `storeid`** and **7,087 have conflicting city**. After de-duplication Jeddah store 3810 (Al Marwa)
holds 26,726 orders and 3805 (Amir Fawaz) 20,274, versus 6,469 / 40,500 when duplicates were counted. All other stores are unchanged.
Spend, order counts, recency and frequency are NOT affected (amount and phone never conflict); store-based and city-based
features are, until diagnostics #22-#24 show which copy is right.

Confirmed by the business: when copies of an order disagree, **3810 (Al Marwa) is the correct store** and 3805 is a wrong default on some appended rows. `customer_master.sql` now prefers a copy whose store is not `unreliable_default_storeid` (3805). Verify with diagnostic #25.

## Store & city reconciliation (Oct 2026)
- City conflicts between copies are 'Jeddah' vs a Jeddah DISTRICT ('Al Bawadi', 'Al-Marwa', 'Al Safa', 'Aziziyah'…) plus a few 'Jeddah vs Yanbu / Makkah'. City is therefore not a reliable region key; the Jeddah focus is now defined by store.
- Diagnostic #25: after preferring non-3805 copies, store 3810 agrees with the picking system for only 76.4 % of 21,648 checked orders (all other stores 100 %), and 3805 does not appear at all. ~5,100 orders labelled 3810 were picked elsewhere — most likely 3805 (Amir Fawaz had ~5,160 picking jobs). The view now uses the picking-system store whenever it exists (`prefer_picking_store`).
- `many_orders` suspect rule now looks at the last 90 days (a household with 87 orders over 20 months was wrongly flagged).
