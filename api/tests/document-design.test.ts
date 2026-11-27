import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPLATE,
  HEADERS,
  LOGO_SCALE_MAX,
  LOGO_SCALE_MIN,
  MAX_DESIGN_JSON_LENGTH,
  SPACINGS,
  TABLES,
  TEMPLATE_KEYS,
  TEMPLATE_PRESETS,
  TOTALS,
  TYPEFACES,
  applyPlanLimits,
  defaultDesignFor,
  resolveDesign,
  validateDocumentDesign,
} from '../src/document-design'
import { PLAN_ENTITLEMENTS, templateAllowed } from '../src/plans'

function ok(input: unknown) {
  const result = validateDocumentDesign(input)
  if (!result.ok) throw new Error(`expected valid, got: ${result.errors.join(' | ')}`)
  return result.design
}

function errorsOf(input: unknown) {
  const result = validateDocumentDesign(input)
  if (result.ok) throw new Error('expected invalid')
  return result.errors
}

describe('defaults and presets', () => {
  it('accepts an empty design and fills in the default design', () => {
    expect(ok({})).toEqual(defaultDesignFor())
    expect(DEFAULT_TEMPLATE).toBe('modern')
  })

  it('round-trips a complete design for every template', () => {
    for (const template of TEMPLATE_KEYS) expect(ok(defaultDesignFor(template))).toEqual(defaultDesignFor(template))
  })

  it('has a preset for every template, using only allowed values', () => {
    for (const template of TEMPLATE_KEYS) {
      const preset = TEMPLATE_PRESETS[template]
      expect(TYPEFACES).toContain(preset.typeface)
      expect(HEADERS).toContain(preset.header)
      expect(TABLES).toContain(preset.table)
      expect(TOTALS).toContain(preset.total)
      expect(SPACINGS).toContain(preset.spacing)
    }
  })

  it('takes layout defaults from the chosen template', () => {
    const bold = ok({ template: 'bold' })
    expect(bold).toMatchObject({ header: 'dark', table: 'striped', total: 'solid' })
    expect(ok({ template: 'compact' }).spacing).toBe('compact')
    expect(ok({ template: 'classic' }).typeface).toBe('serif')
  })

  it('lets explicit layout choices override the preset', () => {
    expect(ok({ template: 'bold', header: 'plain', table: 'minimal' })).toMatchObject({ header: 'plain', table: 'minimal' })
  })

  it('returns fresh objects so callers cannot change the defaults', () => {
    const first = defaultDesignFor()
    first.show.tax = false
    first.text.footer = 'changed'
    expect(defaultDesignFor().show.tax).toBe(true)
    expect(defaultDesignFor().text.footer).toBe('Thank you for your business.')
  })
})

describe('rejecting bad input', () => {
  it('rejects anything that is not an object', () => {
    for (const input of [null, undefined, 'modern', 42, [], true]) expect(validateDocumentDesign(input).ok).toBe(false)
  })

  it('rejects unknown keys at every level', () => {
    expect(errorsOf({ colour: 'red' })).toContain('colour is not a recognised setting.')
    expect(errorsOf({ logo: { scale: 100, width: 5 } })).toContain('logo.width is not a recognised setting.')
    expect(errorsOf({ show: { sparkles: true } })).toContain('show.sparkles is not a recognised setting.')
    expect(errorsOf({ text: { header: 'x' } })).toContain('text.header is not a recognised setting.')
    expect(errorsOf({ payment: { account: '12345' } })).toContain('payment.account is not a recognised setting.')
    expect(errorsOf({ email: { subject: 'x' } })).toContain('email.subject is not a recognised setting.')
  })

  it('rejects a __proto__ key arriving from JSON', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}}')
    expect(validateDocumentDesign(parsed).ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects other versions and unknown enum values', () => {
    expect(errorsOf({ version: 2 })).toContain('version must be 1.')
    expect(errorsOf({ template: 'neon' })[0]).toContain('template must be one of')
    expect(errorsOf({ header: 'huge' })[0]).toContain('header must be one of')
    expect(errorsOf({ spacing: 7 })[0]).toContain('spacing must be one of')
  })

  it('reports every problem at once', () => {
    expect(errorsOf({ template: 'neon', brandColor: 'red', logo: { scale: 'big' }, show: { tax: 'yes' } }).length).toBeGreaterThanOrEqual(4)
  })

  it('rejects sections that are not objects', () => {
    expect(errorsOf({ logo: 100 })).toContain('logo must be an object.')
    expect(errorsOf({ show: [] })).toContain('show must be an object.')
  })

  it('rejects oversized designs', () => {
    expect(errorsOf({ text: { terms: 'x'.repeat(MAX_DESIGN_JSON_LENGTH) } })).toEqual(['The design is too large.'])
  })

  it('does not throw on a design that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validateDocumentDesign(cyclic).ok).toBe(false)
  })
})

describe('brand colour', () => {
  it('accepts a 6-digit hex colour and lowercases it', () => {
    expect(ok({ brandColor: '#1A5C3F' }).brandColor).toBe('#1a5c3f')
  })

  it('rejects anything else', () => {
    for (const value of ['red', '#fff', '1a5c3f', '#1a5c3fff', 'url(x)', '#gggggg', 12, null]) {
      expect(errorsOf({ brandColor: value })[0]).toContain('brandColor')
    }
  })
})

describe('logo size', () => {
  it('clamps to the allowed range and rounds', () => {
    expect(ok({ logo: { scale: 10 } }).logo.scale).toBe(LOGO_SCALE_MIN)
    expect(ok({ logo: { scale: 500 } }).logo.scale).toBe(LOGO_SCALE_MAX)
    expect(ok({ logo: { scale: 99.6 } }).logo.scale).toBe(100)
    expect(ok({ logo: { scale: 120 } }).logo.scale).toBe(120)
  })

  it('defaults to 100 and rejects non-numbers', () => {
    expect(ok({}).logo.scale).toBe(100)
    for (const value of ['big', NaN, Infinity, null, {}]) expect(errorsOf({ logo: { scale: value } })[0]).toContain('logo.scale')
  })
})

describe('what to show', () => {
  it('accepts booleans and defaults the rest to on', () => {
    const design = ok({ show: { qr: false } })
    expect(design.show.qr).toBe(false)
    expect(design.show.tax).toBe(true)
  })

  it('rejects non-booleans', () => {
    expect(errorsOf({ show: { tax: 'yes' } })).toContain('show.tax must be true or false.')
    expect(errorsOf({ show: { tax: 1 } })).toContain('show.tax must be true or false.')
  })
})

describe('wording', () => {
  it('trims text and keeps defaults for missing fields', () => {
    const design = ok({ text: { quoteTitle: '  Estimate  ' } })
    expect(design.text.quoteTitle).toBe('Estimate')
    expect(design.text.invoiceTitle).toBe('Invoice')
  })

  it('allows an empty footer', () => {
    expect(ok({ text: { footer: '' } }).text.footer).toBe('')
  })

  it('rejects text over its limit, and non-text', () => {
    expect(errorsOf({ text: { quoteTitle: 'x'.repeat(41) } })).toContain('text.quoteTitle must be at most 40 characters.')
    expect(errorsOf({ text: { footer: 'x'.repeat(201) } })).toContain('text.footer must be at most 200 characters.')
    expect(errorsOf({ text: { terms: 'x'.repeat(2001) } })).toContain('text.terms must be at most 2000 characters.')
    expect(errorsOf({ text: { footer: 5 } })).toContain('text.footer must be text.')
  })

  it('allows line breaks in terms only, and rejects control characters', () => {
    expect(ok({ text: { terms: 'Line one\nLine two' } }).text.terms).toBe('Line one\nLine two')
    expect(errorsOf({ text: { footer: 'a\nb' } })[0]).toContain('text.footer')
    expect(errorsOf({ text: { quoteTitle: 'a\u0000b' } })[0]).toContain('text.quoteTitle')
    expect(errorsOf({ text: { terms: 'a\u0007b' } })[0]).toContain('text.terms')
  })

  it('accepts a limit-length text exactly at the limit', () => {
    expect(ok({ text: { quoteTitle: 'x'.repeat(40) } }).text.quoteTitle).toHaveLength(40)
  })
})

describe('payment numbers', () => {
  it('accepts 5 to 7 digits, and empty or missing', () => {
    expect(ok({ payment: { paybill: '880100', till: '1234567' } }).payment).toEqual({ paybill: '880100', till: '1234567' })
    expect(ok({ payment: { paybill: '' } }).payment).toEqual({ paybill: '', till: '' })
    expect(ok({ payment: { paybill: null } }).payment.paybill).toBe('')
    expect(ok({}).payment).toEqual({ paybill: '', till: '' })
  })

  it('rejects anything else', () => {
    for (const value of ['abc123', '1234', '12345678', '12 345', '+25470011', 880100]) {
      expect(errorsOf({ payment: { paybill: value } })[0]).toContain('payment.paybill')
    }
    expect(errorsOf({ payment: { till: 'x' } })[0]).toContain('payment.till')
  })
})

describe('email attachment', () => {
  it('defaults to attaching the PDF', () => {
    expect(ok({}).email.attachPdf).toBe(true)
    expect(ok({ email: { attachPdf: false } }).email.attachPdf).toBe(false)
  })

  it('rejects non-booleans', () => {
    expect(errorsOf({ email: { attachPdf: 'no' } })).toContain('email.attachPdf must be true or false.')
  })
})

describe('resolveDesign', () => {
  it('gives the default design for missing or invalid stored data, without throwing', () => {
    expect(resolveDesign(null)).toEqual(defaultDesignFor())
    expect(resolveDesign(undefined)).toEqual(defaultDesignFor())
    expect(resolveDesign('garbage')).toEqual(defaultDesignFor())
    expect(resolveDesign({ template: 'neon' })).toEqual(defaultDesignFor())
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(resolveDesign(cyclic)).toEqual(defaultDesignFor())
  })

  it('returns a valid stored design as is', () => {
    const stored = { ...defaultDesignFor('bold'), brandColor: '#112233' }
    expect(resolveDesign(stored)).toEqual(stored)
  })
})

describe('applyPlanLimits', () => {
  it('keeps a template the plan includes', () => {
    const design = ok({ template: 'classic' })
    const result = applyPlanLimits(design, PLAN_ENTITLEMENTS.STARTER)
    expect(result).toEqual({ design, templateLocked: false })
  })

  it('falls back to the default template when the plan lacks it, keeping everything else', () => {
    const design = ok({ template: 'bold', brandColor: '#112233', logo: { scale: 130 }, text: { footer: 'Asante' }, show: { qr: false } })
    const result = applyPlanLimits(design, PLAN_ENTITLEMENTS.STARTER)
    expect(result.templateLocked).toBe(true)
    expect(result.design).toMatchObject({ template: 'modern', header: 'band', table: 'striped', total: 'solid' })
    expect(result.design.brandColor).toBe('#112233')
    expect(result.design.logo.scale).toBe(130)
    expect(result.design.text.footer).toBe('Asante')
    expect(result.design.show.qr).toBe(false)
    expect(design.template).toBe('bold')
  })

  it('follows the plan tiers: Growth lacks Bold, Team has it', () => {
    const bold = ok({ template: 'bold' })
    expect(applyPlanLimits(bold, PLAN_ENTITLEMENTS.GROWTH).templateLocked).toBe(true)
    expect(applyPlanLimits(bold, PLAN_ENTITLEMENTS.TEAM).templateLocked).toBe(false)
    expect(applyPlanLimits(ok({ template: 'minimal' }), PLAN_ENTITLEMENTS.GROWTH).templateLocked).toBe(false)
    expect(applyPlanLimits(ok({ template: 'compact' }), PLAN_ENTITLEMENTS.STARTER).templateLocked).toBe(true)
  })

  it('always has the default template available, so the fallback is always allowed', () => {
    for (const plan of Object.values(PLAN_ENTITLEMENTS)) expect(templateAllowed(plan, DEFAULT_TEMPLATE)).toBe(true)
  })
})
