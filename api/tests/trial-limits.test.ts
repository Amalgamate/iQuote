import { describe, expect, it } from 'vitest'
import { TRIAL_LIMITS, quotaState, trialLimitReachedMessage } from '../src/plans'

describe('trial limits', () => {
  it('allows 7 quotes and 7 invoices in total', () => {
    expect(TRIAL_LIMITS).toEqual({ quotes: 7, invoices: 7 })
  })

  it('allows the 7th document and blocks the 8th', () => {
    expect(quotaState(6, TRIAL_LIMITS.quotes).allowed).toBe(true)
    expect(quotaState(7, TRIAL_LIMITS.quotes).allowed).toBe(false)
    expect(quotaState(6, TRIAL_LIMITS.invoices).allowed).toBe(true)
    expect(quotaState(7, TRIAL_LIMITS.invoices).allowed).toBe(false)
  })

  it('explains the limit and reassures that existing work stays available', () => {
    const message = trialLimitReachedMessage('quotes', 7)
    expect(message).toContain('7 quotes')
    expect(message).toContain('M-Pesa')
    expect(message).toContain('stays available')
    expect(trialLimitReachedMessage('invoices', 7)).toContain('7 invoices')
  })
})
