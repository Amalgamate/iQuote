import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/pdf-service.js', () => ({
  loadPdfLogo: vi.fn().mockResolvedValue(null),
  pdfFilename: (number: string, kind: string) => `${kind}-${number.replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`,
  withLogo: (data: unknown) => data,
}))

import { defaultDesignFor } from '../src/document-design.js'
import type { PdfData } from '../src/document-pdf.js'
import type { PdfRenderClient } from '../src/pdf-worker-client.js'
import { MAX_EMAIL_PDF_BYTES, preparePdfEmailAttachment } from '../src/pdf-email-attachment.js'

const quote = {
  kind: 'quote', documentNumber: 'QT/42', createdAt: '2026-11-27T00:00:00.000Z', currency: 'KES',
  subtotal: 100, taxTotal: 16, total: 116, lines: [], customer: { name: 'Client' }, business: { name: 'Business' },
} as unknown as PdfData

const render = vi.fn()
const client = { render } as unknown as PdfRenderClient

describe('PDF email attachment preparation', () => {
  beforeEach(() => render.mockReset())

  it('does no PDF work when attachment is not requested or the feature flag is off', async () => {
    expect((await preparePdfEmailAttachment(false, true, quote, defaultDesignFor(), null, '/uploads', client)).attachments).toEqual([])
    const disabled = await preparePdfEmailAttachment(true, false, quote, defaultDesignFor(), null, '/uploads', client)
    expect(disabled.attachedPdf).toBe(false)
    expect(disabled.attachmentError).toMatch(/not enabled/)
    expect(render).not.toHaveBeenCalled()
  })

  it('returns a sanitized server-generated attachment', async () => {
    render.mockResolvedValue({ buffer: Buffer.from('%PDF-1.7'), usedFallback: false, durationMs: 5, cacheHit: false })
    const result = await preparePdfEmailAttachment(true, true, quote, defaultDesignFor(), null, '/uploads', client)
    expect(result.attachedPdf).toBe(true)
    expect(result.attachments[0].filename).toBe('quotation-QT-42.pdf')
    expect(Buffer.from(result.attachments[0].content, 'base64').toString()).toBe('%PDF-1.7')
    expect(result.pdfBytes).toBe(8)
  })

  it('sends without a PDF when the generated file is too large or rendering fails', async () => {
    render.mockResolvedValueOnce({ buffer: Buffer.alloc(MAX_EMAIL_PDF_BYTES + 1), usedFallback: false, durationMs: 5, cacheHit: false })
    const tooLarge = await preparePdfEmailAttachment(true, true, quote, defaultDesignFor(), null, '/uploads', client)
    expect(tooLarge.attachedPdf).toBe(false)
    expect(tooLarge.attachmentError).toMatch(/larger/)
    render.mockRejectedValueOnce(new Error('renderer unavailable'))
    const failed = await preparePdfEmailAttachment(true, true, quote, defaultDesignFor(), null, '/uploads', client)
    expect(failed.attachedPdf).toBe(false)
    expect(failed.attachmentError).toMatch(/could not be generated/)
  })
})
