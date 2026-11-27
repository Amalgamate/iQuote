/**
 * Heap probe for the server PDF service. Renders the same document many times and prints, after a
 * forced GC, the JavaScript heap and RSS so a real leak (heap grows) can be told apart from
 * allocator retention (heap flat, RSS high). Phase 6 of docs/DOCUMENT_DESIGN_PLAN.md.
 *
 *   node --expose-gc --import tsx scripts/heap-probe-document-pdf.tsx [iterations] [lines]
 */
import { defaultDesignFor } from '../src/document-design.js'
import { renderDocumentPdf } from '../src/pdf-service.js'
import type { PdfData } from '../src/document-pdf.js'

const ITERATIONS = Number(process.argv[2] ?? 120)
const LINES = Number(process.argv[3] ?? 20)
const design = defaultDesignFor('modern')

function sample(index: number): PdfData {
  return {
    kind: 'quote', documentNumber: `HEAP-${index}`, createdAt: new Date().toISOString(), currency: 'KES',
    subtotal: LINES * 1000, taxTotal: LINES * 160, total: LINES * 1160,
    lines: Array.from({ length: LINES }, (_, line) => ({ description: `Probe line ${line + 1}`, quantity: 1, unit: 'job', unitPrice: 1000, taxRate: 16, amount: 1000 })),
    customer: { name: `Probe ${index}`, email: `probe${index}@example.test` },
    business: { name: 'iQuote Heap Probe', email: 'heap@example.test', country: 'Kenya' },
  }
}

function snapshot() {
  global.gc?.(); global.gc?.()
  const usage = process.memoryUsage()
  return { heapUsed: usage.heapUsed, external: usage.external, rss: usage.rss }
}

const points: Array<{ at: number; heapUsed: number; external: number; rss: number }> = []
points.push({ at: 0, ...snapshot() })

for (let index = 0; index < ITERATIONS; index++) {
  await renderDocumentPdf(sample(index), design)
  if ((index + 1) % Math.max(1, Math.floor(ITERATIONS / 6)) === 0) {
    points.push({ at: index + 1, ...snapshot() })
  }
}

const first = points[0]
const last = points[points.length - 1]
const heapGrowth = last.heapUsed - first.heapUsed
const heapPerDocument = heapGrowth / Math.max(1, ITERATIONS)

process.stdout.write(`${JSON.stringify({
  node: process.version,
  platform: process.platform,
  iterations: ITERATIONS,
  linesPerDocument: LINES,
  points,
  heapGrowthBytes: heapGrowth,
  heapGrowthPerDocumentBytes: Math.round(heapPerDocument),
  verdict: heapPerDocument > 20_000 ? 'possible leak: the JS heap grows per document' : 'no heap leak: growth per document is within noise',
}, null, 2)}\n`)
