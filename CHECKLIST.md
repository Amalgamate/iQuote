# iQuote — build checklist

Living plan. Checkboxes are marked when each stage is actually done (code exists and the exit criteria pass). Do not tick ahead.

**Product:** iQuote  
**Type:** Self-serve SaaS. Anyone registers, sets up their business, sends quotations.  
**Not in v1:** print-shop costing, jobs, invoices, eTIMS, M-Pesa, Impress storefront.

---

## Locked decisions

| Decision | Choice |
| --- | --- |
| Audience | Any small business that sends quotes |
| Onboarding | Self-register. No admin invite. |
| v1 loop | Register → business profile → customer → quote → PDF → share link → approve/decline |
| Industry packs | Later (print, construction, services). v1 lines are description, qty, unit, price, tax. |
| Currency | Business chooses. Default KES. |
| Tax | One default rate, optional per line. Kenya 16% is a preset, not hardcoded. |
| Stack | Vite + React + TypeScript + Tailwind + shadcn. Express + Prisma + PostgreSQL. |
| Design | Inter, light, tables, 6px radius, one accent, no gradients. See `DESIGN.md`. |
| Tenancy | One Organisation per signup. Owner is the registering user. |
| Print / Impress | Out of this repo. Add as an industry pack later. |

---

## Stage 0 — Plan

- [x] Product cut agreed: generic iQuote, not Impress admin
- [x] This checklist created
- [x] DESIGN.md written for iQuote

**Exit:** Founder can read this file and know what ships in v1.

---

## Stage 1 — Foundation

- [x] `web/` Vite React TypeScript app runs
- [x] `api/` Express TypeScript app runs
- [x] Local PostgreSQL service runs and accepts the app connection (Docker is optional)
- [x] Prisma schema: Organisation, User, Session, Customer, Quote, QuoteLine, QuoteSequence
- [x] `.env.example` documented
- [x] README with how to start

**Exit:** `npm run dev` in both apps; health endpoint returns ok.

---

## Stage 2 — Design shell

- [x] Tokens from DESIGN.md in CSS
- [x] Public marketing/auth layout (minimal)
- [x] App shell: sidebar, top bar, content
- [x] Empty dashboard placeholder and first-use empty states

**Exit:** Logged-out and logged-in layouts look like the design system (even if pages are empty).

---

## Stage 3 — Self-serve accounts

- [x] Register: name, email, password
- [x] Login
- [x] Logout
- [x] JWT/httpOnly cookie session
- [x] Protected `/app` routes

**Exit:** A new person can create an account and reach an empty app.

---

## Stage 4 — Business onboarding

- [x] First login wizard if organisation incomplete
- [x] Business name, email, phone, country
- [x] Currency, default tax rate, quote prefix
- [x] Skip-none: name + currency required

**Exit:** After signup, user cannot create quotes until business name is saved.

---

## Stage 5 — Customers

- [x] Customer list (table)
- [x] Create / edit (name + phone or email)
- [x] Empty state
- [x] Search

**Exit:** Owner can add three customers without training.

---

## Stage 6 — Quotes (core)

- [x] Quote list with status
- [x] New quote: pick/create customer
- [x] Generic line items: description, qty, unit, unit price, tax
- [x] Totals: subtotal, tax, total
- [x] Autosave draft
- [x] Statuses: Draft, Sent, Viewed, Approved, Declined, Expired
- [x] Document number `QT-YYYY-0001`

**Exit:** A quote can be created and totals are correct to 2 decimals.

---

## Stage 7 — Document preview and PDF

- [x] Live A4 preview on desktop
- [x] Mobile preview sheet
- [x] Print / Save as PDF from the browser
- [x] Business name + logo placeholder on document

**Exit:** PDF matches on-screen preview and prints on one page for a short quote.

---

## Stage 8 — Share and customer decision

- [x] Public link, no login
- [x] Customer views quote
- [x] Approve / decline + optional comment
- [x] Copy link and WhatsApp share text
- [x] Viewed timestamp

**Exit:** Second browser, logged out, can approve a quote.

---

## Stage 9 — Polish v1

- [x] Settings: logo, payment instructions, terms
- [x] Direct logo file upload (drag-and-drop in Settings)
- [ ] Send verification and welcome email through Resend when configured (local development simulation otherwise)
- [x] Empty states and validation
- [x] Basic mobile layout
- [x] Superadmin role, login, and platform dashboard

**Exit:** v1 loop is usable on a phone for viewing; creating quotes is good on desktop.

---

## Stage 10 — SaaS onboarding preview

- [x] Multi-step marketing, account, verification, business, and plan selection pages
- [x] Store signup verification codes as keyed hashes with expiration, resend throttling, and attempt limits
- [x] Create each new Organisation and its 14-day simulated Subscription in one transaction
- [x] Scope customer and quote workspace access by Organisation
- [x] Send verification and getting-started emails through Resend when configured
- [ ] Configure a verified Resend sender and confirm delivery
- [ ] Connect payment checkout and lifecycle webhooks
- [ ] Add team invitation and membership management
- [ ] Run an end-to-end onboarding and tenant-isolation walkthrough

**Exit:** A verified new signup creates an isolated business workspace and trial; configured email delivery works; billing remains explicitly simulated until checkout is connected.

---

## Later (do not start)

- [ ] Industry packs (print sizes, construction BOQ, retainers)
- [ ] Team invites
- [ ] Invoices and payments
- [ ] Jobs / production
- [ ] M-Pesa / eTIMS
- [ ] Impress Print catalogue import

---

## How this list gets marked

After each stage, the agent:

1. Runs the exit criteria.
2. Changes `- [ ]` to `- [x]` for that stage only.
3. Updates `progress.json` (`currentStage`, `updatedAt`).
4. Stops and reports what to try, unless you say continue.

Do not skip stages. Do not mark a stage done because files were created if the exit criteria failed.
