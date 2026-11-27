/**
 * PDF render worker (docs/DOCUMENT_DESIGN_PLAN.md, Phase 6).
 *
 * @react-pdf/renderer 4.9.2 leaks a little memory on every render: each call creates a fresh root
 * whose cache is reference-counted and never released, so the JavaScript heap grows steadily with
 * the number of documents rendered and nothing in the library frees it. Measured on Node 22 with
 * this project's templates: about 210 KB per one-line document and about 450 KB per twenty-line
 * document, still growing after thousands of renders. A long-lived API process would therefore
 * climb until the container is restarted.
 *
 * The renderer is not injected into the customer flow as a one-off concern: it is part of every
 * quote, invoice and receipt. So this worker runs the renderer in its own process and is recycled
 * once it has rendered MAX_RENDERS_PER_PROCESS documents. Recycling is invisible to callers: the
 * parent (pdf-worker-client.ts) queues requests and starts a replacement worker, and no HTTP request
 * is interrupted.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   parent -> worker : { id, data, design }
 *   worker -> parent : { id, ok: true, base64, usedFallback, durationMs } | { id, ok: false, error }
 * Anything the worker writes to stderr is passed through to the API log as-is.
 */
import { createInterface } from 'node:readline'
import { renderDocumentPdf } from './pdf-service.js'
import type { DocumentDesign } from './document-design.js'
import type { PdfData } from './document-pdf.js'

const MAX_RENDERS = Number(process.env.PDF_WORKER_MAX_RENDERS ?? 150)

type RenderRequest = { id: number; data: PdfData; design: DocumentDesign }

let rendered = 0
let draining = false

function reply(payload: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function shutdown(code: number) {
  // The parent restarts the worker on exit; give stdout a moment to flush first.
  process.stdout.write('', () => process.exit(code))
}

// Signals to the parent that the renderer is loaded and the worker accepts requests.
reply({ ready: true, pid: process.pid, maxRenders: MAX_RENDERS })

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let request: RenderRequest
  try {
    request = JSON.parse(line) as RenderRequest
  } catch {
    console.error(JSON.stringify({ event: 'document_pdf_worker_bad_request', reason: 'unparseable line' }))
    return
  }
  void (async () => {
    if (draining) return
    draining = true
    try {
      const result = await renderDocumentPdf(request.data, request.design)
      rendered += 1
      reply({
        id: request.id,
        ok: true,
        base64: result.buffer.toString('base64'),
        usedFallback: result.usedFallback,
        durationMs: result.durationMs,
        cacheHit: result.cacheHit,
      })
    } catch (error) {
      reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : 'Unknown PDF render error.' })
    } finally {
      draining = false
      if (rendered >= MAX_RENDERS) {
        // Every response for this batch has been written before the process is replaced.
        console.error(JSON.stringify({ event: 'document_pdf_worker_recycle', rendered }))
        shutdown(0)
      }
    }
  })()
})

lines.on('close', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
