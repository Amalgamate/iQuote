import { describe, expect, it } from 'vitest'
import { documentFlags, flagEnabled } from '../src/feature-flags'

describe('flagEnabled', () => {
  it('is off when the variable is missing, empty or unrecognised', () => {
    expect(flagEnabled('SERVER_PDF_ENABLED', {})).toBe(false)
    expect(flagEnabled('SERVER_PDF_ENABLED', { SERVER_PDF_ENABLED: '' })).toBe(false)
    expect(flagEnabled('SERVER_PDF_ENABLED', { SERVER_PDF_ENABLED: '0' })).toBe(false)
    expect(flagEnabled('SERVER_PDF_ENABLED', { SERVER_PDF_ENABLED: 'false' })).toBe(false)
    expect(flagEnabled('SERVER_PDF_ENABLED', { SERVER_PDF_ENABLED: 'maybe' })).toBe(false)
  })

  it('is on for 1, true, yes and on, ignoring case and spaces', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      expect(flagEnabled('DOCUMENT_DESIGN_ENABLED', { DOCUMENT_DESIGN_ENABLED: value })).toBe(true)
    }
  })
})

describe('documentFlags', () => {
  it('defaults everything to off', () => {
    expect(documentFlags({})).toEqual({ documentDesign: false, serverPdf: false, emailPdfAttach: false })
  })

  it('keeps email attachments off unless server rendering is on', () => {
    expect(documentFlags({ EMAIL_PDF_ATTACH_ENABLED: '1' }).emailPdfAttach).toBe(false)
    expect(documentFlags({ EMAIL_PDF_ATTACH_ENABLED: '1', SERVER_PDF_ENABLED: '1' }).emailPdfAttach).toBe(true)
  })

  it('lets each flag be turned on on its own', () => {
    expect(documentFlags({ DOCUMENT_DESIGN_ENABLED: 'true' })).toEqual({ documentDesign: true, serverPdf: false, emailPdfAttach: false })
  })
})
