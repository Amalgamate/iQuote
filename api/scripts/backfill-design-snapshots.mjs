#!/usr/bin/env node
// Freeze designSnapshot for documents that were sent before the design feature existed.
// See docs/DOCUMENT_DESIGN_PLAN.md, Phase 1.
//
// What it does: for every sent quote, every sent invoice and every payment receipt that has no
// snapshot, copy the workspace's current design (or the default design when nothing is saved).
// This is the best available answer for historical documents: their true design was never recorded,
// so the closest honest reconstruction is the branding the business uses today. Nothing is
// overwritten, so re-running is safe and any real snapshot is preserved.
//
// Usage (dry run first, then apply):
//   npx tsx scripts/backfill-design-snapshots.mjs
//   npx tsx scripts/backfill-design-snapshots.mjs --apply
//
// Run --dry-run first and read the counts. Then take a backup (docs/DOCUMENT_DESIGN_PLAN.md).

import { PrismaClient } from '@prisma/client'
import { defaultDesignFor, resolveDesign } from '../src/document-design.js'

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')

async function main() {
  const organisations = await prisma.organisation.findMany({
    select: { id: true, name: true, documentDesign: true },
  })
  const designByOrg = new Map(organisations.map((org) => [org.id, resolveDesign(org.documentDesign)]))

  // A nullable Json column needs a raw IS NULL test: Prisma's `{ equals: null }` on Json compares
  // JSON null (`'null'::jsonb`) and never matches a SQL NULL, which is what an unsent row holds.
  const [quotes, invoices, payments] = await Promise.all([
    prisma.$queryRaw`
      SELECT id, "organisationId" AS "organisationId", "documentNumber" AS "documentNumber"
      FROM "Quote"
      WHERE "designSnapshot" IS NULL
        AND status IN ('SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED')
    `,
    prisma.$queryRaw`
      SELECT id, "organisationId" AS "organisationId", "invoiceNumber" AS "invoiceNumber"
      FROM "Invoice"
      WHERE "designSnapshot" IS NULL AND "sentAt" IS NOT NULL
    `,
    prisma.$queryRaw`
      SELECT id, "organisationId" AS "organisationId", "receiptNumber" AS "receiptNumber"
      FROM "Payment"
      WHERE "designSnapshot" IS NULL
    `,
  ])

  console.log(`workspaces: ${organisations.length}`)
  console.log(`sent quotes without a snapshot:   ${quotes.length}`)
  console.log(`sent invoices without a snapshot: ${invoices.length}`)
  console.log(`receipts without a snapshot:      ${payments.length}`)

  const missingWorkspace = [...quotes, ...invoices, ...payments].filter((row) => !designByOrg.has(row.organisationId))
  if (missingWorkspace.length) {
    console.log(`skipping ${missingWorkspace.length} row(s) whose workspace no longer exists`)
  }

  const counts = { quotes: 0, invoices: 0, payments: 0 }
  for (const group of [
    ['quotes', quotes, (row) => prisma.quote.update({ where: { id: row.id }, data: { designSnapshot: designByOrg.get(row.organisationId) } })],
    ['invoices', invoices, (row) => prisma.invoice.update({ where: { id: row.id }, data: { designSnapshot: designByOrg.get(row.organisationId) } })],
    ['payments', payments, (row) => prisma.payment.update({ where: { id: row.id }, data: { designSnapshot: designByOrg.get(row.organisationId) } })],
  ]) {
    const [label, rows, write] = group
    for (const row of rows) {
      if (!designByOrg.has(row.organisationId)) continue
      if (apply) await write(row)
      counts[label] += 1
    }
  }

  const fallback = defaultDesignFor()
  console.log(apply ? '\nApplied.' : '\nDry run. Nothing was written; pass --apply to write.')
  console.log(`quotes: ${counts.quotes}, invoices: ${counts.invoices}, payments: ${counts.payments}`)
  console.log(`default template used when a workspace has no saved design: ${fallback.template}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
