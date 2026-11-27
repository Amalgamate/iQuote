import { defaultDesignFor } from '../src/document-design.js'
import { renderDocumentPdf } from '../src/pdf-service.js'
import type { PdfData } from '../src/document-pdf.js'

function sample(lines: number): PdfData {
  const items = Array.from({ length: lines }, (_, index) => ({
    description: `Measured service line ${index + 1} with a representative customer-facing description`,
    quantity: 1,
    unit: 'job',
    unitPrice: 1000,
    taxRate: 16,
    amount: 1000,
  }))
  return {
    kind: 'quote', documentNumber: `PROFILE-${lines}`, createdAt: new Date().toISOString(), currency: 'KES',
    subtotal: lines * 1000, taxTotal: lines * 160, total: lines * 1160, notes: 'Memory and render profile.',
    lines: items, customer: { name: 'Profile Customer', email: 'customer@example.test' },
    business: { name: 'iQuote Render Profile', email: 'profile@example.test', country: 'Kenya' },
  }
}

async function profile(lines: number) {
  global.gc?.()
  const before = process.memoryUsage()
  let peak = before
  const interval = setInterval(() => {
    const current = process.memoryUsage()
    if (current.rss > peak.rss) peak = current
  }, 5)
  try {
    const rendered = await renderDocumentPdf(sample(lines), {
      ...defaultDesignFor('modern'),
      show: { ...defaultDesignFor('modern').show, acceptance: false, qr: false },
    })
    const after = process.memoryUsage()
    if (after.rss > peak.rss) peak = after
    if (after.heapUsed > peak.heapUsed) peak = { ...peak, heapUsed: after.heapUsed }
    if (after.external > peak.external) peak = { ...peak, external: after.external }
    return {
      lines,
      durationMs: rendered.durationMs,
      pdfBytes: rendered.buffer.byteLength,
      cacheHit: rendered.cacheHit,
      rssBeforeBytes: before.rss,
      rssPeakBytes: peak.rss,
      rssPeakDeltaBytes: Math.max(0, peak.rss - before.rss),
      heapPeakDeltaBytes: Math.max(0, peak.heapUsed - before.heapUsed),
      externalPeakDeltaBytes: Math.max(0, peak.external - before.external),
      rssAfterBytes: after.rss,
      rssRetainedDeltaBytes: after.rss - before.rss,
    }
  } finally { clearInterval(interval) }
}

const results = []
for (const count of [1, 100]) results.push(await profile(count))
process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2)}\n`)
