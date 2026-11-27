import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PdfRenderClient } from '../src/pdf-worker-client.js'
import { defaultDesignFor } from '../src/document-design.js'
import type { PdfData } from '../src/document-pdf.js'

const design = defaultDesignFor()

function quote(index: number): PdfData {
  return {
    kind: 'quote', documentNumber: `QT-${index}`, createdAt: '2026-11-27T00:00:00.000Z', currency: 'KES',
    subtotal: 100, taxTotal: 16, total: 116,
    lines: [{ description: 'Service', quantity: 1, unit: 'job', unitPrice: 100, taxRate: 16, amount: 100 }],
    customer: { name: 'Client' }, business: { name: 'Business' },
  }
}

/**
 * Capture what the client writes to stderr while `body` runs.
 *
 * The client reports worker problems on stderr, so this is where a protocol regression shows up.
 */
async function captureStderr(body: () => Promise<void>) {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    await body()
  } finally {
    process.stderr.write = original
  }
  return lines.join('')
}

// These tests start real worker processes. They use a small render budget so the recycle path runs.
describe('PDF render worker client', () => {
  it('renders through a worker process and recycles it without losing requests', async () => {
    const client = new PdfRenderClient()
    try {
      const first = await client.render(quote(1), design)
      expect(first.buffer.subarray(0, 5).toString()).toBe('%PDF-')
      expect(first.buffer.byteLength).toBeGreaterThan(1000)
      expect(client.stats().workerEnabled).toBe(true)
      expect(client.stats().running).toBe(true)
      // Many renders in sequence: each request must settle, even across a worker replacement.
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => client.render(quote(index + 2), design)))
      for (const result of results) expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    } finally {
      await client.dispose()
    }
  }, 120_000)

  it('serves requests from the in-process renderer when the worker cannot start', async () => {
    const previous = process.env.PDF_WORKER_ENTRY
    process.env.PDF_WORKER_ENTRY = 'does-not-exist.js'
    // Force the client down the tsx path so the bogus entry is actually used.
    const client = new PdfRenderClient()
    try {
      const result = await client.render(quote(99), design)
      expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
      expect(client.stats().workerEnabled).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.PDF_WORKER_ENTRY
      else process.env.PDF_WORKER_ENTRY = previous
      await client.dispose()
    }
  }, 120_000)

  it('refuses new work after shutdown and never leaves a caller waiting', async () => {
    const client = new PdfRenderClient()
    await client.render(quote(7), design)
    await client.dispose()
    expect(client.stats().running).toBe(false)
    await expect(client.render(quote(8), design)).rejects.toThrow(/shutting down/)
  }, 60_000)

  // Regression: the render telemetry used to be written to stdout. In the worker, stdout is the
  // newline-delimited JSON protocol channel, so every render injected a log line into the parent's
  // protocol stream. The parent could not match those lines to a request and logged
  // `document_pdf_worker_unexpected_reply` once per render. The telemetry now goes to stderr.
  it('keeps the protocol channel free of render telemetry', async () => {
    const client = new PdfRenderClient()
    const stderr = await captureStderr(async () => {
      try {
        const result = await client.render(quote(11), design)
        expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
      } finally {
        await client.dispose()
      }
    })
    expect(stderr).not.toContain('document_pdf_worker_unexpected_reply')
    expect(stderr).not.toContain('document_pdf_worker_ignored_output')
  }, 120_000)

  // The same regression, asserted at the source rather than at its symptom: every line the worker
  // writes to stdout must be a protocol message. A log line here is what produced the stray
  // `unexpected_reply` warnings, so this catches the cause even while Layer 2 hides the symptom.
  it('writes only protocol messages to the worker stdout channel', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const entry = resolve(here, '../src/pdf-worker.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'pipe'] })

    const stdoutLines: string[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) stdoutLines.push(line)
      }
    })

    try {
      // Wait for the ready line before sending a request.
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('The worker never signalled readiness.')), 60_000)
        child.stdout.on('data', () => {
          if (stdoutLines.some((line) => line.includes('"ready":true'))) {
            clearTimeout(timer)
            resolveReady()
          }
        })
        child.on('error', rejectReady)
      })

      child.stdin.write(`${JSON.stringify({ id: 1, data: quote(21), design })}\n`)
      await new Promise<void>((resolveReply) => {
        const timer = setTimeout(() => resolveReply(), 60_000)
        child.stdout.on('data', () => {
          if (stdoutLines.some((line) => line.includes('"id":1'))) {
            clearTimeout(timer)
            resolveReply()
          }
        })
      })

      expect(stdoutLines.length).toBeGreaterThan(0)
      for (const line of stdoutLines) {
        const message = JSON.parse(line) as Record<string, unknown>
        const isReady = message.ready === true
        const isReply = typeof message.id === 'number' && typeof message.ok === 'boolean'
        expect(
          isReady || isReply,
          `The worker wrote a non-protocol line to stdout: ${line.slice(0, 200)}`,
        ).toBe(true)
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 120_000)
})
