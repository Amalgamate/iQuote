/**
 * Concurrent render load test for the server PDF service (docs/DOCUMENT_DESIGN_PLAN.md, Phase 6).
 *
 * Fires a configurable number of simultaneous render requests and reports latency, failures,
 * peak process memory and how often the concurrency guard rejected a request. Every document is
 * unique, so the cache never answers and the run measures real rendering work.
 *
 *   node --expose-gc --import tsx scripts/load-document-pdf.tsx [requests] [lines] [concurrency] [waves]
 *
 * Defaults: 60 requests, 20 lines each, 10 at a time, 1 wave. The renderer allows 3 concurrent
 * renders, so a concurrency above 3 will produce "busy" rejections; that is the guard working, and
 * the summary separates those from real errors. Use several waves with a concurrency of 3 or less
 * to check that memory plateaus instead of growing without bound.
 */
import { defaultDesignFor } from '../src/document-design.js'
import { renderDocumentPdf } from '../src/pdf-service.js'
import type { PdfData } from '../src/document-pdf.js'

const REQUESTS = Number(process.argv[2] ?? 60)
const LINES = Number(process.argv[3] ?? 20)
const CONCURRENCY = Number(process.argv[4] ?? 10)
const WAVES = Math.max(1, Number(process.argv[5] ?? 1))

function sample(index: number, lines: number): PdfData {
  const items = Array.from({ length: lines }, (_, line) => ({
    description: `Load test line ${line + 1} for document ${index}`,
    quantity: 1,
    unit: 'job',
    unitPrice: 1000,
    taxRate: 16,
    amount: 1000,
  }))
  return {
    kind: 'quote',
    documentNumber: `LOAD-${index}`,
    createdAt: new Date().toISOString(),
    currency: 'KES',
    subtotal: lines * 1000,
    taxTotal: lines * 160,
    total: lines * 1160,
    lines: items,
    customer: { name: `Load Customer ${index}`, email: `customer${index}@example.test` },
    business: { name: 'iQuote Load Test', email: 'load@example.test', country: 'Kenya' },
  }
}

type Attempt = {
  index: number
  durationMs: number
  pdfBytes: number | null
  outcome: 'rendered' | 'busy' | 'error'
  message?: string
}

async function one(index: number): Promise<Attempt> {
  const started = performance.now()
  try {
    const rendered = await renderDocumentPdf(sample(index, LINES), defaultDesignFor('modern'))
    return { index, durationMs: Math.round(performance.now() - started), pdfBytes: rendered.buffer.byteLength, outcome: 'rendered' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const durationMs = Math.round(performance.now() - started)
    // The service rejects when more than three renders are already running. That is back-pressure.
    const busy = /busy/i.test(message)
    return { index, durationMs, pdfBytes: null, outcome: busy ? 'busy' : 'error', message }
  }
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return null
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[position]
}

async function runWave(waveIndex: number, counter: { next: number }) {
  const attempts: Attempt[] = []
  async function worker() {
    while (counter.next < REQUESTS) {
      const index = counter.next++
      attempts.push(await one(waveIndex * REQUESTS + index))
    }
  }
  const width = Math.max(1, Math.min(CONCURRENCY, REQUESTS))
  await Promise.all(Array.from({ length: width }, () => worker()))
  return attempts
}

global.gc?.()
const rssBefore = process.memoryUsage().rss
let rssPeak = rssBefore
const memoryTimer = setInterval(() => {
  const current = process.memoryUsage().rss
  if (current > rssPeak) rssPeak = current
}, 10)

const wallStart = performance.now()
const all: Attempt[] = []
const rssAfterWave: Array<{ wave: number; rssBytes: number }> = []

for (let wave = 0; wave < WAVES; wave++) {
  const attempts = await runWave(wave, { next: 0 })
  all.push(...attempts)
  global.gc?.()
  rssAfterWave.push({ wave: wave + 1, rssBytes: process.memoryUsage().rss })
}

clearInterval(memoryTimer)
const wallMs = Math.round(performance.now() - wallStart)
global.gc?.()
const rssAfter = process.memoryUsage().rss

const rendered = all.filter((a) => a.outcome === 'rendered')
const busy = all.filter((a) => a.outcome === 'busy')
const failed = all.filter((a) => a.outcome === 'error')
const durations = rendered.map((a) => a.durationMs).sort((a, b) => a - b)
const totalBytes = rendered.reduce((sum, a) => sum + (a.pdfBytes ?? 0), 0)
const growth = rssAfterWave.length > 1 ? rssAfterWave[rssAfterWave.length - 1].rssBytes - rssAfterWave[0].rssBytes : null

const summary = {
  node: process.version,
  platform: process.platform,
  settings: { requestsPerWave: REQUESTS, waves: WAVES, totalRequests: REQUESTS * WAVES, linesPerDocument: LINES, concurrency: CONCURRENCY },
  outcomes: { rendered: rendered.length, busy: busy.length, failed: failed.length },
  wallMs,
  latencyMs: {
    min: durations[0] ?? null,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    max: durations[durations.length - 1] ?? null,
  },
  throughputPerSecond: wallMs > 0 ? Number(((rendered.length / wallMs) * 1000).toFixed(2)) : null,
  pdfBytes: { total: totalBytes, average: rendered.length ? Math.round(totalBytes / rendered.length) : null },
  memory: {
    rssBeforeBytes: rssBefore,
    rssPeakBytes: rssPeak,
    rssPeakDeltaBytes: Math.max(0, rssPeak - rssBefore),
    rssAfterBytes: rssAfter,
    rssRetainedDeltaBytes: rssAfter - rssBefore,
    rssAfterWave,
    /** Growth between the first and last wave after a forced GC. Near zero means memory plateaus. */
    rssGrowthAcrossWavesBytes: growth,
  },
  failures: failed.map((a) => a.message),
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
process.exit(failed.length > 0 ? 1 : 0)
