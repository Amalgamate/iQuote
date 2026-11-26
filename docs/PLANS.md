# iQuote plans: what each includes and where to enforce it

**Status (25 Nov 2026):** `api/src/plans.ts` and its tests exist, and `index.ts` now enforces the
**monthly quote limit** (`POST /api/quotes`) and the **daily email cap** (`/send` and `/resend`), and
returns `entitlements` and `usage` from `GET /api/billing/status`. **Not yet compiled or run, and the
web app does not show limits or handle the new error yet.** Feature gates (M-Pesa collection, jobs,
reports, own email domain, templates, team size) are **not** enforced. Decisions confirmed by the
owner: invoices stay on every plan, and 30 quotes per month on Starter. Every limit is still a
starting hypothesis to validate in the pilot, not final commercial terms.

**Public pricing page (25 Nov 2026):** `MarketingSite.tsx` now shows prices and limits. It reads them
from a new public endpoint, `GET /api/public/plans` (prices from the admin price table or
`IQUOTE_PRICE_*`, limits from `plans.ts`), with fallback figures if the API is unreachable. Old
"local preview / simulated billing / (planned) / (coming soon)" wording was replaced with the real
flow: 14-day free trial with Growth features, no card, then pay monthly by M-Pesa. **Make sure NCBA
billing is live before the page is promoted**, because the copy now promises it. The page lists
Jobs, M-Pesa collection and reports under Growth, but those are not yet blocked on Starter in the
API, so Starter workspaces currently get them too.

Prices (set 25 Nov 2026): **Starter KES 800, Growth KES 1,500, Team KES 4,500** per month.

**Free-trial cap (owner decision, 26 Nov 2026):** a workspace whose subscription status is `TRIALING`
may create **7 quotes and 7 invoices in total** (not per month). Enforced in `POST /api/quotes`,
`POST /api/quotes/:id/revisions`, `POST /api/invoices` and `POST /api/jobs/:id/invoice-draft`
(403 with code `PLAN_LIMIT_CODE`).

**Revisions count as quotes (owner decision, 26 Nov 2026).** A revision creates a new `Quote` row, so
it consumes a trial quote slot, the same as a new quote. Invoices that already exist (idempotent
conversions) still do not count. Paying (status `ACTIVE`) removes the trial cap and applies the plan
limits instead, and the same "revisions count" rule applies to the monthly plan limit.

Usage is a **monotonic counter**, not a row count: `Subscription.trialQuotesUsed` and
`Subscription.trialInvoicesUsed`. A slot is claimed by `reserveTrialSlot` inside the same transaction
that creates the document, and the subscription row is locked with `SELECT ... FOR UPDATE`, so
concurrent creates cannot overrun the cap. Because the counters only increment, deleting a document
does **not** restore a slot. The migration `20261126120000_trial_usage_counters` backfills the
counters from existing rows for `TRIALING` workspaces.

The limits live in `TRIAL_LIMITS` in `plans.ts`, are returned by `GET /api/public/plans` and
`GET /api/billing/status`, and are shown on the pricing page. The workspace header shows a
"Quotes n/7 · Invoices n/7" chip while on trial. Sign-up may seed starter service items and quote
templates, but no sample quotes or invoices, so registration does not consume trial slots.

**Trial notices (added 26 Nov 2026).** Two emails go to the workspace owner, in addition to the
signup welcome email:

| Event | Trigger | Deduplication |
|---|---|---|
| Trial document cap reached | After a create returns 403 `PLAN_LIMIT_REACHED`, `notifyTrialCap` runs per kind (`quotes`, `invoices`) | A `Notification` row with `sourceKey` `trial-cap:<kind>:<orgId>` is written only after delivery succeeds; its presence suppresses future sends. Resend also receives a stable `Idempotency-Key` |
| Trial ended | `expireDueTrials()` sweep, every 15 min (plus once ~20s after boot) | The status change `TRIALING → EXPIRED` and the marker `trial-expired:<orgId>` commit in one transaction, so exactly one sweep sends |

The sweep exists because expiry is otherwise **lazy**: `refreshSubscriptionState` only flips a row to
`EXPIRED` when someone next touches the subscription, so an abandoned trial would stay `TRIALING`
forever and its owner would hear nothing. The sweep is safe to run on several API instances: the
conditional `updateMany` (still `TRIALING` and still due) decides the winner, and the marker rides in
the same transaction. `TRIAL_SWEEP_DISABLED=1` turns it off; `TRIAL_SWEEP_INTERVAL_MS` retunes it.

Cap notices are best-effort by design: the create has already rolled back when the email is sent, so
marking first and sending second could record a notice that never went out. The order is therefore
send, then mark. A Resend failure means the owner is not emailed for that event, and the next
attempt tries again.

## Why these lines

- **Starter must be enough to win a first customer** (quote, send, approve, invoice) but have a real ceiling, so a growing business hits it.
- **Growth sells the money tools**: M-Pesa collection from customers, jobs, reports. That is where iQuote beats generic invoicing apps in Kenya.
- **Team sells people and brand**: more users and a sender domain of the business's own.
- Market anchors: Zoho Books Kenya starts near KSh 849 with a free tier that includes basic invoicing; Quotient is about $28 to $48; Jobber from about $39. Starter at 800 sits at the Zoho entry price, so it needs a clear reason to choose iQuote (speed, M-Pesa, WhatsApp-friendly sharing).

## The matrix

| | Starter (800) | Growth (1,500) | Team (4,500) |
|---|---|---|---|
| New quotes per month | 30 | 500 | 2,000 |
| Users (including owner) | 1 | 2 | 5 |
| Quote emails per 24 hours | 25 | 100 | 300 |
| PDF templates (owner decision 27 Nov 2026) | Modern, Classic | + Minimal, Compact | + Bold (all 5) |
| Brand colour, logo, KRA PIN, address | Yes | Yes | Yes |
| Customers, catalogue, quote templates | Yes | Yes | Yes |
| Public approve / decline, chat | Yes | Yes | Yes |
| Invoices (record payments manually) | Yes | Yes | Yes |
| Jobs and milestones | No | Yes | Yes |
| Customer M-Pesa STK collection | No | Yes | Yes |
| Reports | No | Yes | Yes |
| Team roles (owner / admin / member) | No (1 user) | Yes | Yes |
| Own email domain and Resend key | No | No | Yes |
| Support | Email | Email | Priority |

Rules that keep this fair and simple:
1. **Trials get Growth** (`TRIALING` maps to Growth) so new users experience the money features, then choose a plan.
2. **Never hold data hostage.** Limits only block **creating** new things. Existing quotes, invoices, jobs and exports stay readable and downloadable on any plan.
3. **Revisions count** as quotes (owner decision, 26 Nov 2026). A revision is a new `Quote` row and consumes a slot, on both the trial cap and the monthly plan limit, so a workspace cannot revise its way around a limit. Idempotent invoice conversions of an existing invoice still do not count.
4. **Use 403 with a code**, not 402. `402` is already used for "subscription ended, workspace locked", and the web app may treat it as a full lock.
5. Show limits **before** users hit them (a "12 of 30 quotes used" meter), and always name the plan that unlocks the thing.

## Where the code can enforce each rule

Confirmed routes were read in `api/src/index.ts` lines 1 to about 2,700. Routes marked **unread** I have not seen; search for the path to locate the handler.

| Rule | Route / place | Check | Route read? |
|---|---|---|---|
| Quotes per month | `POST /api/quotes` | count quotes with `parentQuoteId: null` and `createdAt >= startOfMonthEAT()` | Yes |
| Emails per 24h | `POST /api/quotes/:id/send`, `/resend` | count `quoteDelivery` rows in the last 24h for this organisation (needs the relation to the quote; confirm the field name in `schema.prisma`) | Yes |
| Own email domain | `PUT /api/settings/email` when `provider === 'CUSTOM'`; the two `/domain` routes | `featureAllowed(ent, 'customEmailDomain')` | Yes |
| Customer M-Pesa | `PUT /api/settings/payments` when enabling; the invoice STK initiation route | `featureAllowed(ent, 'customerMpesa')` | Settings: yes. STK initiation: **unread** |
| Template choice | the organisation update handler that will save `documentTemplate` | `templateAllowed(ent, template)` | Handler to be added with the template patch |
| Team size | team invitation routes | active users plus pending invites versus `teamMembers` | **Unread** |
| Jobs | all `/api/jobs*` routes | `featureAllowed(ent, 'jobs')` on create | **Unread** |
| Reports | `/api/reports*` | `featureAllowed(ent, 'reports')` | **Unread** |
| Show locks in the UI | `GET /api/billing/status` | add `entitlements` to the response; web shows meters and upgrade prompts | Yes |

## Wiring pattern (index.ts)

`index.ts` imports local files with a `.js` extension.

```ts
import {
  entitlementsFor, featureAllowed, featureUnavailableMessage, limitReachedMessage,
  quotaState, startOfMonthEAT, PLAN_FEATURE_CODE, PLAN_LIMIT_CODE,
} from './plans.js'

async function getEntitlements(organisationId: string) {
  const subscription = await refreshSubscriptionState(organisationId)
  return entitlementsFor(subscription?.plan, subscription?.status)
}
```

Quote limit, inside `POST /api/quotes` after the organisation and customer checks:

```ts
const ent = await getEntitlements(organisation.id)
const used = await prisma.quote.count({
  where: { organisationId: organisation.id, parentQuoteId: null, createdAt: { gte: startOfMonthEAT() } },
})
if (!quotaState(used, ent.quotesPerMonth).allowed) {
  return res.status(403).json({ message: limitReachedMessage('quotes', ent.quotesPerMonth), code: PLAN_LIMIT_CODE })
}
```

Feature gate, for example in `PUT /api/settings/payments` when `requestedEnabled` is true:

```ts
const ent = await getEntitlements(organisationId)
if (requestedEnabled && !featureAllowed(ent, 'customerMpesa')) {
  return res.status(403).json({ message: featureUnavailableMessage('customerMpesa', 'Collecting payments by M-Pesa'), code: PLAN_FEATURE_CODE })
}
```

## Suggested order of work

1. Add `entitlements` and usage counts (quotes this month) to `GET /api/billing/status`, and show a small meter in the app. This changes nothing for users but makes limits visible.
2. Enforce the **quote limit** and **email cap** (also closes the send-abuse finding).
3. Enforce feature gates for M-Pesa collection, custom email domain and templates.
4. Read the jobs, reports and team routes, then gate them.
5. Update the public pricing page to match the matrix (I have not seen what it currently says).

## Open decisions for you

- **Are the numbers right?** 30 quotes on Starter is deliberately tight. Ask pilot users how many quotes they really send per month before fixing it.
- **Invoices on Starter:** useful for competing with free tools, but invoices raise the eTIMS question. If you hold off on eTIMS, consider calling them "payment requests" until that decision is made.
- **Trial on Growth:** good for conversion, but trial users who then pick Starter will lose Jobs, M-Pesa collection and reports. Tell them what changes before the trial ends.
- **Annual discount** (for example two months free) would reduce monthly STK churn, since subscription payments are manual each month.
- **Fee alternative:** instead of locking M-Pesa collection to Growth, you could allow it on every plan with a small per-transaction fee, if NCBA terms allow.
