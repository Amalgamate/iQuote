# Document design and automatic PDF attachments: plan and checklist

**Status (27 Nov 2026): planned, not started.** Nothing in this plan is implemented in the app. A
prototype of the settings screen exists (published artifact "iQuote document designer"), and an
earlier draft of the new PDF renderer is already in `web/src/pdf/` (see "Starting point").
Estimates are rough and unverified. This plan was written from reading parts of the code, not from a
full audit; items marked **verify** need checking before work starts.

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
- [ ] Build and visually check the new template renderer already in `web/src/pdf/` (download a PDF and review all five templates). Needs a run on the owner's machine. Static review notes (27 Nov 2026): its input type (`QuoteDocumentData`) already has the brand, KRA PIN, address and template fields it reads, and its five keys match `plans.ts`. Before Phase 2: (a) it computes each line amount as quantity times unit price, so the server renderer must use the stored, already-rounded line totals; (b) `api/tsconfig.json` has no `jsx` setting, which the server renderer will need; (c) it uses numeric font weights (600, 800) with built-in fonts, so check bold text in the PDF.
- [ ] Tag a rollback point: git is on `main` at `44c4be6` ("fix(pdf): tighten quotation header layout...") and there are no tags yet. Commit or stash any uncommitted work first, then tag. Owner to run.

### Phase 1: data and settings API

- [ ] Prisma migration (additive, nullable columns only) for `documentDesign`, `kraPin`, `vatNumber`, `address`, the three `designSnapshot` columns and the delivery attachment fields. Review the SQL by hand before applying.
- [ ] `api/src/document-design.ts`: pure validator, defaults, and template presets. Reject unknown keys and values; clamp `logo.scale`; validate colours, paybill and till as digits; cap text lengths. Unit tests for every rule.
- [ ] `GET` and `PUT /api/settings/document-design` for OWNER and ADMIN only, tenant-scoped. `PUT` rejects a template the workspace's plan does not include (403 with `PLAN_FEATURE_CODE`, via `templateAllowed`); gated extras, if confirmed, are checked here too.
- [ ] Return the design (read-only) wherever the organisation is already returned, behind the flag.
- [ ] Backfill `designSnapshot` for already-sent quotes, invoices and payments.
- [ ] Extend the tenant-isolation tests: one business cannot read or write another's design or snapshots.
- [ ] Migration rehearsed on a copy of production data; rollback script written.

### Phase 2: server PDF rendering

- [ ] Shared render blocks and theme resolver reading the design JSON.
- [ ] Quote, invoice and receipt documents built from the same blocks.
- [ ] Render service: logo loading from uploads, QR generation, cache keyed by a hash of the document data and design, concurrency limit, 10 second timeout, safe fallback layout on error.
- [ ] Endpoints, all tenant-scoped: `GET /api/quotes/:id/pdf`, `GET /api/invoices/:id/pdf`, `GET /api/payments/:paymentId/receipt.pdf`. A public, rate-limited `GET /api/public/quotes/:token/pdf` using the snapshot.
- [ ] Freeze `designSnapshot` at send time (quote `/share` and `/send`, invoice `/send`, receipt creation) and use it on every later render.
- [ ] Tests: numbers in the PDF text match the database for sample documents; long item lists paginate with the header row repeated; missing logo, very wide logo and very long descriptions behave.
- [ ] Golden-file checks for each template.
- [ ] Measure render time and memory with a 1-line and a 100-line document.

### Phase 3: settings screen

- [ ] New page under Settings: "Documents and branding", visible to OWNER and ADMIN.
- [ ] Template gallery (miniatures), brand colour with contrast warning, logo upload with **size slider**, layout options, what to show, wording, paybill and till, attach-PDF default.
- [ ] Preview tabs for Quote, Invoice and Receipt, showing the real server-rendered PDF, debounced after changes.
- [ ] Save, discard, and reset to template; warn about unsaved changes; clear success and error messages.
- [ ] Accessible controls: keyboard use, visible focus, labels, works on a phone.
- [ ] Plan gating: show locked templates (and any gated extras) with the plan that unlocks them; the server check in Phase 1 is the real enforcement.
- [ ] Prototype reference: the published "iQuote document designer" artifact.

### Phase 4: use it everywhere

- [ ] Replace every "Download PDF" button (quote editor, quote list, invoice, receipt, public quote page) with the server endpoints.
- [ ] Keep the old browser renderer reachable behind the flag until Phase 6 passes, then delete it.
- [ ] Replace the HTML quote preview with the PDF preview, or label it clearly as approximate.
- [ ] Optional: apply brand colour and logo to the public quote page and to the HTML email header.

### Phase 5: automatic email attachments

- [ ] Quote `/send` and `/resend`: render the PDF from the frozen snapshot and attach it. Filename like `Quotation-QT-2026-0042.pdf` (sanitised).
- [ ] Invoice `/send`: attach the invoice PDF.
- [ ] Receipt send: attach the receipt PDF.
- [ ] If rendering fails, **send the email without the attachment** (the link still works), record `attachmentError`, and tell the user.
- [ ] Record `attachedPdf` and `pdfBytes` on each delivery; show "PDF attached" in the delivery history.
- [ ] Cap attachment size; refuse and fall back if it is exceeded.
- [ ] Per-send "Attach PDF" switch (default from settings); update email copy to mention the attachment.
- [ ] Make sure the existing send idempotency and the plan email cap still work. Do not allow client-supplied attachments (generate on the server only).
- [ ] Deliverability test to Gmail, Outlook and a phone mail app: inbox versus spam, attachment opens, matches the chosen template.

### Phase 6: hardening and rollout

- [ ] Full test pass: unit, tenant isolation, render golden files, load test of concurrent renders.
- [ ] Monitoring: render duration, failure count, cache hit rate, attachment size, fallback usage. Alert on repeated failures.
- [ ] Enable for your own workspace first, then the pilot businesses, then everyone; watch for a week at each step.
- [ ] Show a one-time in-app notice about the new designs.
- [ ] Remove the old client-side renderer and the temporary flags once stable.
- [ ] Update `docs/PLANS.md`, the user help text, and this file's status.

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
