import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import { defaultDesignFor } from '../src/document-design.js'
import { freezePdfSnapshot, loadPdfLogo, quotePdfLineAmounts, renderDocumentPdf, resolveEffectiveDesign, resolvePdfSnapshot } from '../src/pdf-service.js'
import type { PdfData } from '../src/document-pdf.js'

function sampleQuote(lines = 1): PdfData {
  const items = Array.from({ length: lines }, (_, index) => ({ description: `Service item ${index + 1} with a customer facing description`, quantity: 1, unit: 'job', unitPrice: 1000, taxRate: 16, amount: 1000 }))
  return {
    kind: 'quote', documentNumber: 'QT-TEST-0042', createdAt: '2026-11-27T10:00:00.000Z', currency: 'KES',
    subtotal: lines * 1000, taxTotal: lines * 160, total: lines * 1160, notes: 'Work begins after approval.', terms: 'Payment is due within 14 days.',
    lines: items, customer: { name: 'Sample Customer', email: 'customer@example.com', phone: '+254700000000' },
    business: { name: 'Example Services Ltd', email: 'hello@example.com', country: 'Kenya' },
  }
}

function pdfPageCount(pdf: Buffer) {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
}

function extractTextStreams(pdf: Buffer) {
  const source = pdf.toString('latin1')
  const text: string[] = []
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { text.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')) } catch { /* image and uncompressed streams are not text */ }
  }
  return [...text.join('\n').matchAll(/<([\da-f]+)>/gi)].map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join('')
}

describe('server document renderer', () => {
  it('rounds line values so their printed sum agrees with the subtotal', () => {
    const lines = quotePdfLineAmounts([
      { description: 'First', quantity: 3, unit: 'item', unitPrice: 5666.67, taxRate: 16 },
      { description: 'Second', quantity: 1, unit: 'item', unitPrice: 500, taxRate: 16 },
    ], 17500)
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(17500)
  })

  it('uses Modern when a stored template is unavailable on the current plan without changing its colour', () => {
    const saved = { ...defaultDesignFor('bold'), brandColor: '#123456' }
    const design = resolveEffectiveDesign(saved, 'STARTER', 'ACTIVE')
    expect(design.template).toBe('modern')
    expect(design.brandColor).toBe('#123456')
  })

  it('freezes business identity and logo path with the design snapshot', () => {
    const savedBusiness = { name: 'Before Brand Change', email: 'old@example.test', address: 'Old address', logoData: null }
    const frozen = freezePdfSnapshot(defaultDesignFor('classic'), savedBusiness, '/uploads/old-logo.png')
    const resolved = resolvePdfSnapshot(frozen, { name: 'New business name', email: 'new@example.test', logoData: null }, '/uploads/new-logo.png')
    expect(resolved.design.template).toBe('classic')
    expect(resolved.business.name).toBe('Before Brand Change')
    expect(resolved.business.email).toBe('old@example.test')
    expect(resolved.business.address).toBe('Old address')
    expect(resolved.logoUrl).toBe('/uploads/old-logo.png')
  })

  it.each(['modern', 'classic', 'minimal', 'bold', 'compact'] as const)('renders the %s design as a valid one-page PDF with its totals', async (template) => {
    const design = { ...defaultDesignFor(template), show: { ...defaultDesignFor(template).show, acceptance: false, qr: false } }
    const result = await renderDocumentPdf(sampleQuote(), design)
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdfPageCount(result.buffer)).toBe(1)
    const content = extractTextStreams(result.buffer)
    expect(content).toContain('QT-TEST-0042')
    expect(content).toContain('1,160.00')
    expect(result.usedFallback).toBe(false)
    expect(content).toBe(readFileSync(`../scripts/document-pdf-goldens/${template}.txt`, 'utf8'))
  }, 20_000)

  it('keeps the acceptance block attached to a short quote and paginates long tables', async () => {
    const short = await renderDocumentPdf(sampleQuote(3), { ...defaultDesignFor('modern'), show: { ...defaultDesignFor('modern').show, qr: false } })
    expect(pdfPageCount(short.buffer)).toBe(1)
    const long = await renderDocumentPdf(sampleQuote(100), { ...defaultDesignFor('modern'), show: { ...defaultDesignFor('modern').show, qr: false, acceptance: false } })
    expect(pdfPageCount(long.buffer)).toBeGreaterThan(1)
    expect(extractTextStreams(long.buffer).match(/DESCRIPTION/g)?.length ?? 0).toBeGreaterThan(1)
    expect(long.durationMs).toBeLessThan(10_000)
    expect(long.buffer.byteLength).toBeLessThan(1_000_000)
  }, 30_000)

  it('renders a very long item description without breaking the document', async () => {
    const quote = sampleQuote(1)
    if (quote.kind !== 'quote') throw new Error('Quote fixture expected.')
    quote.lines[0].description = 'Detailed installation and finishing work '.repeat(90)
    const result = await renderDocumentPdf(quote, { ...defaultDesignFor('modern'), show: { ...defaultDesignFor('modern').show, qr: false } })
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdfPageCount(result.buffer)).toBeGreaterThan(0)
  }, 20_000)

  it('rejects missing and oversized logos before embedding them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'iquote-pdf-logo-'))
    try {
      expect(await loadPdfLogo('/uploads/missing.png', directory)).toBeNull()
      const normalPng = await QRCode.toBuffer('iQuote logo', { width: 32 })
      await writeFile(join(directory, 'small.png'), normalPng)
      expect(await loadPdfLogo('/uploads/small.png', directory)).toMatch(/^data:image\/png;base64,/)
      const hugePng = Buffer.alloc(33)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(hugePng, 0)
      hugePng.writeUInt32BE(13, 8); hugePng.write('IHDR', 12, 'ascii')
      hugePng.writeUInt32BE(6001, 16); hugePng.writeUInt32BE(1, 20)
      hugePng[24] = 8; hugePng[25] = 6
      await writeFile(join(directory, 'wide.png'), hugePng)
      expect(await loadPdfLogo('/uploads/wide.png', directory)).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
