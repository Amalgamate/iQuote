import { describe, expect, it } from 'vitest'
import { MAX_LINES, numbersInText, priceAppearsInText, validateProposal, type CatalogueItem } from '../src/ai-quote'

const catalogue: CatalogueItem[] = [
  { id: 'svc_1', name: 'Pipe repair', unit: 'hour', defaultPrice: 1500, defaultTaxRate: 16 },
  { id: 'svc_2', name: 'Cleaning', unit: 'visit', defaultPrice: 2000, defaultTaxRate: null },
]
const base = { catalogue, defaultTaxRate: 16 }

describe('numbersInText', () => {
  it('reads plain numbers, thousands separators and k suffixes', () => {
    expect(numbersInText('KES 2,500 for 3 hours, plus 5k deposit')).toEqual([2500, 3, 5000])
  })

  it('does not treat the k in units like kg as thousands', () => {
    expect(numbersInText('50 kg of cement')).toEqual([50])
  })

  it('finds a price in a message', () => {
    expect(priceAppearsInText('charge him 12,000 for the sign', 12000)).toBe(true)
    expect(priceAppearsInText('charge him 12,000 for the sign', 15000)).toBe(false)
  })
})

describe('validateProposal', () => {
  it('uses the catalogue price and tax rate, ignoring what the model claims', () => {
    const result = validateProposal(
      { lines: [{ description: 'Pipe repair', quantity: 3, priceSource: 'catalogue', catalogueItemId: 'svc_1', unitPrice: 99999 }] },
      { ...base, userText: 'pipe repair 3 hours' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lines[0]).toMatchObject({ unitPrice: 1500, taxRate: 16, unit: 'hour', needsPrice: false })
    }
  })

  it('falls back to the organisation tax rate when the catalogue item has none', () => {
    const result = validateProposal(
      { lines: [{ description: 'Cleaning', quantity: 1, priceSource: 'catalogue', catalogueItemId: 'svc_2' }] },
      { ...base, userText: 'cleaning' },
    )
    expect(result.ok && result.lines[0]?.taxRate).toBe(16)
  })

  it('accepts a user price only if the number really appears in their message', () => {
    const ok = validateProposal(
      { lines: [{ description: 'Signboard', quantity: 1, unitPrice: 12000, priceSource: 'user' }] },
      { ...base, userText: 'signboard for 12,000' },
    )
    expect(ok.ok && ok.lines[0]).toMatchObject({ unitPrice: 12000, needsPrice: false })

    const invented = validateProposal(
      { lines: [{ description: 'Signboard', quantity: 1, unitPrice: 15000, priceSource: 'user' }] },
      { ...base, userText: 'signboard for 12,000' },
    )
    expect(invented.ok && invented.lines[0]).toMatchObject({ unitPrice: 0, needsPrice: true })
    expect(invented.ok && invented.warnings.length).toBe(1)
  })

  it('never accepts a price the model marked unknown, even if it supplies a number', () => {
    const result = validateProposal(
      { lines: [{ description: 'Paint', quantity: 2, unitPrice: 800, priceSource: 'unknown' }] },
      { ...base, userText: 'two tins of paint 800' },
    )
    expect(result.ok && result.lines[0]).toMatchObject({ unitPrice: 0, needsPrice: true })
  })

  it('ignores a catalogue id that does not exist', () => {
    const result = validateProposal(
      { lines: [{ description: 'Mystery', quantity: 1, priceSource: 'catalogue', catalogueItemId: 'nope', unitPrice: 500 }] },
      { ...base, userText: 'mystery 500' },
    )
    expect(result.ok && result.lines[0]?.needsPrice).toBe(true)
  })

  it('skips lines with bad descriptions or quantities and says why', () => {
    const result = validateProposal(
      { lines: [
        { description: '  ', quantity: 1, priceSource: 'unknown' },
        { description: 'Bad qty', quantity: -2, priceSource: 'unknown' },
        { description: 'Good', quantity: 2, priceSource: 'unknown' },
      ] },
      { ...base, userText: 'good' },
    )
    expect(result.ok && result.lines.map((l) => l.description)).toEqual(['Good'])
    expect(result.ok && result.warnings.length).toBe(2)
  })

  it('rejects unreadable output, no lines, and too many lines', () => {
    expect(validateProposal(null, { ...base, userText: '' }).ok).toBe(false)
    expect(validateProposal({ lines: 'x' }, { ...base, userText: '' }).ok).toBe(false)
    expect(validateProposal({ lines: [] }, { ...base, userText: '' }).ok).toBe(false)
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({ description: 'x', quantity: 1, priceSource: 'unknown' }))
    expect(validateProposal({ lines: many }, { ...base, userText: '' }).ok).toBe(false)
  })

  it('cleans notes, validity days, assumptions and questions', () => {
    const result = validateProposal(
      {
        lines: [{ description: 'Item', quantity: 1, priceSource: 'unknown' }],
        customerName: '  Wanjiru   Kamau ',
        notes: 'x'.repeat(3000),
        validDays: 14.5,
        assumptions: ['Assumed one visit', 42, ''],
        questions: Array.from({ length: 9 }, (_, i) => `Question ${i}`),
      },
      { ...base, userText: 'item' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.customerName).toBe('Wanjiru Kamau')
      expect(result.notes?.length).toBe(2000)
      expect(result.validDays).toBeNull()
      expect(result.assumptions).toEqual(['Assumed one visit'])
      expect(result.questions.length).toBe(5)
    }
  })
})
