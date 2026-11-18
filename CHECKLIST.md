# iQuote — delivery plan and auto-mark checklist

Living implementation plan for evolving the existing iQuote application. Keep the current React/Express/Prisma/PostgreSQL product as the source of truth; extend it in place and do not start a rewrite.

**Plan basis:** repository audits dated 18 November 2026 (`docs/audit/`), current `README.md`, existing `CHECKLIST.md`, and `progress.json`.
**Current tracker state:** stages 0–6 recorded complete; stage 7 is next. Existing UI/API features may be present while their acceptance evidence is still outstanding.
**How completion is recorded:** finish every checkbox and the stage exit checks, then run `node scripts/mark-stage.mjs <stage> --verified "evidence summary"`. The marker requires the active stage and an evidence summary; it records completion but does not run tests. Never use it to predict or pre-mark work.

## Product direction and guardrails

- Core loop: register → configure business → add customer → create quote → download/share → customer approves or declines.
- Evolve toward a small-business commerce platform: quote → opportunity discovery → accepted work → delivery and financial records.
- Pilot a narrow marketplace only after current tenant security and quote reliability are proven. Validate real buyer demand and provider participation before investing in paid access or broad marketplace automation.
- Keep the modular monolith and reuse organisations, users, catalogue, quotation, document, and admin foundations where they fit.
- Do not treat simulated subscriptions as payment collection, a sent/share link as email delivery, a TypeScript build as behavioral proof, or source configuration as verified production state.
- No production migration, payment, or live customer-data operation is implied by this plan; those require explicit operational preparation and backups.

## What product completion means

For this plan, “complete” means the following release outcome, not that iQuote will never need new work:

- **Reliable core:** a business can register, verify email, configure its workspace, manage customers/catalogue, create accurate versioned quotes, send a PDF and review link, and see delivery and customer decisions.
- **Safe SaaS operations:** tenant boundaries and admin access are tested; database changes are versioned; deployment is health-gated; backups can be restored; production email and billing states are real and observable.
- **Validated marketplace:** a narrow customer RFQ-to-provider proposal flow has passed a demand/supply pilot, with private bids, moderation, and auditable selection. If the evidence says STOP, completion means the marketplace is deliberately not shipped and the product direction is revised.
- **Work lifecycle:** accepted quotes can become tracked jobs; costs and payment events reconcile with an audit trail; reports respect tenant and currency boundaries.
- **Commercial operations:** paid plans/credits are backed by a provider and evidence, team access is permissioned, and support, monitoring, retention, and recovery procedures are usable.

This is completion of the staged iQuote business platform described here. It does not include unlimited industry verticals, enterprise procurement, full accounting/ERP, or guaranteed marketplace liquidity across Kenya; those need separate scope and validation.

## Expected schedule (planning estimate, not a commitment)

**Estimate date:** 18 November 2026. The audit documents relative effort rather than calendar duration, so the ranges below are a first planning baseline, not a measured delivery forecast.

**Working assumption:** one experienced full-time product engineer, founder decisions and user access available each week, existing code and environments usable, and no major vendor/production access delays. Part-time engineering, new hiring, or slow customer recruitment will extend the calendar.

| Milestone | Included stages | Rough elapsed effort | Indicative timing from 18 Nov 2026 |
|---|---:|---:|---|
| Reliable, secure quotation product with verified email and release/recovery basics | 7–11 | 11–20 weeks | Feb–Apr 2027 |
| Evidence-based marketplace decision and narrow pilot | 12–13 | 7–14 weeks after core work; discovery can overlap earlier stages | Apr–Aug 2027 |
| Jobs, costs, payment records, commercial plans, team access, and operating controls | 14–15 | 14–24 additional weeks | Aug 2027–Feb 2028 |
| **Full staged completion target** | **7–15** | **about 32–58 weeks (8–14 months)** | **July 2027–January 2028** |

Ranges are broad because Stage 12 depends on buyer/provider participation and Stage 14–15 needs product/accounting decisions and external provider setup. A STOP decision at Stage 12 can shorten the software scope substantially; a weak demand signal should not trigger marketplace build work just to meet a date. Production database reconciliation, sender-domain verification, payment-provider approval, and customer recruitment can add calendar waiting time even when engineering is ready.

### Near-term planning checkpoints

- **By 2 December 2026:** complete Stage 7 workflow verification or have a written defect list and revised estimate.
- **By 6 January 2027:** target completion of the critical security/migration/CI foundation in Stages 8–9, subject to migration rehearsal and environment access.
- **By 17 March 2027:** target a reliable core quotation and email milestone (Stages 7–11), if no critical production or deliverability blockers emerge.
- **By 30 June 2027:** target a documented marketplace GO/NARROW/STOP decision and, only if justified, a controlled pilot plan or first pilot release.
- **By 31 January 2028:** planning target for Stages 14–15 and full staged completion, conditional on marketplace evidence and billing/job-accounting decisions.

Reforecast after Stage 7 and again after Stage 9 using actual throughput, defects, and access delays. Do not mark completion to meet a date; the stage exit checks remain the acceptance criteria.

## Current implementation snapshot

The audits report a React/Vite/TypeScript web app, Express API, Prisma/PostgreSQL schema, self-registration and OTP foundations, business workspaces, customer and service catalogues, quote creation and public decisions, PDF generation, Resend integration points, super-admin dashboard, and simulated 14-day trials. Automated test coverage and live production behavior were not established by the audits. Review `progress.json` and the feature matrix before changing completion claims.

## Stage 7 — Verify the delivered quotation workflow

- [ ] Run the documented local setup from a clean checkout and confirm web, API, database connection, and health endpoint.
- [ ] Walk through registration, verification, business setup, customer creation, quote creation, draft persistence, and quote numbering.
- [ ] Verify subtotal, tax, total, currency formatting, and rounding for representative quantities, rates, and boundary values.
- [ ] Open a public quote in a logged-out browser; verify view timestamp, approve, decline, optional comment, expiry, and repeat-decision behavior.
- [ ] Compare HTML preview, downloaded PDF, and print output for short and long quotes, page breaks, logo, and mobile customer view.
- [ ] Verify service catalogue, templates, settings, logo upload, and super-admin dashboard paths without assuming that source presence proves the user flow.
- [ ] Record reproducible defects and environment assumptions in the stage notes before beginning feature expansion.

**Exit checks:** the existing core loop works end to end in a clean local environment; quote math and document output have reviewed acceptance evidence; defects are recorded. Fix blocking defects before marking complete.

## Stage 8 — Close critical security and tenant-isolation gaps

- [ ] Replace reflected credentialed CORS with explicit trusted-origin configuration, including a documented policy for tenant subdomains.
- [ ] Protect cookie-authenticated writes with a deliberate CSRF strategy and reject untrusted origins; cover sibling-subdomain and unrelated-origin cases.
- [ ] Remove the known JWT fallback; fail startup in production if the configured signing secret is absent or weak. Document secret rotation.
- [ ] Reject SVG uploads or sanitize/rasterize them; serve permitted user media safely and verify MIME/content handling and size limits.
- [ ] Review schema-level tenant constraints needed for quote/customer/owner consistency; implement only after the Stage 9 migration baseline is established.
- [ ] Review every tenant route and super-admin route for identity derived from the authenticated session, scoped queries, and deliberate elevated access.
- [ ] Replace raw bearer JWTs stored in Session rows with hashed opaque session tokens; plan expiry, revocation, and safe migration/rotation of existing sessions.
- [ ] Require stronger authentication for super-admins (MFA or equivalent), and test privileged-session revocation.
- [ ] Move login/OTP throttles to shared storage; add budgets for public quote endpoints, request-size limits, and correct proxy trust settings.
- [ ] Disable email-template preview in production or require authorized access.
- [ ] Add negative tests proving one tenant cannot read, mutate, infer, or attach another tenant's customers, quotes, services, templates, or uploads.
- [ ] Add focused tests for authentication/session revocation, OTP expiry/attempt limits, quote decisions, role boundaries, and upload rejection.

**Exit checks:** high-risk security findings are fixed or explicitly risk-accepted; automated negative tenant tests pass; production startup cannot use a known secret; upload policy is safe and documented.

## Stage 9 — Establish safe database, CI, deploy, and recovery practices

- [ ] Before baselining, take a verified backup of the target database and inspect/reconcile its schema against the checked-in Prisma schema; document drift and environment assumptions without exposing customer data or secrets.
- [ ] Choose and document the initial Prisma migration baseline/reconciliation procedure for the existing database; rehearse it against a non-production copy first.
- [ ] Create reviewed Prisma migration history; stop using `prisma db push` as the production schema-deployment mechanism.
- [ ] Define migration rollout and recovery steps, including pre-deploy backup, compatibility window, and response to a failed migration.
- [ ] Implement the reviewed composite tenant-consistency constraints and any nullable legacy customer cleanup through migrations; add rollback/recovery notes.
- [ ] Add CI for API/web type checks, lint, automated tests, and production builds; protect secrets from untrusted pull-request jobs.
- [ ] Correct the deployment health-check path and make deployment fail when the application does not become healthy.
- [ ] Verify TLS termination, redirects, tenant wildcard certificate state, and security headers at the actual public edge.
- [ ] Write backup and restore procedures covering PostgreSQL and uploaded media together; define retention and recovery objectives.
- [ ] Perform and record a restore rehearsal in a non-production environment.
- [ ] Add an operational release checklist and a way to identify the deployed commit/build.

**Exit checks:** schema changes are versioned and reviewable; CI gates a release; deployment health is enforced; a database-plus-upload restore has been rehearsed.

## Stage 10 — Make the existing customer and quotation workflow scale safely

- [ ] Define stable pagination, filtering, sorting, and search contracts for customer and quote lists.
- [ ] Implement tenant-scoped server-side pagination/search and matching UI states; add indexes based on query patterns.
- [ ] Add customer archive/history while preserving quote references; define duplicate detection and recovery behavior.
- [ ] Decide sent-quote immutability and revision semantics; preserve the exact version the customer reviewed or approved.
- [ ] Add quote duplication and revision actions that do not silently alter a previously sent document.
- [ ] Define decimal precision, rounding, tax-before/after-discount policy, and currency behavior; use deterministic decimal arithmetic end to end.
- [ ] Add line/document discounts only after calculation policy is approved and represented in tests and stored quote snapshots.
- [ ] Add typed API request validation and consistent client-safe error responses.
- [ ] Separate quote content templates from visual document templates; implement template editing only with versioned compatibility rules.
- [ ] Research and validate target vertical requirements before adding specialized starter packs (initial candidates: printing, branding, signage, fabrication).
- [ ] Add regression coverage for pagination boundaries, tenant filters, concurrent quote numbering, totals, revisions, and document snapshots.

**Exit checks:** growing workspaces do not require loading all records; quote revisions preserve customer-visible history; financial rules are deterministic and tested; templates and list behaviors are documented.

## Stage 11 — Deliver quotes by email and make delivery observable

- [ ] Configure a verified platform Resend sender in the target environment and verify OTP/welcome delivery using a controlled test account.
- [ ] Design an explicit Send Quote flow with recipient confirmation, message preview, public review link, and generated PDF attachment.
- [ ] Keep the current share-link action distinct from email sending and make status labels describe what actually happened.
- [ ] Add persisted delivery attempts/results, provider message IDs, timestamps, safe error summaries, and a tenant-visible delivery status.
- [ ] Add idempotent retry/resend behavior and prevent duplicate or ambiguous send outcomes.
- [ ] Verify platform-versus-tenant sender selection, tenant key encryption/decryption, sender/domain verification, and failure behavior without exposing credentials.
- [ ] Verify Resend webhook signatures and replay protection; process delivered, bounced, complained, and provider-domain events.
- [ ] Move provider calls to a retryable queue/worker when measured latency/reliability warrants it; define dead-letter and alert handling.
- [ ] Add token revoke/replace behavior for superseded or compromised quote links.
- [ ] Consider a request-changes decision state and customer notification only after its business semantics are defined.
- [ ] Verify PDF attachments and rendering for long quotes, supported logos, currencies, and common mail clients.

**Exit checks:** a business can send an immutable quote version with a PDF and link; delivery state and retry behavior are visible; provider failures are diagnosable; verified sender behavior is demonstrated in the intended environment.

## Stage 12 — Validate marketplace demand and set a go/no-go gate

- [ ] Conduct buyer/provider interviews and document the first opportunity category, geography, and supply constraints.
- [ ] Test manual concierge matching before building marketplace software; record genuine RFQs, qualified provider responses, buyer selections, and repeat intent.
- [ ] Define success and stop thresholds with the founder before the pilot (for example: completed RFQs, qualified response rate, selection rate, response time, repeat intent, and provider willingness to pay).
- [ ] Document customer, provider, and platform-admin journeys plus privacy rules for private invitations and bids.
- [ ] Validate how existing iQuote owner accounts and business workspaces can serve a small invite-only pilot; do not require paid subscriptions or team memberships to test demand.
- [ ] Record a written GO, NARROW, or STOP decision against the pre-agreed thresholds.
- [ ] If the decision is STOP, leave Stage 13 unstarted and revise the product direction based on evidence. If NARROW, record the reduced category/geography and repeat criteria.

**Exit checks:** a manual concierge pilot has produced recorded evidence against founder-approved thresholds, and a clear GO/NARROW/STOP decision is documented. Stage 13 implementation may begin only after GO or a specific NARROW decision.

## Stage 13 — Build a narrow iQuote Market pilot (only after Stage 12 GO/NARROW)

- [ ] Confirm the approved pilot category, geography, user cohort, and scope from the Stage 12 decision; do not silently broaden it.
- [ ] Define marketplace organization profile, service categories, coverage areas, capacity, verification, and moderation requirements for that cohort.
- [ ] Specify RFQ fields, attachments, deadlines, eligibility, invitation visibility, proposal submission, withdrawal, and revision rules.
- [ ] Design matching as explainable eligibility filters first; document ranking signals, fairness checks, and manual override.
- [ ] Add tenant-scoped RFQ, invitation, and marketplace proposal schema with audit history through versioned migrations.
- [ ] Reuse quote/document infrastructure only where marketplace proposals have compatible terms and lifecycle; keep proposal and ordinary quote semantics explicit.
- [ ] Implement customer RFQ creation and status tracking with clear privacy and consent.
- [ ] Implement provider onboarding/profile completion and invitation inbox for the pilot cohort; keep team membership and billing out unless the pilot requires them.
- [ ] Implement private invitations and proposal submission; ensure providers cannot view competing bids.
- [ ] Allow buyer selection/decline and convert only the selected proposal into an auditable ordinary quote/workflow. Defer job conversion to Stage 14.
- [ ] Add abuse reporting, moderation, provider verification controls, rate limits, retention rules, and marketplace audit views.
- [ ] Pilot with the approved small cohort; measure the Stage 12 thresholds, repeat use, support burden, and provider willingness to pay.
- [ ] Decide to continue, narrow, or stop based on evidence before adding premium access or credits.

**Exit checks:** the controlled software pilot preserves tenant privacy and bid confidentiality, and measured results meet the pre-agreed continuation threshold or produce an explicit stop/narrow decision.

## Stage 14 — Connect accepted work to delivery and financial records

- [ ] Define the quote-to-job conversion point and preserve accepted quote/version/terms as an immutable snapshot.
- [ ] Model jobs, ownership, status history, milestones, due dates, attachments, and customer-visible progress.
- [ ] Validate one initial vertical's real production stages before making a generalized workflow engine.
- [ ] Add materials, labor, supplier, transport, and other cost records with actor, timestamp, currency, and audit trail.
- [ ] Define invoices, deposits, partial payments, allocations, receipts, refunds, and balances as explicit financial events.
- [ ] Select and integrate payment rails only after provider, reconciliation, refunds, and failure handling are designed.
- [ ] Ensure payments cannot be silently edited or double-counted; add idempotency and reconciliation workflows.
- [ ] Add estimated-versus-actual cost and margin reports with currency-aware aggregation.
- [ ] Add role authorization, tenant constraints, retention, export, and recovery tests for job and financial data.

**Exit checks:** an accepted quote can be delivered as tracked work; costs and payment events reconcile to an auditable history; reports respect currencies and access scope.

## Stage 15 — Expand commercial controls, integrations, reporting, and operations

- [ ] Decide plans, entitlements, trial terms, cancellation/grace behavior, and pricing using Stage 13 marketplace evidence.
- [ ] Select a payment provider for the target market; document fees, settlement, refunds, webhook support, and operational ownership.
- [ ] Add provider customer/subscription IDs and immutable billing event records through versioned migrations.
- [ ] Implement checkout and signed, replay-protected webhooks; make lifecycle handlers idempotent.
- [ ] Reconcile provider events against local subscription state, expose failures for support review, and enforce entitlements server-side.
- [ ] Add premium opportunity credits only if provider willingness-to-pay evidence supports them; record every grant, purchase, use, refund, and expiry as auditable events.
- [ ] Preserve explicit development/simulated mode that cannot be mistaken for paid status.
- [ ] Design team membership and invitations for multi-user organisations; define role permissions and workspace switching before implementation.
- [ ] Add invite expiry/revocation, acceptance flow, and authorization tests before enabling team access.
- [ ] Integrate WhatsApp Business Platform only with consent, approved templates, provider/webhook security, delivery status, and fallback behavior.
- [ ] Replace cross-currency platform totals with grouped currency reporting or an explicit, sourced conversion policy.
- [ ] Add tenant reports for quote funnel, repeat customers, revenue/receivables, and job profitability where underlying data is reliable.
- [ ] Add structured logs, error monitoring, alert thresholds, privacy-conscious tracing, support runbooks, and operational release reporting.
- [ ] Measure query plans, load behavior, PDF generation, and queue throughput before scaling infrastructure.
- [ ] Define retention, deletion/export, incident response, access reviews, and recurring restore exercises.
- [ ] Reassess shared services, storage, rate limiting, and tenant architecture against observed usage before splitting services.

**Exit checks:** any paid features are supported by observed demand and provider evidence; billing is auditable; reporting is currency-aware; integrations and operating capacity are observable and tested.

## Automatic progress workflow

1. Work on one stage at a time, in order. A later stage may be researched, but do not mark it complete while dependencies are open.
2. For every checkbox, require a code/config artifact and the relevant passing automated check or recorded manual acceptance evidence. A file existing is not sufficient.
3. Before marking, review the stage exit checks and inspect the diff/status for accidental or unrelated changes.
4. Run `node scripts/mark-stage.mjs <stage> --verified "evidence summary"` only after the stage is fully verified. The script requires the requested stage to equal `progress.json.currentStage`, requires an evidence summary, then marks that stage's checkboxes, appends the evidence to `notes`, and advances `currentStage` to the next stage. This is an evidence-attested marker, not automatic test discovery.
5. If any check fails, leave boxes open, record the failure and next action in `progress.json.notes`, and report the blocker. Do not claim completion.
6. `progress.json.currentStage` always means the next active stage; `completedStages` lists stages already marked complete. After a successful mark, confirm both tracker files changed, then summarize evidence and the next stage.

## Deferred until validated

- [ ] Market pricing, premium opportunity credits, and paid provider access (after Stage 13 pilot evidence).
- [ ] Advanced procurement/enterprise workflows (after marketplace repeatability).
- [ ] Broad industry packs (after customer discovery for each vertical).
- [ ] M-Pesa, eTIMS, inventory, and accounting integrations (after legal/accounting/provider requirements are established).
- [ ] Separate services or a platform rewrite (no current audit evidence justifies either).
