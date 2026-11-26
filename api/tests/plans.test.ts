import { describe, expect, it } from 'vitest'
import {
  PLAN_ENTITLEMENTS,
  entitlementsFor,
  featureAllowed,
  featureUnavailableMessage,
  limitReachedMessage,
  lowestPlanWith,
  quotaState,
  startOfMonthEAT,
  templateAllowed,
} from '../src/plans'

describe('entitlementsFor', () => {
  it('maps each plan to its entitlements, case-insensitively', () => {
    expect(entitlementsFor('STARTER', 'ACTIVE')).toBe(PLAN_ENTITLEMENTS.STARTER)
    expect(entitlementsFor('growth', 'ACTIVE')).toBe(PLAN_ENTITLEMENTS.GROWTH)
    expect(entitlementsFor('TEAM', 'ACTIVE')).toBe(PLAN_ENTITLEMENTS.TEAM)
  })

  it('gives trials the Growth entitlements regardless of the stored plan', () => {
    expect(entitlementsFor('STARTER', 'TRIALING')).toBe(PLAN_ENTITLEMENTS.GROWTH)
  })

  it('falls back to Starter for unknown or missing plans', () => {
    expect(entitlementsFor('ENTERPRISE', 'ACTIVE')).toBe(PLAN_ENTITLEMENTS.STARTER)
    expect(entitlementsFor(null)).toBe(PLAN_ENTITLEMENTS.STARTER)
    expect(entitlementsFor(undefined)).toBe(PLAN_ENTITLEMENTS.STARTER)
  })
})

describe('plan shape', () => {
  it('never gives a lower plan more than a higher plan', () => {
    const { STARTER, GROWTH, TEAM } = PLAN_ENTITLEMENTS
    for (const key of ['quotesPerMonth', 'teamMembers', 'emailsPerDay'] as const) {
      expect(STARTER[key]).toBeLessThanOrEqual(GROWTH[key])
      expect(GROWTH[key]).toBeLessThanOrEqual(TEAM[key])
    }
    for (const key of ['invoices', 'jobs', 'customerMpesa', 'reports', 'customEmailDomain'] as const) {
      if (STARTER[key]) expect(GROWTH[key]).toBe(true)
      if (GROWTH[key]) expect(TEAM[key]).toBe(true)
    }
    expect(STARTER.templates.length).toBeLessThanOrEqual(GROWTH.templates.length)
    expect(GROWTH.templates.length).toBeLessThanOrEqual(TEAM.templates.length)
    // Each plan's templates are a subset of the next plan's.
    for (const template of STARTER.templates) expect(GROWTH.templates).toContain(template)
    for (const template of GROWTH.templates) expect(TEAM.templates).toContain(template)
  })

  it('always includes the default template on every plan', () => {
    for (const plan of Object.values(PLAN_ENTITLEMENTS)) expect(templateAllowed(plan, 'modern')).toBe(true)
  })
})

describe('features and templates', () => {
  it('gates features by plan', () => {
    expect(featureAllowed(PLAN_ENTITLEMENTS.STARTER, 'customerMpesa')).toBe(false)
    expect(featureAllowed(PLAN_ENTITLEMENTS.GROWTH, 'customerMpesa')).toBe(true)
    expect(featureAllowed(PLAN_ENTITLEMENTS.GROWTH, 'customEmailDomain')).toBe(false)
    expect(featureAllowed(PLAN_ENTITLEMENTS.TEAM, 'customEmailDomain')).toBe(true)
  })

  it('spreads templates across plans: Starter, Growth, Team', () => {
    expect(templateAllowed(PLAN_ENTITLEMENTS.STARTER, 'bold')).toBe(false)
    expect(templateAllowed(PLAN_ENTITLEMENTS.STARTER, 'minimal')).toBe(false)
    expect(templateAllowed(PLAN_ENTITLEMENTS.STARTER, 'compact')).toBe(false)
    expect(templateAllowed(PLAN_ENTITLEMENTS.STARTER, 'classic')).toBe(true)
    expect(templateAllowed(PLAN_ENTITLEMENTS.GROWTH, 'minimal')).toBe(true)
    expect(templateAllowed(PLAN_ENTITLEMENTS.GROWTH, 'compact')).toBe(true)
    expect(templateAllowed(PLAN_ENTITLEMENTS.GROWTH, 'bold')).toBe(false)
    for (const template of ['classic', 'modern', 'minimal', 'bold', 'compact']) {
      expect(templateAllowed(PLAN_ENTITLEMENTS.TEAM, template)).toBe(true)
    }
    expect(templateAllowed(PLAN_ENTITLEMENTS.TEAM, 'not-a-template')).toBe(false)
  })

  it('names the lowest plan that includes a feature', () => {
    expect(lowestPlanWith('jobs')).toBe('GROWTH')
    expect(lowestPlanWith('customEmailDomain')).toBe('TEAM')
    expect(lowestPlanWith('invoices')).toBe('STARTER')
    expect(featureUnavailableMessage('jobs', 'Jobs')).toContain('Growth')
  })
})

describe('quotaState', () => {
  it('allows items below the limit and blocks at the limit', () => {
    expect(quotaState(29, 30)).toEqual({ allowed: true, used: 29, limit: 30, remaining: 1 })
    expect(quotaState(30, 30).allowed).toBe(false)
    expect(quotaState(31, 30).remaining).toBe(0)
  })

  it('treats bad counts as zero', () => {
    expect(quotaState(-5, 30).used).toBe(0)
  })

  it('produces readable limit messages', () => {
    expect(limitReachedMessage('quotes', 30)).toContain('30')
    expect(limitReachedMessage('team', 1)).toContain('1 user')
  })
})

describe('startOfMonthEAT', () => {
  it('starts the month at midnight East Africa Time', () => {
    expect(startOfMonthEAT(new Date('2026-11-25T10:00:00Z')).toISOString()).toBe('2026-10-31T21:00:00.000Z')
  })

  it('rolls into the next month at 21:00 UTC on the last day', () => {
    // 2026-11-30 22:00 UTC is already 1 December in Nairobi.
    expect(startOfMonthEAT(new Date('2026-11-30T22:00:00Z')).toISOString()).toBe('2026-11-30T21:00:00.000Z')
    // One hour earlier it is still November.
    expect(startOfMonthEAT(new Date('2026-11-30T20:00:00Z')).toISOString()).toBe('2026-10-31T21:00:00.000Z')
  })
})
