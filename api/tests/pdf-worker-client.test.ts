import { describe, expect, it } from 'vitest'
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
})
