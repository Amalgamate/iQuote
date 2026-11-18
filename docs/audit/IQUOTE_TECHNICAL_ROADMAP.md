# iQuote Technical Roadmap

**Based on audit dated:** 18 November 2026  
**Approach:** retain the current React/Express/Prisma/PostgreSQL modular monolith. Sequence work around safe tenant data and the existing quote lifecycle. Complexity estimates are relative engineering effort, not calendar commitments.

## Phase 1 — Fix existing problems and stabilise the foundation

| Recommendation | Why it matters | Existing files/modules | Dependencies | Complexity |
|---|---|---|---|---|
| Replace reflected credentialed CORS with an explicit origin allowlist; add a CSRF protection strategy for cookie-authenticated writes. | Reduces cross-origin access to customer, quote, and workspace operations. Wildcard tenant subdomains are same-site and deserve explicit treatment. | `api/src/index.ts` CORS setup and mutating routes; `docker-compose.prod.yml`; `.env.prod.example` | Decide exact production/local origins and how tenant hosts are allowed. | Medium |
| Remove the known JWT secret fallback from production startup; enforce a strong configured secret. | Prevents weak signing configuration from silently enabling forged sessions if deployment bypasses Compose validation. | `api/src/index.ts` auth startup; `api/.env.example`; `.env.prod.example`; `docker-compose.prod.yml` | Secret provisioning in deployment/CI. | Small |
| Reject SVG logos initially, or sanitize/rasterize them and serve user media from an isolated origin. | Prevents active user-controlled content from being directly served from the authenticated app origin. | `api/src/index.ts` logo detection/upload/static route; `web/src/LogoUpload.tsx`; `web/src/QuoteDocument.tsx`; `web/src/QuotePdf.tsx` | Choose supported logo formats and image processing/storage policy. | Small to Medium |
| Move login and OTP throttles to a shared rate-limit store; add public quote endpoint budgets and request-size limits. | Current login limiter is process-local; OTP/public endpoints lack global/IP controls. Limits need to remain effective across restarts/replicas. | `api/src/index.ts` auth/public routes; Compose Redis if chosen; env templates | Redis or another shared limiter; proxy trust configuration. | Medium |
| Add Prisma migrations; deploy migrations with reviewed versioned changes and a pre-deploy backup. | `db push` has no migration history or application rollback trail; future jobs/payments require careful schema evolution. | `api/prisma/schema.prisma`; new `api/prisma/migrations/`; `api/package.json`; `deploy/deploy.sh`; Compose | Decide initial baseline migration and production DB reconciliation method. | Medium to Large |
| Add automated tests for registration/session, cross-tenant access, quote totals/numbering, public decisions/expiry, and Resend selection. | Current checks show code compiles but no end-to-end behavior or tenant isolation is proven. Money and access-control regressions are high impact. | New `api/test`/`api/tests` and `web` test setup; API route modules; schema | Test framework, isolated PostgreSQL test DB, seed/cleanup strategy. | Medium to Large |
| Correct deploy health check and gate deployment on health; introduce GitHub Actions validation. | Current probe targets `/api/health`, which is not defined; deployment can continue after a warning. There is no CI workflow. | `deploy/deploy.sh`; `api/src/index.ts` health routes; new `.github/workflows/*`; Dockerfiles | Choose CI secrets and deployment mechanism; avoid exposing production secrets to pull-request jobs. | Medium |
| Add security headers at the actual TLS edge and verify TLS/HSTS after proxying. | Checked-in Nginx gives basic headers only and does not prove live HTTPS behavior. | `web/Dockerfile`; `deploy/nginx-iquote.conf`; `deploy/nginx-wildcard.conf`; Certbot scripts | Confirm which Nginx instance terminates public TLS and tenant wildcard cert state. | Small to Medium |
| Add backup/restore and upload recovery runbooks; perform a restore rehearsal. | Persistent volumes alone do not provide recoverability. Quote/customer data and uploaded logos must be restorable together. | `docker-compose.prod.yml`; `deploy/`; new ops documentation | Select retention, backup destination, RPO/RTO and secret encryption policy. | Medium |

**Phase exit:** tests cover the existing quote loop and tenant boundaries; the production database has migration history; auth configuration and file upload risks are addressed; CI can prevent a bad deploy; a recovery procedure has been rehearsed.

## Phase 2 — Complete the core quotation and customer workflow

| Recommendation | Why it matters | Existing files/modules | Dependencies | Complexity |
|---|---|---|---|---|
| Add server-side pagination, filtering and search for customers and quotes. | Current workspace loads the full customer and quote collections and filters in the browser. This will slow as tenants grow. | `api/src/index.ts` customer/quote list routes; `web/src/QuoteWorkspace.tsx`; Prisma indexes | Define stable cursor or offset pagination and list filter contract. | Medium |
| Add customer archive/history and duplicate detection. | Businesses need to retire inactive contacts without losing quote references and quickly see past quote activity. | `Customer` schema; customer routes; customer screens in `QuoteWorkspace.tsx` | Decide duplicate matching rules and archive visibility. | Medium |
| Add quote duplication and a revision/version strategy. | Editing stops after send and there is no duplicate action; revisions must preserve what a customer saw and approved. | `Quote`, `QuoteLine` schema; quote routes; `QuoteWorkspace.tsx`; quote list | Decide immutable sent quote versioning vs explicit revision records. | Medium to Large |
| Add discounts and document-level/line-level calculation policy if needed. | Current quote model handles quantity, price and tax only. Commercial quotes often require line and total discount. | `QuoteLine`, `Quote` schema; `normalizeQuoteLines`; editor and PDF components | Product policy for tax-before/after-discount and rounding. | Medium |
| Add industry packs for printing, branding, signage and fabrication, plus configurable categories/units. | The current catalogue seeds handyman/plumbing/electrical/cleaning/construction/retail, but not the intended initial vertical. | `api/src/industry-packs.ts`; `Business.businessType`; `ServiceItem`; onboarding and quote template UI | Interview target businesses and agree estimate/job units, materials, finishing, installation and artwork approval data. | Medium |
| Separate content templates from visual quote templates; support save/edit/delete and preview. | Current `QuoteTemplate` only stores quote lines/notes/terms. It does not provide PDF visual template customization. | `QuoteTemplate` schema/API; `QuoteWorkspace.tsx`; `QuotePdf.tsx`; `QuoteDocument.tsx` | Define stable template schema and compatible versions before exposing custom layouts. | Medium to Large |
| Add typed request validation and consistent error contracts. | Repeated ad-hoc validation is easy to diverge as modules expand; errors currently mix catch-all 409/500 responses. | API route modules in `api/src/index.ts`; API package dependencies | Pick shared validation library and response format. | Medium |
| Measure and test financial rounding across currencies/tax rates. | Server calculations use floating point then Decimal storage; report calculations need deterministic rules. | `normalizeQuoteLines`; API quote routes; `QuotePdf.tsx`; `formatMoney` in `web/src/api.ts` | Agree decimal scale and jurisdiction/tax rules. | Medium |

**Phase exit:** a tenant can manage customers and quotes at scale, revise/duplicate safely, use relevant industry defaults, and produce consistent branded documents from explicit content/visual templates.

## Phase 3 — Introduce customer approval and professional document delivery

| Recommendation | Why it matters | Existing files/modules | Dependencies | Complexity |
|---|---|---|---|---|
| Build an explicit “Send quote” action that emails the customer with the generated PDF attached and public review link. | The current “Mark as sent” operation only changes status/creates a token. Customers are not emailed by this path. | `api/src/index.ts` `/api/quotes/:id/share` and `sendEmail`; `api/src/email-templates.ts`; `web/src/QuoteWorkspace.tsx`; `web/src/QuotePdf.tsx` | Phase 2 immutable revision/document snapshot; Resend API policy. | Medium to Large |
| Persist delivery attempts/results and expose resend/retry status. | The source currently has no mail log; welcome and decision notification failures are swallowed. Support cannot diagnose delivery. | New `EmailDelivery`/`QuoteDelivery` schema; send service/routes; admin/quote UI | Migrations; safe idempotency and provider event model. | Medium |
| Add Resend webhook handling for delivery, bounce, complaint and domain events. | API acceptance is not the same as delivery; businesses need actionable delivery state. | API routes; email schema; `TenantEmailSettings`; webhook secrets | Resend webhook verification and replay protection. | Medium |
| Add a delivery queue/retry policy and prevent user request latency from depending on email provider. | Sending currently happens inline in request paths. A slow provider can delay onboarding and create partial completion behavior. | API send helper/routes; new queue worker (could remain in same deploy initially) | Shared queue backend, idempotency rules, operational alerting. | Large |
| Add “request changes” and quote-token revocation/version controls. | Customer-facing flow is approve/decline only; a compromised or superseded link remains a concern. | `QuoteStatus`, public API, public page, quote/version schema | Quote revision policy and audit log. | Medium |
| Add accessible PDF QA across long/multi-page quotes, custom logos/fonts, currencies, and line wrapping. | Direct PDF is present but visual/browser output has not been formally verified; HTML preview and PDF are separately implemented. | `QuotePdf.tsx`; `QuoteDocument.tsx`; PDF/browser QA fixtures | Browser/PDF regression snapshots or manual acceptance matrix. | Medium |

**Phase exit:** sender can see whether a quote was sent/delivered/viewed/approved, retry safely, and preserve each sent PDF/version for audit.

## Phase 4 — Introduce production, job costing and payment management

| Recommendation | Why it matters | Existing files/modules | Dependencies | Complexity |
|---|---|---|---|---|
| Create job records by converting an approved quote while retaining the quote snapshot. | Approved work needs owners, dates, statuses and execution details distinct from the customer-facing price. | New `Job`, `JobStage`, relation to quote; quote approval endpoint/UI; migrations | Phase 3 immutable quote state; business workflow mapping. | Large |
| Add production stages, job cards, attachments, deadlines, installation and delivery tracking. | Branding/fabrication businesses coordinate artwork, materials, production and installation. Current app stops at approval. | New job modules/routes/UI; upload/storage service; role model | Phase 1 storage/security; Phase 2 industry pack discovery. | Large |
| Add materials, labor, supplier and expense transactions allocated to jobs. | Profit reporting needs actual cost sources, not only quote totals. | New `Supplier`, `Expense`, `JobCost` or ledger models/API/UI | Decide accounting treatment, permissions, tax, currency, audit rules. | Large |
| Add invoice, deposits, partial payments, receipts, balance, refund and allocation models. | Payment instructions on a quote are text only; there is no verified payment state. | New invoice/payment/receipt models and UI; quote/job relation | Financial event/immutable ledger design; compliance and payment provider selection. | Large |
| Add job-level estimated vs actual profitability and operational reports. | Helps businesses identify underpriced work and late production. | Reporting queries, job/expense/payment schemas, dashboard | Accurate historical costs and currency normalization. | Large |

**Phase exit:** an approved quotation can be executed as a job, tracked through completion, and reconciled against job costs and recorded payments with an audit trail.

## Phase 5 — Introduce SaaS subscriptions, integrations and advanced reporting

| Recommendation | Why it matters | Existing files/modules | Dependencies | Complexity |
|---|---|---|---|---|
| Connect a billing provider, checkout and signed webhooks; replace simulated plan state with provider-backed lifecycle state. | Trial plan selection is currently simulated and cannot collect subscription revenue or enforce lifecycle changes. | `Subscription` schema; onboarding; super-admin; new billing API/webhook; env templates | Product pricing, tax/region policy, Phase 1 migrations, payment provider account. | Large |
| Implement team invitations and role-based access within an organisation. | `User.organisationId` is currently one workspace and there is no invite/member flow; teams are a marketed future plan. | User/Organisation schema; auth/session routes; workspace UI; permissions middleware | Multi-membership data design, tenant-role matrix, invitation email delivery. | Large |
| Add complete super-admin lifecycle management and audit trail. | Current admin is monitoring-only and cannot suspend tenants or manage their lifecycle. | `SuperadminDashboard.tsx`; `/api/superadmin/*`; audit model; admin MFA | Phase 1 stronger admin authentication/audit log. | Medium to Large |
| Integrate WhatsApp Business Platform with consent, approved templates and delivery callbacks. | Current WhatsApp is only a `wa.me` user-operated share link; env values are unused. | New provider module/routes/settings; `api/src/index.ts`; tenant settings/UI | Meta Business setup, consent UX, template approval, webhook security, fallback policy. | Large |
| Add advanced business and platform reports with currency-aware aggregation. | Current global admin sums quote values across different currencies; tenant reports are limited to three dashboard metrics. | Query/report modules; dashboard; exchange-rate policy if converting | Financial model and currency grouping/rates. | Medium to Large |
| Add operational monitoring, alerting, retention and scale tests. | The repository has no explicit tracing/error monitoring, backup policy, or concurrency/load tests. | API, deploy files, Compose, CI, storage and DB runbooks | Production metrics access, recovery objectives, expected load profile. | Medium to Large |

**Phase exit:** iQuote has real paid plan lifecycle, team access, supportable platform controls, WhatsApp integration under consent, and currency-correct reporting with operational safeguards.

## Suggested order

1. Close Phase 1 security and migration gaps before tenant or financial data volume grows.
2. Complete Phase 2 quote workflow and print/signage/fabrication templates for the target market.
3. Deliver the actual email-with-PDF flow and observable delivery status in Phase 3.
4. Start production and financial data modeling only after quote revisions, identity, audit events and migrations are settled.
5. Connect real billing after plan/entitlement rules and support tooling are ready.

The current foundation is suitable to continue. No evidence in this audit justifies a rewrite; the work is to secure and extend the existing application with explicit schema and workflow boundaries.
