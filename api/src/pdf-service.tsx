import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { renderToBuffer } from '@react-pdf/renderer'
import sizeOf from 'image-size'
import QRCode from 'qrcode'
import { createPdfElement, type PdfBusiness, type PdfData } from './document-pdf.js'
import { applyPlanLimits, defaultDesignFor, resolveDesign, type DocumentDesign } from './document-design.js'
import { entitlementsFor } from './plans.js'

const MAX_CACHE_ENTRIES = 40
const MAX_CACHE_BYTES = 12 * 1024 * 1024
const MAX_LOGO_BYTES = 3 * 1024 * 1024
const MAX_LOGO_PIXELS = 24_000_000
const MAX_LOGO_DIMENSION = 6_000
const MAX_RENDER_MS = 10_000
const MAX_CONCURRENT = 3
const cache = new Map<string, Buffer>()
let cacheBytes = 0
let activeRenders = 0

export function roundPdfMoney(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100 }

export type FrozenPdfSnapshot = {
  version: 1
  design: DocumentDesign
  business: Omit<PdfBusiness, 'logoData'> & { logoUrl?: string | null }
}

export function freezePdfSnapshot(design: DocumentDesign, business: PdfBusiness, logoUrl?: string | null): FrozenPdfSnapshot {
  return {
    version: 1,
    design,
    business: {
      name: business.name, email: business.email, phone: business.phone, country: business.country,
      website: business.website, address: business.address, kraPin: business.kraPin, vatNumber: business.vatNumber, logoUrl: logoUrl ?? null,
    },
  }
}

export function resolvePdfSnapshot(snapshot: unknown, currentBusiness: PdfBusiness, currentLogoUrl?: string | null) {
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    const value = snapshot as Record<string, unknown>
    if (value.design && typeof value.design === 'object') {
      const savedBusiness = typeof value.business === 'object' && value.business !== null && !Array.isArray(value.business)
        ? value.business as Partial<FrozenPdfSnapshot['business']>
        : {}
      const { logoUrl: savedLogoUrl, ...savedDetails } = savedBusiness
      return {
        design: resolveDesign(value.design),
        business: { ...currentBusiness, ...savedDetails, name: savedDetails.name || currentBusiness.name, logoData: null },
        logoUrl: Object.prototype.hasOwnProperty.call(savedBusiness, 'logoUrl') ? savedLogoUrl ?? null : currentLogoUrl ?? null,
      }
    }
  }
  // Phase 1 backfills stored the design object directly. Keep reading those rows as a legacy format.
  return { design: resolveDesign(snapshot), business: { ...currentBusiness, logoData: null }, logoUrl: currentLogoUrl ?? null }
}

export function freezeReceiptBalance(snapshot: unknown, balanceDue: number) {
  const base = typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : { version: 1, design: snapshot }
  return { ...base, receipt: { balanceDue: roundPdfMoney(balanceDue) } }
}

export function readReceiptBalance(snapshot: unknown, fallback: number) {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return fallback
  const receipt = (snapshot as Record<string, unknown>).receipt
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return fallback
  const value = Number((receipt as Record<string, unknown>).balanceDue)
  return Number.isFinite(value) && value >= 0 ? roundPdfMoney(value) : fallback
}

export function resolveEffectiveDesign(saved: unknown, plan: string | null | undefined, status: string | null | undefined): DocumentDesign {
  const normalized = resolveDesign(saved)
  return applyPlanLimits(normalized, entitlementsFor(plan, status)).design
}

export async function loadPdfLogo(logoUrl: string | null | undefined, uploadsDir: string): Promise<string | null> {
  if (!logoUrl || !logoUrl.startsWith('/uploads/')) return null
  const relativePath = logoUrl.slice('/uploads/'.length)
  if (!relativePath || relativePath.includes('..') || relativePath.includes('\\') || relativePath.startsWith('/')) return null
  const root = resolve(uploadsDir)
  const absolutePath = resolve(root, relativePath)
  if (!absolutePath.startsWith(`${root}${sep}`)) return null
  const extension = extname(absolutePath).toLowerCase()
  const mime = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : null
  if (!mime) return null
  try {
    const fileStat = await stat(absolutePath)
    if (fileStat.size <= 0 || fileStat.size > MAX_LOGO_BYTES) return null
    const bytes = await readFile(absolutePath)
    const dimensions = sizeOf(bytes)
    if (!dimensions.width || !dimensions.height || dimensions.width > MAX_LOGO_DIMENSION || dimensions.height > MAX_LOGO_DIMENSION || dimensions.width * dimensions.height > MAX_LOGO_PIXELS) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch { return null }
}

export function withLogo(data: PdfData, logoData: string | null): PdfData {
  return { ...data, business: { ...data.business, logoData } }
}

export async function makeQrDataUrl(data: PdfData, design: DocumentDesign): Promise<string | undefined> {
  if (!design.show.qr || !('publicUrl' in data) || !data.publicUrl) return undefined
  try { return await QRCode.toDataURL(data.publicUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240, color: { dark: design.brandColor, light: '#FFFFFF' } }) }
  catch { return undefined }
}

function cacheKey(data: PdfData, design: DocumentDesign, qr?: string) {
  return createHash('sha256').update(JSON.stringify({ data, design, qr: qr ? createHash('sha256').update(qr).digest('hex') : null })).digest('hex')
}

function addCacheEntry(key: string, buffer: Buffer) {
  if (buffer.byteLength > MAX_CACHE_BYTES) return
  if (cache.has(key)) { cacheBytes -= cache.get(key)!.byteLength; cache.delete(key) }
  while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + buffer.byteLength > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cacheBytes -= cache.get(oldest)!.byteLength
    cache.delete(oldest)
  }
  cache.set(key, buffer)
  cacheBytes += buffer.byteLength
}

async function acquireRenderSlot() {
  if (activeRenders >= MAX_CONCURRENT) throw new Error('The PDF renderer is busy. Please try again shortly.')
  activeRenders += 1
}
function releaseRenderSlot() { activeRenders = Math.max(0, activeRenders - 1) }

async function renderOnce(data: PdfData, design: DocumentDesign, qr: string | undefined, remainingMs: number): Promise<Buffer> {
  await acquireRenderSlot()
  const rendering = renderToBuffer(createPdfElement(data, design, qr)).finally(releaseRenderSlot)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PDF rendering exceeded the 10 second time limit.')), remainingMs) })
  try { return await Promise.race([rendering, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

export async function renderDocumentPdf(data: PdfData, design: DocumentDesign): Promise<{ buffer: Buffer; usedFallback: boolean; durationMs: number; cacheHit: boolean }> {
  const qr = await makeQrDataUrl(data, design)
  const key = cacheKey(data, design, qr)
  const hit = cache.get(key)
  if (hit) {
    console.info(JSON.stringify({ event: 'document_pdf_render', kind: data.kind, cacheHit: true, usedFallback: false, durationMs: 0, bytes: hit.byteLength }))
    return { buffer: hit, usedFallback: false, durationMs: 0, cacheHit: true }
  }
  const started = Date.now()
  try {
    const buffer = await renderOnce(data, design, qr, MAX_RENDER_MS)
    addCacheEntry(key, buffer)
    const durationMs = Date.now() - started
    console.info(JSON.stringify({ event: 'document_pdf_render', kind: data.kind, cacheHit: false, usedFallback: false, durationMs, bytes: buffer.byteLength }))
    return { buffer, usedFallback: false, durationMs, cacheHit: false }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'document_pdf_render_fallback', kind: data.kind, durationMs: Date.now() - started, reason: error instanceof Error ? error.message : 'Unknown PDF render error.' }))
    const remaining = MAX_RENDER_MS - (Date.now() - started)
    if (remaining <= 0) throw error
    const fallbackDesign = defaultDesignFor('modern')
    const safeData = { ...data, business: { ...data.business, logoData: null } } as PdfData
    const buffer = await renderOnce(safeData, fallbackDesign, undefined, remaining)
    const durationMs = Date.now() - started
    console.info(JSON.stringify({ event: 'document_pdf_render', kind: data.kind, cacheHit: false, usedFallback: true, durationMs, bytes: buffer.byteLength }))
    return { buffer, usedFallback: true, durationMs, cacheHit: false }
  }
}

export function pdfFilename(value: string, kind: string) {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '-') || kind
  return `${kind}-${safe}.pdf`
}

export function quotePdfLineAmounts(lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; taxRate: number | null }>, subtotal: number) {
  const mapped = lines.map((line) => ({ ...line, amount: roundPdfMoney(line.quantity * line.unitPrice) }))
  if (mapped.length) {
    const printed = roundPdfMoney(mapped.reduce((sum, line) => sum + line.amount, 0))
    const difference = roundPdfMoney(subtotal - printed)
    mapped[mapped.length - 1].amount = roundPdfMoney(mapped[mapped.length - 1].amount + difference)
  }
  return mapped
}

export function designFromSnapshot(snapshot: unknown, currentDesign: unknown, plan: string | null | undefined, status: string | null | undefined) {
  if (snapshot) return resolveDesign(snapshot)
  return resolveEffectiveDesign(currentDesign, plan, status)
}

