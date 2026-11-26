// Plan entitlements: the single source of truth for what each plan includes.
// Pure functions, no database or framework dependency, so they are easy to test
// and can be called from any route handler in index.ts.
//
// NOTE: the numbers below are a starting hypothesis to validate in the pilot,
// not final commercial terms. See docs/PLANS.md for the reasoning.

export const PLAN_NAMES = ['STARTER', 'GROWTH', 'TEAM'] as const
export type PlanName = (typeof PLAN_NAMES)[number]

export type DocumentTemplateKey = 'classic' | 'modern' | 'minimal' | 'bold' | 'compact'
const ALL_TEMPLATES: readonly DocumentTemplateKey[] = ['classic', 'modern', 'minimal', 'bold', 'compact']
// Template tiers (owner decision, 27 Nov 2026): Starter gets the default plus Classic, Growth adds Minimal
// and Compact, Team adds Bold. Each tier includes everything below it. Brand colour, logo and the other
// design options are not gated by plan.
const STARTER_TEMPLATES: readonly DocumentTemplateKey[] = ['modern', 'classic']
const GROWTH_TEMPLATES: readonly DocumentTemplateKey[] = [...STARTER_TEMPLATES, 'minimal', 'compact']

export type Entitlements = {
  /** New quotes per calendar month (EAT). Revisions of an existing quote do not count. */
  quotesPerMonth: number
  /** Users in the workspace, including the owner. */
  teamMembers: number
  /** Quote emails (send + resend) per rolling 24 hours. Also an anti-abuse cap. */
  emailsPerDay: number
  /** PDF templates a business may choose from. */
  templates: readonly DocumentTemplateKey[]
  invoices: boolean
  jobs: boolean
  /** Collect customer payments by M-Pesa STK from invoices. */
  customerMpesa: boolean
  reports: boolean
  /** Send from the business's own verified email domain and Resend key. */
  customEmailDomain: boolean
}

export const PLAN_ENTITLEMENTS: Record<PlanName, Entitlements> = {
  STARTER: {
    quotesPerMonth: 30,
    teamMembers: 1,
    emailsPerDay: 25,
    templates: STARTER_TEMPLATES,
    invoices: true,
    jobs: false,
    customerMpesa: false,
    reports: false,
    customEmailDomain: false,
  },
  GROWTH: {
    quotesPerMonth: 500,
    teamMembers: 2,
    emailsPerDay: 100,
    templates: GROWTH_TEMPLATES,
    invoices: true,
    jobs: true,
    customerMpesa: true,
    reports: true,
    customEmailDomain: false,
  },
  TEAM: {
    quotesPerMonth: 2000,
    teamMembers: 5,
    emailsPerDay: 300,
    templates: ALL_TEMPLATES,
    invoices: true,
    jobs: true,
    customerMpesa: true,
    reports: true,
    customEmailDomain: true,
  },
}

export type FeatureFlag = {
  [K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never
}[keyof Entitlements]

export function isPlanName(value: unknown): value is PlanName {
  return typeof value === 'string' && (PLAN_NAMES as readonly string[]).includes(value.toUpperCase())
}

/**
 * Entitlements for a subscription.
 * - A TRIALING workspace gets GROWTH so new users experience the money features.
 * - An unknown or missing plan falls back to STARTER (the safe, restrictive default).
 * Expired and suspended workspaces are blocked elsewhere (requireAuth), not here.
 */
export function entitlementsFor(plan: string | null | undefined, status?: string | null): Entitlements {
  if (status && status.toUpperCase() === 'TRIALING') return PLAN_ENTITLEMENTS.GROWTH
  const name = typeof plan === 'string' ? plan.toUpperCase() : ''
  return isPlanName(name) ? PLAN_ENTITLEMENTS[name] : PLAN_ENTITLEMENTS.STARTER
}

export function featureAllowed(entitlements: Entitlements, feature: FeatureFlag): boolean {
  return entitlements[feature]
}

export function templateAllowed(entitlements: Entitlements, template: string): boolean {
  return (entitlements.templates as readonly string[]).includes(template)
}

export type QuotaState = { allowed: boolean; used: number; limit: number; remaining: number }

/** Whether one more item fits under the limit. `used` is the count before the new item. */
export function quotaState(used: number, limit: number): QuotaState {
  const safeUsed = Math.max(0, Math.floor(used))
  return { allowed: safeUsed < limit, used: safeUsed, limit, remaining: Math.max(0, limit - safeUsed) }
}

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000 // East Africa Time is UTC+3 with no daylight saving

/** Start of the current calendar month in East Africa Time, as a UTC Date. */
export function startOfMonthEAT(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + EAT_OFFSET_MS)
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - EAT_OFFSET_MS)
}

export const PLAN_LIMIT_CODE = 'PLAN_LIMIT_REACHED'
export const PLAN_FEATURE_CODE = 'PLAN_FEATURE_UNAVAILABLE'

const PLAN_LABEL: Record<PlanName, string> = { STARTER: 'Starter', GROWTH: 'Growth', TEAM: 'Team' }

/** Lowest plan that includes a feature, for upgrade prompts. */
export function lowestPlanWith(feature: FeatureFlag): PlanName | null {
  return PLAN_NAMES.find((plan) => PLAN_ENTITLEMENTS[plan][feature]) ?? null
}

export function featureUnavailableMessage(feature: FeatureFlag, featureLabel: string): string {
  const plan = lowestPlanWith(feature)
  return plan
    ? `${featureLabel} is available on the ${PLAN_LABEL[plan]} plan and above. Upgrade to use it.`
    : `${featureLabel} is not available on your plan.`
}

/** Total documents a workspace may create during the free trial (lifetime of the trial, not per month). */
export const TRIAL_LIMITS = { quotes: 7, invoices: 7 } as const

export function trialLimitReachedMessage(kind: 'quotes' | 'invoices', limit: number): string {
  return `Your free trial includes up to ${limit} ${kind}, and you have used them all. Choose a plan and pay by M-Pesa to keep creating ${kind}. Everything you have created stays available.`
}

export function limitReachedMessage(kind: 'quotes' | 'emails' | 'team', limit: number): string {
  if (kind === 'quotes') return `You have reached this month's limit of ${limit} new quotes on your plan. Existing quotes are not affected. Upgrade for a higher limit.`
  if (kind === 'emails') return `You have reached the limit of ${limit} quote emails in the last 24 hours on your plan. Try again later or upgrade.`
  return `Your plan allows ${limit} ${limit === 1 ? 'user' : 'users'}. Upgrade to add more team members.`
}
