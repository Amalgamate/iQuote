// AI quote drafting: the tool definition the model fills in, and the server-side
// validation that decides what is allowed through. Pure functions, no network,
// no database: easy to test, and the model's output is never trusted as-is.
//
// Core rule: the model may NOT invent prices. A price is accepted only if it
// comes from the business's own catalogue, or the user actually wrote that
// number in their message. Anything else is left blank and flagged for the user.

export type CatalogueItem = {
  id: string
  name: string
  unit: string
  defaultPrice: number
  defaultTaxRate: number | null
}

export type ValidationContext = {
  /** The exact text the user typed or dictated. Used to verify any price the model claims they gave. */
  userText: string
  catalogue: CatalogueItem[]
  /** Organisation default tax rate (percent), applied when a line has no specific rate. */
  defaultTaxRate: number
}

export type DraftLine = {
  description: string
  quantity: number
  unit: string
  unitPrice: number
  taxRate: number | null
  /** True when no trustworthy price was found; the user must fill it in before sending. */
  needsPrice: boolean
}

export type ProposalResult =
  | {
      ok: true
      customerName: string | null
      lines: DraftLine[]
      notes: string | null
      validDays: number | null
      assumptions: string[]
      questions: string[]
      warnings: string[]
    }
  | { ok: false; message: string }

export const MAX_LINES = 40
export const MAX_INPUT_CHARS = 2000

/** Tool definition in the Anthropic Messages API tool format. Force the model to call it. */
export const PROPOSE_QUOTE_TOOL = {
  name: 'propose_quote',
  description:
    'Propose a DRAFT quotation from the user\'s request. Never invent prices: set priceSource to "catalogue" with the catalogueItemId when an item matches the catalogue, "user" only when the user stated that exact price, otherwise "unknown" with unitPrice null. List anything you assumed in assumptions and anything you need to ask in questions.',
  input_schema: {
    type: 'object',
    properties: {
      customerName: { type: ['string', 'null'], description: 'Customer name exactly as the user said it, or null.' },
      lines: {
        type: 'array',
        maxItems: MAX_LINES,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unit: { type: 'string' },
            unitPrice: { type: ['number', 'null'] },
            priceSource: { type: 'string', enum: ['catalogue', 'user', 'unknown'] },
            catalogueItemId: { type: ['string', 'null'] },
          },
          required: ['description', 'quantity', 'priceSource'],
        },
      },
      notes: { type: ['string', 'null'] },
      validDays: { type: ['integer', 'null'], description: 'Days the quote stays valid, only if the user said so.' },
      assumptions: { type: 'array', items: { type: 'string' } },
      questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['lines'],
  },
} as const

/** Numbers written in free text: handles 2,500 and 5k (= 5000). */
export function numbersInText(text: string): number[] {
  const found: number[] = []
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?\b/g)) {
    const value = Number((match[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    found.push(match[2] ? value * 1000 : value)
  }
  return found
}

export function priceAppearsInText(text: string, price: number): boolean {
  return numbersInText(text).some((n) => Math.abs(n - price) < 0.005)
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function cleanStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => cleanText(item, maxLength)).filter((item): item is string => Boolean(item)).slice(0, maxItems)
}

export function validateProposal(input: unknown, context: ValidationContext): ProposalResult {
  if (!input || typeof input !== 'object') return { ok: false, message: 'The assistant returned an unreadable result.' }
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.lines)) return { ok: false, message: 'The assistant did not return any quote lines.' }
  if (raw.lines.length > MAX_LINES) return { ok: false, message: `Too many lines (maximum ${MAX_LINES}). Try a shorter request.` }

  const catalogueById = new Map(context.catalogue.map((item) => [item.id, item]))
  const warnings: string[] = []
  const lines: DraftLine[] = []

  for (const [index, entry] of raw.lines.entries()) {
    const position = index + 1
    if (!entry || typeof entry !== 'object') {
      warnings.push(`Line ${position} was skipped because it could not be read.`)
      continue
    }
    const line = entry as Record<string, unknown>

    const description = cleanText(line.description, 250)
    if (!description) {
      warnings.push(`Line ${position} was skipped because it had no description.`)
      continue
    }
    const quantity = Number(line.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      warnings.push(`"${description}" was skipped because its quantity was not valid.`)
      continue
    }

    const catalogueItem = typeof line.catalogueItemId === 'string' ? catalogueById.get(line.catalogueItemId) : undefined
    const unit = cleanText(line.unit, 24) ?? catalogueItem?.unit ?? 'unit'
    let unitPrice: number | null = null
    let taxRate: number | null = context.defaultTaxRate

    if (catalogueItem) {
      // Catalogue wins: the business's own price, never the model's.
      unitPrice = catalogueItem.defaultPrice
      taxRate = catalogueItem.defaultTaxRate ?? context.defaultTaxRate
    } else if (line.priceSource === 'user') {
      const claimed = Number(line.unitPrice)
      if (Number.isFinite(claimed) && claimed >= 0 && claimed <= 1_000_000_000 && priceAppearsInText(context.userText, claimed)) {
        unitPrice = claimed
      } else {
        warnings.push(`The price for "${description}" was not found in your message, so it was left blank.`)
      }
    }

    lines.push({ description, quantity, unit, unitPrice: unitPrice ?? 0, taxRate, needsPrice: unitPrice === null })
  }

  if (lines.length === 0) return { ok: false, message: 'No usable quote lines were found. Try describing the work and quantities.' }

  const validDays = typeof raw.validDays === 'number' && Number.isInteger(raw.validDays) && raw.validDays >= 1 && raw.validDays <= 365 ? raw.validDays : null

  return {
    ok: true,
    customerName: cleanText(raw.customerName, 200),
    lines,
    notes: cleanText(raw.notes, 2000),
    validDays,
    assumptions: cleanStringList(raw.assumptions, 5, 200),
    questions: cleanStringList(raw.questions, 5, 200),
    warnings,
  }
}
