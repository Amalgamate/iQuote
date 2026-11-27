/**
 * Client for the PDF render worker (see pdf-worker.ts for why the renderer runs out of process).
 *
 * One long-lived worker serves every render. It is replaced transparently after the worker has
 * rendered PDF_WORKER_MAX_RENDERS documents, so the library's per-render leak is never allowed to
 * accumulate. Requests wait in a single queue while a replacement starts, and every request settles
 * exactly once: success, a real render error, or a startup failure after PDF_WORKER_START_TIMEOUT_MS.
 *
 * If the worker cannot start at all, the client reports that once and keeps serving callers from the
 * in-process renderer, so downloads still work rather than failing for a whole deployment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDocumentPdf } from './pdf-service.js'
import type { DocumentDesign } from './document-design.js'
import type { PdfData } from './document-pdf.js'

const START_TIMEOUT_MS = Number(process.env.PDF_WORKER_START_TIMEOUT_MS ?? 20_000)
const MAX_RENDERS = Number(process.env.PDF_WORKER_MAX_RENDERS ?? 150)

export type RenderOutcome = {
  buffer: Buffer
  usedFallback: boolean
  durationMs: number
  cacheHit: boolean
}

type Pending = {
  id: number
  data: PdfData
  design: DocumentDesign
  resolve: (value: RenderOutcome) => void
  reject: (error: Error) => void
  settled: boolean
}

function log(entry: Record<string, unknown>) {
  console.error(JSON.stringify(entry))
}

export class PdfRenderClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private queue: Pending[] = []
  private inFlight: Pending | null = null
  private nextId = 1
  private stdoutBuffer = ''
  private disposed = false
  private workerDisabled = false
  private rendersSinceStart = 0

  /** Render outside the parent process. Falls back to the in-process renderer if the worker is unusable. */
  async render(data: PdfData, design: DocumentDesign): Promise<RenderOutcome> {
    if (this.workerDisabled) return renderDocumentPdf(data, design)
    try {
      await this.ensureReady()
    } catch (error) {
      if (!this.workerDisabled) {
        this.workerDisabled = true
        log({ event: 'document_pdf_worker_unavailable', message: error instanceof Error ? error.message : String(error) })
      }
      return renderDocumentPdf(data, design)
    }
    if (this.disposed) throw new Error('The PDF renderer is shutting down.')
    return new Promise<RenderOutcome>((resolveRequest, rejectRequest) => {
      this.queue.push({ id: this.nextId++, data, design, resolve: resolveRequest, reject: rejectRequest, settled: false })
      this.pump()
    })
  }

  /** Stop the worker. Used on shutdown so no orphan process is left behind. */
  async dispose() {
    this.disposed = true
    for (const entry of this.queue.splice(0)) this.settleReject(entry, new Error('The PDF renderer is shutting down.'))
    if (this.inFlight) this.settleReject(this.inFlight, new Error('The PDF renderer is shutting down.'))
    const child = this.child
    this.child = null
    this.ready = null
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, 2_000)
        child.once('exit', () => { clearTimeout(timer); resolveStop() })
      })
    }
  }

  /** Diagnostics for the health endpoint and tests. */
  stats() {
    return { workerEnabled: !this.workerDisabled, running: this.child !== null, queued: this.queue.length, inFlight: this.inFlight !== null, rendersSinceStart: this.rendersSinceStart }
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.rendersSinceStart = 0
    this.ready = this.start().catch((error: Error) => {
      // Clear the failed attempt so the scheduler falls back to the in-process renderer rather than
      // holding a rejected promise. A failed start is not retried: a broken worker would otherwise
      // spawn a process for every request.
      this.ready = null
      throw error
    })
    return this.ready
  }

  private start(): Promise<void> {
    return new Promise<void>((resolveReady, rejectStart) => {
      // Production runs compiled JavaScript (dist/pdf-worker.js). Development and tests run the
      // TypeScript entry through tsx, the same loader the rest of the API uses there.
      const here = fileURLToPath(import.meta.url)
      const compiled = here.endsWith('.js') ? resolve(dirname(here), 'pdf-worker.js') : null
      const source = resolve(dirname(here), 'pdf-worker.ts')
      const entry = process.env.PDF_WORKER_ENTRY ?? (compiled ?? source)
      const args = compiled && !process.env.PDF_WORKER_ENTRY ? [entry] : ['--import', 'tsx', entry]
      const child = spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PDF_WORKER_MAX_RENDERS: String(MAX_RENDERS) },
      }) as ChildProcessWithoutNullStreams

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.workerDisabled = true
        child.kill('SIGTERM')
        rejectStart(new Error(`The PDF worker did not start within ${START_TIMEOUT_MS} ms.`))
      }, START_TIMEOUT_MS)

      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.workerDisabled = true
        this.child = null
        this.ready = null
        rejectStart(new Error(message))
      }

      // Shutdown must not leave a request waiting on a worker that will never arrive.
      const onDisposed = setInterval(() => {
        if (!this.disposed) return
        clearInterval(onDisposed)
        fail('The PDF renderer is shutting down.')
        if (child.exitCode === null) child.kill('SIGTERM')
      }, 25)
      const stopDisposeWatch = () => clearInterval(onDisposed)
      child.once('exit', stopDisposeWatch)

      // The worker signals readiness by writing its start line before any render reply.
      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString('utf8')
        let index: number
        while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
          const line = this.stdoutBuffer.slice(0, index)
          this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
          if (!line.trim()) continue
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            log({ event: 'document_pdf_worker_bad_output', line: line.slice(0, 200) })
            continue
          }
          if (message.ready === true) {
            if (settled) continue
            settled = true
            clearTimeout(timer)
            this.child = child
            resolveReady()
            this.pump()
            continue
          }
          this.handleReply(message)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
      child.on('error', (error) => fail(`The PDF worker failed to start: ${error.message}`))
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (this.child === child) {
          this.child = null
          this.ready = null
          this.stdoutBuffer = ''
        }
        if (!settled) {
          fail(`The PDF worker exited before it was ready (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`)
          return
        }
        // A worker that exits mid-request has already lost that request; fail it so the caller can
        // fall back to sending the email without an attachment, then start a fresh worker on demand.
        if (this.inFlight) this.settleReject(this.inFlight, new Error(`The PDF worker exited unexpectedly (code ${code ?? 'none'}).`))
        log({ event: 'document_pdf_worker_exit', code, signal })
        if (!this.disposed) this.pump()
      })
    })
  }

  private handleReply(message: Record<string, unknown>) {
    const inFlight = this.inFlight
    if (!inFlight || message.id !== inFlight.id) {
      log({ event: 'document_pdf_worker_unexpected_reply', id: message.id })
      return
    }
    this.inFlight = null
    if (message.ok === true) {
      this.settleResolve(inFlight, {
        buffer: Buffer.from(String(message.base64 ?? ''), 'base64'),
        usedFallback: message.usedFallback === true,
        durationMs: Number(message.durationMs ?? 0),
        cacheHit: message.cacheHit === true,
      })
    } else {
      this.settleReject(inFlight, new Error(String(message.error ?? 'Unknown PDF render error.')))
    }
    this.pump()
  }

  private pump() {
    if (this.disposed || this.inFlight) return
    if (!this.child || !this.ready) {
      // Starting or restarting: requests wait in the queue rather than failing. A worker that failed
      // to start is never retried, so a broken deployment does not spawn processes in a loop.
      if (this.queue.length > 0 && !this.workerDisabled) this.ensureReady().catch(() => { /* handled in render() */ })
      return
    }
    const next = this.queue.shift()
    if (!next) return
    this.inFlight = next
    this.rendersSinceStart += 1
    this.child.stdin.write(`${JSON.stringify({ id: next.id, data: next.data, design: next.design })}\n`, (error) => {
      if (!error) return
      this.inFlight = null
      this.settleReject(next, new Error(`The PDF worker could not accept the request: ${error.message}`))
      this.pump()
    })
  }

  private settleResolve(entry: Pending, value: RenderOutcome) {
    if (entry.settled) return
    entry.settled = true
    entry.resolve(value)
  }

  private settleReject(entry: Pending, error: Error) {
    if (entry.settled) return
    entry.settled = true
    entry.reject(error)
  }
}

let shared: PdfRenderClient | null = null

/** The process-wide client. Kept separate from pdf-service so tests can construct their own. */
export function pdfRenderClient(): PdfRenderClient {
  if (!shared) shared = new PdfRenderClient()
  return shared
}
