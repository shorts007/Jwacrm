# LuLu WhatsApp message templates (EN + AR)

Submit each one in **Meta Business Manager → WhatsApp Manager → Message templates**, one template **per language**.
Category: **Marketing** for all of them. Variables are positional: `{{1}}` = customer first name, `{{2}}` = offer, `{{3}}` = expiry date.
The app fills them in (name falls back to "there" / "عزيزنا العميل"; expiry is formatted per language, e.g. `12 Oct 2026` / `12 أكتوبر 2026`).

> Brand name is written as **LuLu Online** / **لولو أونلاين**. Change it everywhere if the customer-facing brand differs.
> Order history in the data starts June 2026, so no copy claims "your first order".

**Footer (all templates):** EN `Reply STOP to opt out` · AR `للإلغاء أرسل STOP`
**Buttons (recommended):** URL button **Shop now / تسوّق الآن** → a *static* link (no variable) to your shop, plus a quick-reply button **Stop messages / إيقاف الرسائل**.
Static buttons need no extra parameters when sending.

Template names must be lowercase letters, digits and underscores. The app's suggested names are shown; change them in the campaign's Test mode panel if yours differ.

---

## 1. 15-day inactive — `lulu_inactive_15_en` / `lulu_inactive_15_ar`
Variables: `{{1}}` name — samples: `Ahmed` / `أحمد`

**EN**
> Hi {{1}}, it has been a little while since your last LuLu Online order. Your favourite groceries are just a few taps away, delivered to your door. Ready to order again?

**AR**
> مرحباً {{1}}، مرّ وقت منذ آخر طلب لك من لولو أونلاين. منتجاتك المفضلة على بعد نقرات قليلة وتصلك حتى باب بيتك. هل أنت مستعد لطلب جديد؟

## 2. 30-day win-back — `lulu_winback_30_en` / `lulu_winback_30_ar`
Variables: `{{1}}` name, `{{2}}` offer, `{{3}}` expiry — samples: `Ahmed`, `free delivery`, `12 Oct 2026` / `أحمد`, `توصيل مجاني`, `12 أكتوبر 2026`

**EN**
> Hi {{1}}, we miss you at LuLu Online! Come back and enjoy {{2}} on your next order. This offer is valid until {{3}}. See you soon!

**AR**
> مرحباً {{1}}، اشتقنا لك في لولو أونلاين! عُد إلينا واستمتع بـ {{2}} على طلبك القادم. العرض ساري حتى {{3}}. بانتظارك!

## 3. 60-day lost customer — `lulu_lost_60_en` / `lulu_lost_60_ar`
Variables: `{{1}}` name

**EN**
> Hi {{1}}, it has been a while! There is a lot that is new at LuLu Online, from fresh produce to weekly offers. Come and see what you have been missing.

**AR**
> مرحباً {{1}}، طال غيابك! هناك الكثير من الجديد في لولو أونلاين، من الخضار والفواكه الطازجة إلى العروض الأسبوعية. تفضّل لترى ما فاتك.

## 4. Second order — `lulu_second_order_en` / `lulu_second_order_ar`
Variables: `{{1}}` name

**EN**
> Hi {{1}}, thank you for shopping with LuLu Online! Ready for your next order? Your groceries are only a few taps away.

**AR**
> مرحباً {{1}}، شكراً لتسوقك من لولو أونلاين! هل أنت مستعد لطلبك القادم؟ مستلزماتك على بعد نقرات قليلة.

## 5. VIP care — `lulu_vip_care_en` / `lulu_vip_care_ar`
Variables: `{{1}}` name, `{{2}}` offer — samples: `Ahmed`, `free delivery` / `أحمد`, `توصيل مجاني`

**EN**
> Hi {{1}}, you are one of our most valued customers and we have missed you. Enjoy {{2}} on your next order as our way of saying thank you.

**AR**
> مرحباً {{1}}، أنت من عملائنا المميزين ونفتقدك كثيراً. استمتع بـ {{2}} على طلبك القادم كتقدير منّا لك.

---

## Later campaigns (drafted now, not built yet)

### Thank you — `lulu_thank_you_en` / `lulu_thank_you_ar`  · `{{1}}` name
**EN** > Hi {{1}}, thank you for shopping with LuLu Online. We truly appreciate your continued support and look forward to serving you again.
**AR** > مرحباً {{1}}، شكراً لتسوقك من لولو أونلاين. نقدّر دعمك المستمر ونتطلع لخدمتك مجدداً.
*(Meta may reclassify a thank-you as Utility if it references a specific order.)*

### Birthday — `lulu_birthday_en` / `lulu_birthday_ar` · `{{1}}` name, `{{2}}` offer, `{{3}}` expiry
**EN** > Happy birthday {{1}}! 🎉 Everyone at LuLu Online wishes you a wonderful day. Enjoy {{2}} on your next order, valid until {{3}}.
**AR** > عيد ميلاد سعيد يا {{1}}! 🎉 يتمنى لك فريق لولو أونلاين يوماً رائعاً. استمتع بـ {{2}} على طلبك القادم، ساري حتى {{3}}.
*(Needs a birthday field — not in the current BigQuery tables.)*

---

## Meta rules that commonly cause rejection
- Every variable needs a **sample value** when you submit.
- Variables must be numbered in order ({{1}}, {{2}}, …) and **cannot start or end the body**; no two variables side by side.
- Keep each message short relative to its variable count; avoid ALL-CAPS and unverifiable claims.
- Variable *values* sent later cannot contain new lines, tabs, or 4+ consecutive spaces (the app cleans them).
- Approval usually takes minutes to a day. Marketing templates are charged per delivered message and a poor quality rating can limit your sending.

## Opt-out is a hard gate before any customer send
The footer promises that replying STOP unsubscribes. Handling that reply (STOP / stop / ايقاف / إيقاف / الغاء / إلغاء → mark the customer opted out, tag it, never message again) must be live **before** the first customer campaign. It is the next build step after test mode.
