# Handoff: Phases 2 and 3 of the document design work

Updated 27 Nov 2026 after local implementation. Read this first, then
`docs/DOCUMENT_DESIGN_PLAN.md`, which is the authoritative plan and source of the checklists.

**Current state:** Phases 2 and 3 are implemented locally. Phase 4 PDF download wiring is also in
place for quotes, invoices and receipts. Five template text goldens pass. Full database-backed API
tests require local Postgres, which was unavailable during this handoff. Settings browser review,
email PDF attachments (Phase 5), and production rollout (Phase 6) remain open. Nothing here means the
code is deployed.

**Decisions already made — do not re-litigate them:**

- **Server renderer: `@react-pdf/renderer`.** The server uses `api/src/document-pdf.tsx` and
  `api/src/pdf-service.tsx`; it shares the library and canonical presets, but its document blocks
  are separate from the browser fallback renderer in `web/src/pdf/*`.
- **Plan limits are applied when the design is read, not when it is saved.** A downgrade keeps the
  saved design and the brand colour; documents fall back to Modern and the API reports
  `templateLocked: true`. Never wipe stored design data.
- **Phase 0 and Phase 1 are complete and verified.** Do not redo them. See "What exists" below.

---

## Repo and environment

- Repo: `C:\Amalgamate\Projects\Trends CORE Apps\iQuote` (Windows, Git Bash). Not the empty
  `WorkBuddy AI` folder.
- `api` is Node 22, Express, Prisma 5.22, Postgres, ESM (`"type": "module"`), Vitest 5.1.1.
- Local Postgres is **18.1**; production is **16.15**. Never point a local `pg_dump`/`psql` 17+ at
  production data without reading the traps section below.
- Local `iquote` role is **not** a superuser: it cannot `CREATE DATABASE`. To rehearse a migration,
  `pg_dump` the local database first, then replace `public`.
- Commands that must pass before you call a phase done:
  ```
  cd api && npx tsc --noEmit && npm run build && npx vitest run     # 124 tests currently
  cd web && npm run build
  ```

## What exists (Phase 0 and 1, all verified)

| Piece | Path | Notes |
|---|---|---|
| Design validator, defaults, presets | `api/src/document-design.ts` | Pure. `validateDocumentDesign`, `resolveDesign`, `applyPlanLimits`, `defaultDesignFor`, `TEMPLATE_PRESETS`, `TEXT_LIMITS`, `LOGO_SCALE_*` |
| Validator tests | `api/tests/document-design.test.ts` | 35 tests |
| Feature flags | `api/src/feature-flags.ts` | `documentFlags()` → `{ documentDesign, serverPdf, emailPdfAttach }` |
| Migration | `api/prisma/migrations/20261127140000_document_design/` | `migration.sql` + `rollback.sql` (both rehearsed on real prod data) |
| Settings API | `api/src/index.ts`, search `settings/document-design` | `GET`, `PUT`, `POST .../reset`; OWNER + ADMIN; 404 when flag off |
| API tests | `api/tests/document-design-api.test.ts` | 22 tests: roles, tenant isolation, plan gating, downgrade, reset |
| Backfill script | `api/scripts/backfill-design-snapshots.mjs` | Dry run by default, `--apply` writes, re-runnable |
| Shared web renderer | `web/src/pdf/QuotePdfDocument.tsx`, `themes.ts`, `format.ts` | 258 + 98 + 104 lines, five templates |
| Tier definitions | `api/src/plans.ts` | `STARTER_TEMPLATES = ['modern','classic']`, GROWTH adds `minimal`,`compact`, TEAM adds `bold` |

Database columns now available: `Organisation.documentDesign/kraPin/vatNumber/address`,
`Quote.designSnapshot`, `Invoice.designSnapshot`, `Payment.designSnapshot`,
`QuoteDelivery`/`ReceiptDelivery.attachedPdf/pdfBytes/attachmentError`.

## Server PDF documents

The API now renders quotes, invoices and receipts with the same server-side document blocks and
design snapshots. Saved-document downloads use authenticated or public server routes. The browser
quote/receipt renderers remain as a temporary fallback when the server-PDF feature flag is off; an
unsaved quote editor download uses the current browser draft. Remove the fallback only after Phase 6.

## What is left

### Phase 2 — server PDF rendering — implemented locally

Implemented files and routes are listed below as context for maintenance. Golden fixtures are in
`scripts/document-pdf-goldens/`; `api/tests/document-pdf.test.tsx` asserts all five. The reproducible
memory profile is `api/scripts/profile-document-pdf.tsx`.

1. **Shared render blocks and a theme resolver reading the design JSON.** `web/src/pdf/` is currently
   web-only and reads `QuoteDocumentData` from `../QuoteDocument`. Either move the blocks to a shared
   location both packages import, or duplicate deliberately and keep one source of truth for
   `TEMPLATE_PRESETS`. `api/src/document-design.ts` already mirrors the presets; that duplication is
   the thing to collapse. Server `tsconfig` needs `"jsx": "react-jsx"` (currently absent).
2. **Quote, invoice and receipt documents from the same blocks.** Invoice is new (see above).
   `QuotePdfDocument` takes `QuoteDocumentData`; the server has no such type, so define the server
   data shape and map rows into it.
3. **Render service.** Logo from the uploaded file (`/uploads/…`, read from disk, never a remote
   URL), QR generation, cache keyed by a hash of document data plus design, a concurrency limit, a
   10 second timeout, and a safe fallback layout on error.
4. **Endpoints, all tenant-scoped:** `GET /api/quotes/:id/pdf`, `GET /api/invoices/:id/pdf`,
   `GET /api/payments/:paymentId/receipt.pdf`, and a public, rate-limited
   `GET /api/public/quotes/:token/pdf` using the snapshot. Reuse the existing loaders:
   `/api/quotes/:id` (line 2402) and `/api/invoices/:id` (line 4946); `serializeQuote` at line 643
   converts Decimal to number. Public rate limiting already exists (`checkPublicRateLimit`).
5. **Freeze `designSnapshot` at send time** — quote `/share` and `/send`, invoice `/send`, receipt
   creation — and use it on every later render. `resolveDesign(stored)` never throws.
6. **Tests:** printed numbers match the database; long item lists paginate with the header repeated;
   missing logo, very wide logo and very long descriptions behave. **Note the known rounding problem:**
   `QuoteLine` stores quantity, unit price and tax rate but no line total, so the renderer computes
   quantity × unit price. It must round with the same function the server's totals use (`roundMoney`),
   and a test must assert the printed lines sum to the printed subtotal.
7. **Golden files** per template, and **render time/memory** measured with 1-line and 100-line documents.

**Known defect to fix in this phase:** on a short 3-line quote, Modern, Bold and Classic push the
Acceptance block alone onto a nearly empty page 2. Compact fits on one page. The block cannot split
and page 1 has room left.

### Phase 3 — settings screen — implemented locally

1. New page under Settings: "Documents and branding", OWNER and ADMIN only.
2. Template gallery (miniatures), brand colour with a contrast warning, logo upload with a **size
   slider**, layout options, what to show, wording, paybill and till, attach-PDF default.
3. Preview tabs for Quote, Invoice and Receipt showing the **real server-rendered PDF**, debounced.
   This depends on Phase 2's endpoints, so do not start Phase 3 before they exist.
4. Save, discard, reset to template, unsaved-changes warning, clear success and error messages.
5. Accessible: keyboard, visible focus, labels, usable on a phone.
6. Plan gating: locked templates shown with the plan that unlocks them. The API already returns
   `templates: [{ key, allowed }]` and refuses locked saves with `PLAN_FEATURE_UNAVAILABLE`, so the
   server is the real enforcement — the UI only needs to explain it.
7. Prototype reference: the published "iQuote document designer" artifact (source of the look;
   it is a prototype, not a spec).

The settings screen's data source is already there: `GET /api/settings/document-design` returns
`{ design, saved, templateLocked, templates, identity }`; `PUT` accepts `{ design, identity }`.
The screen lives in `web/src/DocumentDesignSettings.tsx`. Compare its short prototype brief in
`iQuote document designer.md`; visual review at desktop and phone sizes is still pending.

### Phase 4 — downloads — implemented locally

Saved quotes (editor and list), public quote links, invoices and receipts now request server PDFs.
When the server-PDF flag is explicitly off, quote and receipt download controls retain a browser
fallback. Unsaved quote drafts use the browser fallback so current edits are included.

### Phase 5 and 6 — remaining

See the authoritative plan for email attachment work and rollout. Quote and receipt delivery tables
already hold attachment outcome fields; invoice attachment tracking needs an `InvoiceDelivery` model
and additive migration before that phase is complete. Local memory profile on Node v26.7.0 measured
about 20 MB RSS delta for one line and 64 MB for 100 lines; profile again on the deployment runtime.

## Traps that have already cost this project time — read before debugging

- **Prisma `Json?` and null.** `{ designSnapshot: { equals: null } }` compares JSON null and never
  matches SQL NULL, so a "still missing" query silently returns zero rows. Use raw
  `"designSnapshot" IS NULL`.
- **Snapshot the database before rehearsing over it.** Loading the prod dump into local `iquote`
  replaced `public` and aborted at line 5; data survived by luck.
- **Version mismatch on dumps.** A 16.15 dump opened with `psql` 17/18 stops at `\restrict` (a psql
  16.4+ directive). Restore with the `db` container's own `psql`.
- **Prisma schema comments must be `///`.** `//` and `/* */` are rejected as field definitions.
- **Test fixtures with uppercase e-mail fail login** (the route lowercases). Store emails lowercase.
- **`@react-pdf/stylesheet` `Style` type** must be used for style props; `object` fails to compile
  with three `TS2769` errors.
- The web build (`npm run build`, i.e. `tsc -b`) is stricter than a bare `npx tsc --noEmit` and picks
  up `src/pdf/**`. Always verify with the real build.

## Unrelated work in the tree — leave it alone

`web/src/BillingGate.tsx`, `SuperadminDashboard.tsx`, `ProductUpdates.tsx`, `Workspace.css` and the
`workspace_archive` migration are somebody else's in-flight work. Do not modify, revert or commit them.

## Release note

Production has **three** unapplied migrations at the time this handoff was updated:
`20261127100000_quote_revision_publication`,
`20261127130000_workspace_archive`, `20261127140000_document_design`. Release with
`prisma migrate deploy`, not a single migration by hand.
