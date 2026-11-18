# iQuote Feature Matrix

**Audit date:** 18 November 2026  
**Status rule:** existence in the UI or API is not treated as proof of production behavior. No live workflow or production DB verification was possible. “Implemented but needs testing” means source code connects the user flow to persistence/API logic, but this audit found no automated end-to-end test evidence.

| Feature | Current status | Evidence | Missing work / limitation | Priority |
|---|---|---|---|---|
| Landing page and signup screens | Implemented but needs testing | `web/src/MarketingSite.tsx`; registration/verification routes in `api/src/index.ts:415-527` | Browser path and delivery not live-verified; local email simulation differs from production. | High |
| Email OTP verification | Implemented but needs testing | `SignupVerification` model; `/api/auth/verification/send` and `/verify` at `api/src/index.ts:489-526`, `628-639` | Platform Resend delivery not checked; rate limit is per-email cooldown and no shared IP/global limits. | High |
| Login/logout/session | Implemented but needs testing | `api/src/index.ts:100-125`, `641-698`; `User`, `Session` models | No reset/change password, MFA, session-management UI; raw JWT stored in DB; rate limiter in memory. | High |
| Password security | Implemented but needs testing | bcrypt hash at `api/src/index.ts:440`; minimum 8 chars at `415-428` | Default JWT secret fallback, no password recovery/strength policy/MFA. | High |
| Business workspace creation | Implemented but needs testing | Signup transaction and organization creation at `api/src/index.ts:443-469`; `/api/business/setup` `1200-1319` | One workspace per account in practice; no multi-workspace switch or memberships UI. | High |
| Multi-tenant row scoping | Partially implemented | `getOrganisationId` `api/src/index.ts:201-206`; tenant route filters across customers/services/templates/quotes | No RLS/composite tenant constraints; no cross-tenant test suite; one nullable legacy Customer FK. | Critical |
| Business-name subdomain allocation | Partially implemented | `makeSubdomainBase`/`allocateSubdomain` `api/src/index.ts:208-243`; unique `Organisation.subdomain` | App stores subdomain only. Wildcard DNS, Nginx route, TLS, and availability depend on external/manual config; no domain provisioning API. | High |
| Workspace switching/team membership | Planned but not implemented | `User.organisationId` and `Organisation.members` exist | No invite flow, membership roles, switching, or authorization by member role. | Medium |
| Business profile/settings | Implemented but needs testing | `web/src/QuoteWorkspace.tsx`; `/api/business/me`, `/api/business/setup` | No branch/location support; locale/tax/currency policy is basic. | Medium |
| Logo upload | Implemented but needs testing | `/api/settings/logo`, `api/src/index.ts:1321-1417`; persistent upload volume in Compose | SVG sanitization issue; no object storage, logo cleanup, malware scanning, or CDN. | High |
| Customer create/edit/delete/search | Implemented but needs testing | `/api/customers` routes `api/src/index.ts:705-804`; workspace UI | No archive, duplicate prevention, import, pagination, or customer history screen. Hard delete blocked when quotes exist. | Medium |
| Product/service catalogue | Implemented but needs testing | `ServiceItem`; `/api/service-items` `api/src/index.ts:806-875`; UI in `QuoteWorkspace.tsx` | No inventory, stock, variants, supplier, or price history. | Medium |
| Industry-specific starter packs | Partially implemented | `api/src/industry-packs.ts`: handyman, plumbing, electrical, cleaning, construction, retail | No dedicated branding/printing/signage/fabrication pack; packs seed text items/templates rather than deeply configurable workflows. | High |
| Quote content templates | Implemented but needs testing | `QuoteTemplate`; `/api/quote-templates` `api/src/index.ts:877-918` | No edit/delete; these templates are quote lines/notes, not visual PDF layouts. | Medium |
| Quote creation and persistence | Implemented but needs testing | `/api/quotes` and `/api/quotes/:id` `api/src/index.ts:938-1039`; `Quote`/`QuoteLine` models | No duplicate/revision workflow, discount support, or audit history. | Critical |
| Quote calculations | Implemented but needs testing | `normalizeQuoteLines` `api/src/index.ts:259-296`; create/edit recompute totals on API | Uses JavaScript floating-point intermediates before Decimal storage; no calculation tests found; discounts absent. | Critical |
| Quote numbering | Implemented but needs testing | `QuoteSequence` composite key; transactional upsert `api/src/index.ts:955-963` | Concurrency path lacks tests. | High |
| Quote list/dashboard | Implemented but needs testing | Workspace loads quotes and shows status/approved value `web/src/QuoteWorkspace.tsx:150-170`, `524-535` | Loads all records; client-side search; no refresh/pagination for tenant users. | Medium |
| HTML quote preview | Implemented but needs testing | `web/src/QuoteDocument.tsx`; `.quote-paper` styles in `Workspace.css` | Separate from PDF renderer; layout parity can regress. | Medium |
| Direct PDF download | Implemented but needs testing | `@react-pdf/renderer` in `web/package.json`; `web/src/QuotePdf.tsx`; download link used in editor/public quote | No browser-rendered output/page-break QA in this audit; no stored PDF or attachment pipeline. | High |
| Browser print | Implemented but needs testing | `window.print()` in editor/public quote; `Workspace.css` print rules | Browser-dependent print dialog and layout; separate from direct download. | Low |
| Mark quote sent / share link | Partially implemented | `/api/quotes/:id/share` `api/src/index.ts:1050-1066`; creates token and status; UI shows copy/WhatsApp link | Does not send email. Button says “Mark as sent” but business may interpret that as emailed; no send event or delivery log. | Critical |
| Email provider (Resend) | Implemented but needs testing | `sendEmail` `api/src/index.ts:151-199`; env templates; OTP/welcome/decision call sites | No provider callback/webhook, retries, bounce/suppression log, or actual platform delivery verification. | High |
| Tenant Resend key/domain settings | Implemented but needs testing | `TenantEmailSettings`; `/api/settings/email*` `api/src/index.ts:528-626`; AES-GCM helper `58-73` | Requires platform encryption key; verification/send behavior not tested; keys use one versionless key derivation. | High |
| Quote email with PDF | Not present | No quote-send endpoint/UI or attachment in `sendEmail` body | Add send form, rendered PDF attachment, delivery state/log, and retry/resend semantics. | Critical |
| Customer quote view | Implemented but needs testing | `GET /api/public/quotes/:token` `api/src/index.ts:1068-1109`; `web/src/PublicQuote.tsx` | Public endpoints have no throttling; token has no administrative revoke/regenerate operation. | High |
| Approve/decline and comment | Implemented but needs testing | `POST /api/public/quotes/:token/decision` `api/src/index.ts:1111-1168` | No request-changes state; no explicit E2E or email notification confirmation. | High |
| Quote expiry | Implemented but needs testing | Expiry changes on list/public fetch and blocks decision (`api/src/index.ts:926-929`, `1080-1087`, `1117-1121`) | Expiry cleanup is request-driven, not scheduled; no time-zone policy documentation. | Medium |
| Platform admin overview | Implemented but needs testing | `SuperadminDashboard.tsx`; `/api/superadmin/*` `api/src/index.ts:1421-1549` | No suspend/edit/user admin, audit log, MFA, billing controls. Global quote total mixes currencies. | High |
| Subscription/trial record | Partially implemented | `Subscription` model and signup/setup trial creation with `simulated: true` | Plan selection is simulated; no checkout, provider ID, billing events, cancellation, renewal, or enforcement. | High |
| Payments, deposits, receipts, refunds | Planned but not implemented | No model/API/UI found; README states payment collection is not connected | Define payment ledger and allocations before relying on balances/reports. | High |
| Job/production workflow | Planned but not implemented | No job/production models/routes/components found | Quote-to-job conversion, stages, job cards, schedule, attachments, supplier/installation/delivery. | High |
| Expenses and job costing | Planned but not implemented | No expense/cost/profit models/routes/components found | Materials/labor/transport allocation and estimated-vs-actual reporting. | High |
| WhatsApp Business API | Planned but not implemented | Env placeholders only; browser `wa.me` link is present | Consent, Cloud API/provider integration, approved templates, webhook and delivery status. | Medium |
| CI workflow | Not present | No `.github/workflows` files found | Add PR gates for typecheck/lint/tests/build and controlled deploy artifact promotion. | High |
| Database migration workflow | Not present | No `api/prisma/migrations`; deployment uses `prisma db push` | Versioned migrations, backup before changes, review and recovery procedure. | Critical |
| Test suite | Not present | No test/spec files and no `test` script in either package | API unit/integration tests, tenant-isolation tests, quote math, auth and public decision flows. | Critical |
| Production monitoring/backups | Planned but not implemented in repository | No monitoring/alerting or backup/restore runbook found | Verify server-side operations separately; define retention and recovery objectives. | High |

## Audit validation notes

- API and web TypeScript no-emit checks passed.
- Web lint exited successfully with nine warnings.
- `npm audit` reported zero known vulnerabilities for both packages at the audit time.
- Production build and browser tests were not run; no existing tests were found.
- Public hostname could not resolve from the audit environment, so live behavior is unverified.
