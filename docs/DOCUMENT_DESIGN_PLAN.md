# Document design and automatic PDF attachments: plan and checklist

**Status (27 Nov 2026): Phases 0–5 implemented locally; Phase 6 release validation remains open.**
Quote, invoice and receipt email paths now generate server-side PDFs from saved document snapshots,
record attachment outcomes, and retain secure links when PDF generation or the size limit prevents
an attachment. The API/web type checks, production web bundle, Prisma validation and 14 focused PDF
tests passed in this checkout. No live mailbox validation or production migration/rollout has run.
This status describes local code, not production deployment.

## Decisions already made (owner)

1. Owners control the look and feel of their documents from Settings.
2. All five templates are offered: Classic, Modern, Minimal, Bold, Compact.
3. Owners can adjust the **logo size**.
4. The design applies **consistently to every document**: quotes, invoices and receipts.
5. Documents are **attached automatically** to the emails sent to customers.
6. It must ship **without breaking anything that works today.**

## Starting point (what exists now)

| Area | Today |
|---|---|
| Quote PDF | Built in the browser (`web/src/pdf/QuotePdfDocument.tsx`, re-exported from `QuotePdf.tsx`). New five-template renderer written 26 Nov 2026; **not yet built or visually checked**. |
| Receipt PDF | Separate browser component (`ReceiptPdf.tsx`) with its own style. |
| Invoice PDF | None found. |
| Server PDF | **None.** `api/package.json` has no PDF library. |
| Email | `sendEmail` supports `attachments`, but quote, invoice and receipt sends **pass none**. Emails contain a summary and a link. The invoice email links to the public **quote** page. |
| Design settings | None stored. Brand colour, template, logo size, KRA PIN, address and payment display do not exist in the database. |
| Logo | Stored with width and height. No size control. |
| Preview | `QuoteDocument.tsx` is a separate HTML layout that does not match the PDF. |

Key consequence: **automatic attachment forces PDF generation onto the server.** That in turn lets
every document, download and email come from one renderer, which is also how consistency is
guaranteed. This is the central design choice of the plan.

## Architecture (recommended)

```
Settings screen ──save──> Organisation.documentDesign (validated JSON)
                                   │
 send / download / preview         ▼
 request ──> freeze design into  designSnapshot on the document (quote, invoice, payment)
                                   │
                                   ▼
               server render service (@react-pdf/renderer, Node)
               one set of shared blocks: header, parties, table, totals, payment box, notes, footer
                       │               │                  │
               Download PDF     Settings preview     Email attachment
```

- **One renderer, on the server, for everything.** Web "Download PDF", the settings preview and the email attachment all call the same code. No browser/server drift.
- **Design is data.** Templates and options are validated JSON read by the renderer. Adding a template is a data change.
- **Snapshots.** When a document is sent, its design and business details are frozen on it. Restyling later never changes a document a customer already received. Drafts follow the live design.
- **Money is never touched.** The renderer only formats numbers that the existing server logic already computed.

## Data model (additive only)

Supersedes the earlier standalone `documentTemplate` column plan and the `brandColor` column in the
branding patch (neither has been applied to the project).

```prisma
model Organisation {
  // ...existing fields...
  documentDesign Json?     // validated design settings, see below
  kraPin         String?   // business identity (also used outside documents)
  vatNumber      String?
  address        String?
}
model Quote    { designSnapshot Json? }   // frozen when sent
model Invoice  { designSnapshot Json? }   // frozen when sent
model Payment  { designSnapshot Json? }   // frozen when the receipt is issued
// Delivery tables (Quote / Invoice / Receipt deliveries):
//   attachedPdf Boolean @default(false), pdfBytes Int?, attachmentError String?
```

Design JSON, version 1 (every value is checked against an allow-list on save):

```json
{
  "version": 1,
  "template": "modern",
  "brandColor": "#1a5c3f",
  "typeface": "sans",
  "header": "band",
  "table": "striped",
  "total": "solid",
  "spacing": "comfortable",
  "logo": { "scale": 100 },
  "show": { "tax": true, "unit": true, "totalInWords": true, "kraPin": true, "paymentBox": true, "qr": true, "terms": true, "acceptance": true },
  "text": { "quoteTitle": "Quotation", "invoiceTitle": "Invoice", "receiptTitle": "Receipt", "footer": "Thank you for your business.", "terms": "" },
  "payment": { "paybill": "", "till": "" },
  "email": { "attachPdf": true }
}
```

- **Logo size:** `logo.scale` is a percentage (clamped, for example 50 to 150) of the template's base logo box, always preserving aspect ratio, with a hard maximum width and height so a logo cannot push the header off the page.
- **Missing or invalid design:** the renderer falls back to the default design. It must never throw.
- Existing rows get `NULL` and render with the default design. No backfill is required for drafts.
- **Backfill for already-sent documents:** set `designSnapshot` from the effective default design at migration time, so later settings changes cannot alter them. Totals and text never change.

## Consistency across documents

All three documents share the same blocks and the same design settings. Only the content differs.

| Block | Quote | Invoice | Receipt |
|---|---|---|---|
| Header (logo, name, contacts, KRA PIN, address) | yes | yes | yes |
| Title and number | Quotation, valid until | Invoice, issued and due | Receipt, payment date |
| Parties | Prepared for | Bill to | Received from |
| Item table | lines | lines | invoice reference, payment line |
| Totals | subtotal, tax, total, in words | plus paid and balance due | amount received, balance after |
| Payment box (M-Pesa and QR) | deposit | amount due | hidden |
| Terms and notes | yes | yes | optional |
| Acceptance signature | yes | no | no |
| Footer and page numbers | yes | yes | yes |

## What this requires

**Engineering**
- Add `@react-pdf/renderer`, `react` and `react-dom` to `api/`; JSX support in `api/tsconfig.json` (or build elements without JSX). **Verify** the current tsconfig and the Docker build.
- A QR library for the link and payment QR (for example `qrcode`), rendered to an image for the PDF.
- Logo handling on the server: read the stored file from the uploads folder and embed it (a server cannot use browser-relative URLs). Enforce a maximum upload size and pixel dimensions; downscaling needs an image library (for example `sharp`) or strict limits.
- A render service with an in-memory cache, a concurrency limit, a timeout and a safe fallback.
- A settings screen, new endpoints, and changes to the web download buttons.

**Infrastructure and providers**
- Enough CPU and memory on the API host for PDF rendering; measure before launch.
- Resend limits on attachment and email size. **Verify** current limits and keep PDFs small (target under 1 MB).
- Backups before running migrations in production.

**Decisions settled by the owner (27 Nov 2026)**
1. Do existing businesses keep the old look until they choose? **Decided: no.** Everyone moves to the new default (Modern) with a one-time notice. The old layout had an overlapping-header bug and nothing is stored.
2. Are all templates available on every plan? **Decided: no.** Templates are spread across plans: **Starter** gets Modern (the default) and Classic; **Growth** adds Minimal and Compact; **Team** adds Bold. Brand colour, logo, KRA PIN and address stay on every plan. The logo size slider, custom footer and terms text, and payment QR are **free on all plans** (owner decision, 27 Nov 2026). Rules: enforce on the server (save endpoint and renderer, using `templateAllowed` in `api/src/plans.ts`); a plan without the saved template falls back to Modern and shows an upgrade prompt; it never blocks sending and never changes a sent document (frozen snapshot); trial workspaces map to Growth, so Bold shows as locked during the trial.
3. Default for "attach PDF": **Decided: on**, with a per-send switch on the send screen.
4. Paper size: **Decided: A4 only** for launch (Letter later, via the design `version` field).
5. Languages: **Decided: English only** for launch (Swahili labels later).
6. Should the customer public quote page also use the brand colour and logo? **Decided: yes**, in a later step (Phase 4 optional).

## Phases

Each phase is shippable and reversible on its own. Do not start a phase until the previous phase's
checks pass.

### Phase 0: safety net (before any code)

- [ ] Confirm builds and tests pass today: `npm run build` and `npm test` in `api`, `npm run build` in `web`.
- [ ] Commit or tag the current state so there is a clean rollback point.
- [ ] Save sample PDFs of the current quote and receipt output as reference.
- [ ] Back up the production database; write down the restore steps.
- [x] Open decisions settled (27 Nov 2026), see above, including the extras staying free.
- [x] `plans.ts` template split applied (Starter: Modern, Classic; Growth adds Minimal, Compact; Team adds Bold), tests updated, PLANS.md matrix updated. Verified 27 Nov 2026 in a scratch copy: 13 plans tests pass, strict type-check clean. **Still to run on the real project:** `npm test` and `npm run build` in `api`.
- [x] Feature flags created, all default off (27 Nov 2026): `api/src/feature-flags.ts` (`documentFlags()`; attach is off whenever server PDF is off), `api/tests/feature-flags.test.ts` (3 tests pass in the scratch copy), entries in `.env.prod.example`, and passed through in `docker-compose.prod.yml` (the compose file lists API env vars explicitly, so a flag not listed there would never reach the container). Not yet imported by any route.
- [x] Visual check of the template renderer in `web/src/pdf/` done (27 Nov 2026, rendered by WorkBuddy to `web/out/templates/preview/`, which is gitignored). Reviewed: Modern, Bold, Classic, Compact and the receipt all render correctly, including bold text. Minimal was not reviewed. Findings: (1) on a short 3-line quote, Modern, Bold and Classic push the Acceptance block alone onto a nearly empty page 2 (the block cannot split and page 1 has room left; Compact fits on one page); fix during Phase 2. (2) The receipt uses a different layout (no band, no template, no brand header), so the consistency work in Phase 2 and 4 is confirmed. (3) Sample line 3 shows 17,000.01 (3 x 5,666.67) while the subtotal counts it as 17,000.00, which proves the rounding mismatch in the note below. Earlier static review notes: its input type (`QuoteDocumentData`) already has the brand, KRA PIN, address and template fields it reads, and its five keys match `plans.ts`. Before Phase 2: (a) it computes each line amount as quantity times unit price. `QuoteLine` has no stored line total (only quantity, unit price and tax rate), so the server renderer must use one shared function that rounds a line exactly the way the server's totals do (`roundMoney`), and a test must assert that the printed lines sum to the printed subtotal; (b) `api/tsconfig.json` has no `jsx` setting, which the server renderer will need; (c) bold text with built-in fonts renders correctly (checked).
- [ ] Tag a rollback point: git is on `main` at `44c4be6` ("fix(pdf): tighten quotation header layout...") and there are no tags yet. Commit or stash any uncommitted work first, then tag. Owner to run.

### Phase 1: data and settings API

- [x] Prisma migration (additive, nullable columns only) for `documentDesign`, `kraPin`, `vatNumber`, `address`, the three `designSnapshot` columns and the delivery attachment fields. Review the SQL by hand before applying. Written 27 Nov 2026 as `20261127140000_document_design`, with a reviewed `rollback.sql` beside it. Confirmed against the live schema with `prisma db pull`: the hand-written SQL and the column list agree. **Finding from the rehearsal:** production had not one but **three** unapplied migrations (`20261127100000_quote_revision_publication`, `20261127130000_workspace_archive`, `20261127140000_document_design`), so the production release must run `prisma migrate deploy`, not this migration alone.
- [x] `api/src/document-design.ts`: pure validator, defaults, and template presets. Reject unknown keys and values; clamp `logo.scale`; validate colours, paybill and till as digits; cap text lengths. Unit tests for every rule. Written 27 Nov 2026 with `api/tests/document-design.test.ts`; 35 tests pass and the file type-checks under strict mode in a scratch copy (51 tests across the three new or changed modules). Also provides `resolveDesign` (never throws; bad data gives the default design) and `applyPlanLimits` (falls back to Modern when the plan lacks the template). Choices to review: paybill and till must be 5 to 7 digits; text is rejected, not cut, when over its limit; layout keys default to the chosen template's preset, which mirrors `web/src/pdf/themes.ts` and must be kept in step. **Still to run on the real project:** `npm test` and `npm run build` in `api`. Not yet used by any route.
- [x] `GET` and `PUT /api/settings/document-design` for OWNER and ADMIN only, tenant-scoped. `PUT` rejects a template the workspace's plan does not include (403 with `PLAN_FEATURE_CODE`, via `templateAllowed`); gated extras, if confirmed, are checked here too. Also `POST /api/settings/document-design/reset` for "reset to template", and KRA PIN, VAT number and address save with the design in an optional `identity` block. All three routes return 404 when `DOCUMENT_DESIGN_ENABLED` is off. **Review decision taken:** plan limits are applied on read, not on write — a downgraded workspace keeps its saved design (and its colours), and documents fall back to Modern with `templateLocked: true` until it upgrades. Writing a template the plan lacks is still refused. Covered by `api/tests/document-design-api.test.ts` (22 tests): role checks, tenant isolation, plan gating, downgrade fallback, reset, unknown keys.
- [x] Return the design (read-only) wherever the organisation is already returned, behind the flag. `GET /api/business/me` now carries `documentDesign` (design, saved design, `templateLocked`, per-template `allowed` flags) and the identity fields; null when the flag is off.
- [x] Backfill `designSnapshot` for already-sent quotes, invoices and payments. `api/scripts/backfill-design-snapshots.mjs`, dry run by default, `--apply` to write, safe to re-run. **Trap recorded:** a nullable `Json` column must be filtered with raw `"designSnapshot" IS NULL`. Prisma's `{ equals: null }` compares JSON null and silently matches nothing, which made the first version report zero work.
- [x] Extend the tenant-isolation tests: one business cannot read or write another's design or snapshots. Added to `api/tests/document-design-api.test.ts` (a save is scoped to the caller, an `organisationId` in the body is ignored, another workspace's quote and snapshot are unreachable, and saving a quote does not overwrite a frozen snapshot).
- [x] Migration rehearsed on a copy of production data; rollback script written. Rehearsed 27 Nov 2026 by loading the Phase 0 production dump (138 KB, 5 organisations, 19 quotes, 5 invoices, 6 users) over the local database, then running the real `prisma migrate deploy`. All three migrations applied; row counts and every new column verified on real data; the backfill filled 14 quotes, 4 invoices and 2 receipts; `rollback.sql` then removed all eight columns with every row intact and `prisma migrate status` reporting the migration as reapplicable; the local database was restored from a snapshot afterwards. **Finding:** local Postgres is 18.1, production is 16.15, and a 16.15 dump opened with `psql` 17 stops at `\restrict` (a 16.4+ psql directive). Restores must use `psql` from the same major version, i.e. from inside the production `db` container.

### Phase 2: server PDF rendering

- [x] Shared render blocks and theme resolver reading the design JSON. The server renderer uses the API's canonical template presets.
- [x] Quote, invoice and receipt documents built from shared header, recipient, line, totals and footer blocks.
- [x] Render service: logo loading from uploads, QR generation, cache keyed by a hash of the document data and design, concurrency limit, 10 second timeout, safe fallback layout on error.
- [x] Endpoints, all tenant-scoped: `GET /api/quotes/:id/pdf`, `GET /api/invoices/:id/pdf`, `GET /api/payments/:paymentId/receipt.pdf`. A public, rate-limited `GET /api/public/quotes/:token/pdf` using the snapshot.
- [x] Freeze `designSnapshot` at send time (quote `/share` and `/send`, invoice `/send`, receipt creation) and use it on every later render.
- [x] Tests: numbers in the PDF text match the database for sample documents; long item lists paginate with the header row repeated; missing logo, very wide logo and very long descriptions behave.
- [x] Golden-file checks for each template. Stable extracted PDF text fixtures live in `scripts/document-pdf-goldens/` and are asserted by the renderer tests.
- [x] Measure render time and process memory with 1-line and 100-line documents. Run `node --expose-gc --import tsx scripts/profile-document-pdf.tsx` from `api/`. On the local Windows Node v26.7.0 run (27 Nov 2026): 1 line rendered in 169 ms / 3,855 bytes with ~19.9 MB peak RSS delta; 100 lines rendered in 593 ms / 20,419 bytes with ~63.8 MB peak RSS delta. This is process RSS under a warm local runtime, not production-host capacity; profile again on the deployment runtime before rollout.
- [x] Renderer tests: 11/11 passed. Full API run: 78 passed, 57 skipped, and database-backed suites could not initialize because Postgres was unavailable at `localhost:5432`; rerun the full suite once local Postgres is running.

### Phase 3: settings screen

- [x] New page under Settings: "Documents and branding", visible to OWNER and ADMIN.
- [x] Template gallery (miniatures), brand colour with contrast warning, logo upload with **size slider**, layout options, what to show, wording, paybill and till, attach-PDF default.
- [x] Preview tabs for Quote, Invoice and Receipt, showing the real server-rendered PDF, debounced after changes.
- [x] Save, discard, and reset to template; warn about unsaved changes; clear success and error messages.
- [x] Accessible control labels, focus styles, keyboard-operable native controls and phone-responsive layout implemented; visual/device review remains pending.
- [x] Plan gating: show locked templates (and any gated extras) with the plan that unlocks them; the server check in Phase 1 is the real enforcement.
- [x] Compare the settings copy and preview promise with the published "iQuote document designer" artifact. It is a concise prototype brief rather than a full interaction specification; the new screen keeps the same sample-content and frozen-sent-document promise.
- [ ] Visually review the live settings screen at desktop and phone sizes.

### Phase 4: use it everywhere

- [x] Route saved quote editor/list, invoice, receipt and public quote PDF downloads through their server PDF endpoints. Unsaved quote edits retain the browser renderer so the downloaded document reflects the unsaved editor state.
- [x] Keep the browser quote/receipt renderer as a temporary fallback only when server PDF is disabled; saved-document downloads otherwise use the server route. Remove the fallback after Phase 6 passes.
- [x] Label the editor's HTML document preview as approximate because pagination can differ from the final PDF.
- [ ] Optional: apply brand colour and logo to the public quote page and to the HTML email header.

### Phase 5: automatic email attachments

- [x] Quote `/send` and `/resend`: render from the saved quote snapshot and attach a sanitized filename.
- [x] Invoice `/send`: render the saved invoice PDF and persist each attempt in `InvoiceDelivery`.
- [x] Receipt send: render the saved receipt PDF and persist attachment metadata on `ReceiptDelivery`.
- [x] On render failure or an over-limit PDF, send without the attachment, preserve the secure link, record the reason and show the outcome to the sender.
- [x] Record `attachedPdf`, `pdfBytes` and `attachmentError`; expose them in quote, invoice and receipt history.
- [x] Cap attachments at 8 MiB.
- [x] Add per-send switches, defaulted from Document Design settings; email copy states when a PDF is attached.
- [x] Keep server-side generation only. Quote, invoice and receipt sends enforce the email cap; quote and invoice attempts deduplicate active sends, and receipts reject repeat sends within five minutes.
- [ ] Deliverability test with Gmail, Outlook and a phone mail app: inbox versus spam, attachment opens and design matches.

### Phase 6: hardening and rollout

- [x] Focused PDF renderer and email attachment tests, golden text checks, API/web type checks, web production bundle and Prisma schema validation pass locally.
- [x] Add structured PDF render timing, cache hit, fallback, output-size and email-attachment skip/size logs.
- [ ] Run the full database-backed tenant-isolation suite and concurrent-render load test against a provisioned test database.
- [ ] Alert on repeated render and attachment failures in the production monitoring stack.
- [ ] Publish a one-time owner-facing “What’s new” notice. The existing Product Updates control can deliver it; send it from Superadmin after deployment.
- [ ] Enable for the owner workspace, then pilot businesses, then all tenants; observe each stage for one week.
- [ ] Remove the old client-side renderer and temporary flags after rollout stability is demonstrated.
- [x] Update `docs/PLANS.md`, the user help text and this status.

**Release preflight:** confirm the production database backup; deploy the additive migrations for quote
revision publication, workspace archive, document design and invoice delivery; set and verify
`DOCUMENT_DESIGN_ENABLED`, then `SERVER_PDF_ENABLED`; smoke-test tenant-scoped quote, invoice,
receipt and public quote PDFs; enable email attachments only after live deliverability checks; deploy
to the owner workspace, then pilots, then all tenants. Roll back by disabling flags first. Recheck
production memory and render timings before enabling broadly. Do not remove the browser fallback or
flags until this staged rollout has passed.

## Keeping existing things working

- **Additive migrations only.** No column is renamed or dropped; new columns are nullable or have defaults. Apply the migration before the code that uses it.
- **Flags default off.** Each phase can be switched on or off without a deploy.
- **Fallback everywhere.** Bad or missing design gives the default design. A render error gives a plain fallback PDF or an email without the attachment. The send flow never fails because of a PDF.
- **Dual running.** Old and new PDF paths coexist until the new one is proven.
- **Sent documents are frozen** by the snapshot. Restyling cannot change them.
- **Numbers are read-only inputs.** Add tests comparing totals in the PDF with the stored totals.
- **Tenant isolation** tests for every new endpoint.
- **Rollback plan** per phase: flag off first; schema stays (it is additive); restore the tag only if code must be reverted.

## Risks

| Risk | Mitigation |
|---|---|
| Server PDF rendering is slow or memory heavy | Cache, concurrency limit, timeout, measure in Phase 2, scale or move to a worker only if data shows a need |
| Attached PDFs hurt email deliverability | Keep the link in the email, keep PDFs small, test across providers, make the attachment switchable |
| Huge logos make heavy PDFs | Upload limits, optional downscaling, hard maximum logo box |
| Design drift between preview and PDF | The preview is the PDF; thumbnails only are approximate |
| Existing businesses surprised by the new look | One-time notice; template choice in Settings |
| A bad colour makes text unreadable | Contrast check and automatic fallback to a safe colour |
| Fonts | Built-in PDF fonts only at launch; any custom font must be bundled in the API image and licensed |
| Wrong amounts printed | Renderer cannot change numbers; tests compare to the database |
| Scope growth | Phases are independent; Phase 4 optional items and Letter or Swahili are deferred |

## Rough effort (one developer, unverified)

| Phase | Days |
|---|---:|
| 0 safety net | 0.5 |
| 1 data and API | 2 |
| 2 server rendering | 4 |
| 3 settings screen | 4 |
| 4 use everywhere | 1 |
| 5 email attachments | 2 |
| 6 hardening and rollout | 2 |
| **Total** | **about 15 to 16** |

## Acceptance criteria

- An owner changes template, colour, layout, wording and logo size in Settings and sees the same result in the preview, the downloaded PDF and the emailed attachment, for quotes, invoices and receipts.
- Quotes, invoices and receipts sent before the change look and read the same as when they were sent (frozen snapshot), with identical amounts.
- Every customer email for a quote, invoice or receipt carries the PDF automatically, or the email still sends with the link if rendering fails, and the failure is recorded and visible.
- No endpoint returns or accepts another business's design, snapshot or PDF.
- Build and all tests pass; render time is within the measured budget; no regression in sending, billing, trial limits or plan limits.
