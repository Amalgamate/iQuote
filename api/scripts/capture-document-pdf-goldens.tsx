import { writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { resolve } from 'node:path'
import { defaultDesignFor } from '../src/document-design.js'
import { renderDocumentPdf } from '../src/pdf-service.js'
import type { PdfData } from '../src/document-pdf.js'

const templates = ['modern', 'classic', 'minimal', 'bold', 'compact'] as const
const sample: PdfData = {
  kind: 'quote', documentNumber: 'QT-TEST-0042', createdAt: '2026-11-27T10:00:00.000Z', currency: 'KES',
  subtotal: 1000, taxTotal: 160, total: 1160, notes: 'Work begins after approval.', terms: 'Payment is due within 14 days.',
  lines: [{ description: 'Service item 1 with a customer facing description', quantity: 1, unit: 'job', unitPrice: 1000, taxRate: 16, amount: 1000 }],
  customer: { name: 'Sample Customer', email: 'customer@example.com', phone: '+254700000000' },
  business: { name: 'Example Services Ltd', email: 'hello@example.com', country: 'Kenya' },
}

function textFromPdf(pdf: Buffer) {
  const streams: string[] = []
  for (const match of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { streams.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')) } catch { /* ignore non-text streams */ }
  }
  return [...streams.join('\n').matchAll(/<([\da-f]+)>/gi)].map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join('')
}

const output = resolve(process.cwd(), '../scripts/document-pdf-goldens')
for (const template of templates) {
  const design = defaultDesignFor(template)
  const rendered = await renderDocumentPdf(sample, { ...design, show: { ...design.show, acceptance: false, qr: false } })
  await writeFile(resolve(output, `${template}.txt`), textFromPdf(rendered.buffer), 'utf8')
}
process.stdout.write(`Wrote ${templates.length} PDF text goldens to ${output}\n`)
