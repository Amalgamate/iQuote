// Document design settings (docs/DOCUMENT_DESIGN_PLAN.md, Phase 1).
//
// Pure functions with no database, framework or network dependency. The settings API validates
// with `validateDocumentDesign`; the PDF renderer reads with `resolveDesign`, which never throws.
//
// Every value is checked against an allow-list. Unknown keys are rejected. Template layout presets
// below mirror the themes in web/src/pdf/themes.ts; keep the two in step until the server renderer
// shares one source.

import { templateAllowed, type DocumentTemplateKey, type Entitlements } from './plans.js'

export const DESIGN_VERSION = 1

export const TEMPLATE_KEYS = ['classic', 'modern', 'minimal', 'bold', 'compact'] as const satisfies readonly DocumentTemplateKey[]
export const DEFAULT_TEMPLATE: DocumentTemplateKey = 'modern'

export const HEADERS = ['plain', 'band', 'dark'] as const
export const TABLES = ['lined', 'striped', 'boxed', 'minimal'] as const
export const TOTALS = ['wash', 'solid', 'rule'] as const
export const TYPEFACES = ['sans', 'serif'] as const
export const SPACINGS = ['comfortable', 'compact'] as const

export const DEFAULT_BRAND_COLOR = '#1a5c3f'
export const LOGO_SCALE_MIN = 50
export const LOGO_SCALE_MAX = 150
export const LOGO_SCALE_DEFAULT = 100
/** Largest accepted design, measured as JSON text. Real designs are well under 1 KB plus terms. */
export const MAX_DESIGN_JSON_LENGTH = 8000

export const TEXT_LIMITS = {
  quoteTitle: 40,
  invoiceTitle: 40,
  receiptTitle: 40,
  footer: 200,
  terms: 2000,
} as const

export type DocumentDesign = {
  version: typeof DESIGN_VERSION
  template: DocumentTemplateKey
  brandColor: string
  typeface: (typeof TYPEFACES)[number]
  header: (typeof HEADERS)[number]
  table: (typeof TABLES)[number]
  total: (typeof TOTALS)[number]
  spacing: (typeof SPACINGS)[number]
  logo: { scale: number }
  show: {
    tax: boolean
    unit: boolean
    totalInWords: boolean
    kraPin: boolean
    paymentBox: boolean
    qr: boolean
    terms: boolean
    acceptance: boolean
  }
  text: {
    quoteTitle: string
    invoiceTitle: string
    receiptTitle: string
    footer: string
    terms: string
  }
  payment: { paybill: string; till: string }
  email: { attachPdf: boolean }
}

type Layout = Pick<DocumentDesign, 'typeface' | 'header' | 'table' | 'total' | 'spacing'>

export const TEMPLATE_PRESETS: Record<DocumentTemplateKey, Layout> = {
  classic: { typeface: 'serif', header: 'plain', table: 'boxed', total: 'rule', spacing: 'comfortable' },
  modern: { typeface: 'sans', header: 'band', table: 'striped', total: 'solid', spacing: 'comfortable' },
  minimal: { typeface: 'sans', header: 'plain', table: 'minimal', total: 'rule', spacing: 'comfortable' },
  bold: { typeface: 'sans', header: 'dark', table: 'striped', total: 'solid', spacing: 'comfortable' },
  compact: { typeface: 'sans', header: 'plain', table: 'lined', total: 'wash', spacing: 'compact' },
}

const DEFAULT_SHOW: DocumentDesign['show'] = {
  tax: true,
  unit: true,
  totalInWords: true,
  kraPin: true,
  paymentBox: true,
  qr: true,
  terms: true,
  acceptance: true,
}

const DEFAULT_TEXT: DocumentDesign['text'] = {
  quoteTitle: 'Quotation',
  invoiceTitle: 'Invoice',
  receiptTitle: 'Receipt',
  footer: 'Thank you for your business.',
  terms: '',
}

/** A complete design for a template: its layout preset plus every default. Returns fresh objects each call. */
export function defaultDesignFor(template: DocumentTemplateKey = DEFAULT_TEMPLATE): DocumentDesign {
  return {
    version: DESIGN_VERSION,
    template,
    brandColor: DEFAULT_BRAND_COLOR,
    ...TEMPLATE_PRESETS[template],
    logo: { scale: LOGO_SCALE_DEFAULT },
    show: { ...DEFAULT_SHOW },
    text: { ...DEFAULT_TEXT },
    payment: { paybill: '', till: '' },
    email: { attachPdf: true },
  }
}

export type DesignResult = { ok: true; design: DocumentDesign } | { ok: false; errors: string[] }

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

const HEX_COLOUR = /^#[0-9a-f]{6}$/i
// Paybill and till numbers are 5 to 7 digits.
const MERCHANT_NUMBER = /^\d{5,7}$/
// Control characters other than tab, line feed and carriage return.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function rejectUnknown(obj: Obj, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path ? `${path}.` : ''}${key} is not a recognised setting.`)
  }
}

function section(value: unknown, path: string, errors: string[]): Obj {
  if (value === undefined) return {}
  if (!isObj(value)) {
    errors.push(`${path} must be an object.`)
    return {}
  }
  return value
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, path: string, errors: string[]): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  errors.push(`${path} must be one of: ${allowed.join(', ')}.`)
  return fallback
}

function pickBool(value: unknown, fallback: boolean, path: string, errors: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  errors.push(`${path} must be true or false.`)
  return fallback
}

function pickText(value: unknown, fallback: string, max: number, multiline: boolean, path: string, errors: string[]): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    errors.push(`${path} must be text.`)
    return fallback
  }
  const text = value.trim()
  if (CONTROL_CHARS.test(text) || (!multiline && /[\r\n]/.test(text))) {
    errors.push(`${path} contains characters that are not allowed.`)
    return fallback
  }
  if (text.length > max) {
    errors.push(`${path} must be at most ${max} characters.`)
    return fallback
  }
  return text
}

function pickMerchantNumber(value: unknown, path: string, errors: string[]): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    errors.push(`${path} must be digits only.`)
    return ''
  }
  const text = value.trim()
  if (text === '') return ''
  if (!MERCHANT_NUMBER.test(text)) {
    errors.push(`${path} must be 5 to 7 digits.`)
    return ''
  }
  return text
}

const TOP_KEYS = ['version', 'template', 'brandColor', 'typeface', 'header', 'table', 'total', 'spacing', 'logo', 'show', 'text', 'payment', 'email'] as const
const SHOW_KEYS = ['tax', 'unit', 'totalInWords', 'kraPin', 'paymentBox', 'qr', 'terms', 'acceptance'] as const
const TEXT_KEYS = ['quoteTitle', 'invoiceTitle', 'receiptTitle', 'footer', 'terms'] as const

/**
 * Validate design settings from a request. Missing keys take their defaults, and the layout keys
 * (typeface, header, table, total, spacing) default to the chosen template's preset. All problems are
 * reported together. This checks values only; plan limits are applied separately by `applyPlanLimits`.
 */
export function validateDocumentDesign(input: unknown): DesignResult {
  if (!isObj(input)) return { ok: false, errors: ['The design must be an object.'] }

  let size: number
  try {
    size = JSON.stringify(input).length
  } catch {
    return { ok: false, errors: ['The design could not be read.'] }
  }
  if (size > MAX_DESIGN_JSON_LENGTH) return { ok: false, errors: ['The design is too large.'] }

  const errors: string[] = []
  rejectUnknown(input, TOP_KEYS, '', errors)

  if (input.version !== undefined && input.version !== DESIGN_VERSION) errors.push(`version must be ${DESIGN_VERSION}.`)

  const template = pickEnum<DocumentTemplateKey>(input.template, TEMPLATE_KEYS, DEFAULT_TEMPLATE, 'template', errors)
  const preset = TEMPLATE_PRESETS[template]

  let brandColor = DEFAULT_BRAND_COLOR
  if (input.brandColor !== undefined) {
    if (typeof input.brandColor === 'string' && HEX_COLOUR.test(input.brandColor)) brandColor = input.brandColor.toLowerCase()
    else errors.push('brandColor must be a 6-digit hex colour such as #1a5c3f.')
  }

  const logoInput = section(input.logo, 'logo', errors)
  rejectUnknown(logoInput, ['scale'], 'logo', errors)
  let scale = LOGO_SCALE_DEFAULT
  if (logoInput.scale !== undefined) {
    if (typeof logoInput.scale === 'number' && Number.isFinite(logoInput.scale)) {
      scale = Math.min(LOGO_SCALE_MAX, Math.max(LOGO_SCALE_MIN, Math.round(logoInput.scale)))
    } else {
      errors.push('logo.scale must be a number.')
    }
  }

  const showInput = section(input.show, 'show', errors)
  rejectUnknown(showInput, SHOW_KEYS, 'show', errors)
  const show = { ...DEFAULT_SHOW }
  for (const key of SHOW_KEYS) show[key] = pickBool(showInput[key], DEFAULT_SHOW[key], `show.${key}`, errors)

  const textInput = section(input.text, 'text', errors)
  rejectUnknown(textInput, TEXT_KEYS, 'text', errors)
  const text = { ...DEFAULT_TEXT }
  for (const key of TEXT_KEYS) {
    text[key] = pickText(textInput[key], DEFAULT_TEXT[key], TEXT_LIMITS[key], key === 'terms', `text.${key}`, errors)
  }

  const paymentInput = section(input.payment, 'payment', errors)
  rejectUnknown(paymentInput, ['paybill', 'till'], 'payment', errors)

  const emailInput = section(input.email, 'email', errors)
  rejectUnknown(emailInput, ['attachPdf'], 'email', errors)

  const design: DocumentDesign = {
    version: DESIGN_VERSION,
    template,
    brandColor,
    typeface: pickEnum(input.typeface, TYPEFACES, preset.typeface, 'typeface', errors),
    header: pickEnum(input.header, HEADERS, preset.header, 'header', errors),
    table: pickEnum(input.table, TABLES, preset.table, 'table', errors),
    total: pickEnum(input.total, TOTALS, preset.total, 'total', errors),
    spacing: pickEnum(input.spacing, SPACINGS, preset.spacing, 'spacing', errors),
    logo: { scale },
    show,
    text,
    payment: {
      paybill: pickMerchantNumber(paymentInput.paybill, 'payment.paybill', errors),
      till: pickMerchantNumber(paymentInput.till, 'payment.till', errors),
    },
    email: { attachPdf: pickBool(emailInput.attachPdf, true, 'email.attachPdf', errors) },
  }

  return errors.length ? { ok: false, errors } : { ok: true, design }
}

/** The design a renderer should use for stored data. Missing or invalid data gives the default design; never throws. */
export function resolveDesign(stored: unknown): DocumentDesign {
  if (stored === null || stored === undefined) return defaultDesignFor()
  try {
    const result = validateDocumentDesign(stored)
    return result.ok ? result.design : defaultDesignFor()
  } catch {
    return defaultDesignFor()
  }
}

/**
 * Apply plan limits to a design. If the plan does not include the chosen template, fall back to the
 * default template's layout and report it so the UI can show an upgrade prompt. Colour, logo, wording
 * and the other options are not gated by plan and are kept. Never blocks sending or changes stored data.
 */
export function applyPlanLimits(design: DocumentDesign, entitlements: Entitlements): { design: DocumentDesign; templateLocked: boolean } {
  if (templateAllowed(entitlements, design.template)) return { design, templateLocked: false }
  const fallback = defaultDesignFor(DEFAULT_TEMPLATE)
  return {
    design: {
      ...design,
      template: fallback.template,
      typeface: fallback.typeface,
      header: fallback.header,
      table: fallback.table,
      total: fallback.total,
      spacing: fallback.spacing,
    },
    templateLocked: true,
  }
}
