import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { TRIAL_LIMITS, quotaState, startOfMonthEAT } from '../src/plans'

// ---------------------------------------------------------------------------
// Trial usage counters
//
// The trial cap used to be enforced by counting Quote/Invoice rows, which let a
// user reopen slots by deleting documents and let two concurrent creates both
// pass the check. Usage is now a monotonic counter on Subscription, claimed
// inside the same transaction that creates the document and serialized by a
// "FOR UPDATE" row lock.
//
// These tests exercise the real database behaviour behind that claim.
// ---------------------------------------------------------------------------

const TEST_DB = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()
const SUFFIX = `trial-counter-${Date.now()}`

// Mirrors reserveTrialSlot in src/index.ts. Kept deliberately close: if the
// production helper changes shape, this test should change with it.
class TrialLimitReached extends Error {}

// Mirrors countQuotesThisMonth in src/index.ts. The monthly plan limit counts every Quote row,
// revisions included, so a workspace cannot revise past the limit.
async function countQuotesThisMonth(organisationId: string) {
  return prisma.quote.count({ where: { organisationId, createdAt: { gte: startOfMonthEAT() } } })
}

async function reserveTrialSlot(
  tx: PrismaClient,
  organisationId: string,
  kind: 'quotes' | 'invoices',
) {
  const column = kind === 'quotes' ? 'trialQuotesUsed' : 'trialInvoicesUsed'
  const rows = kind === 'quotes'
    ? await tx.$queryRaw<Array<{ status: string; used: number }>>`SELECT "status", "trialQuotesUsed" AS used FROM "Subscription" WHERE "organisationId" = ${organisationId} FOR UPDATE`
    : await tx.$queryRaw<Array<{ status: string; used: number }>>`SELECT "status", "trialInvoicesUsed" AS used FROM "Subscription" WHERE "organisationId" = ${organisationId} FOR UPDATE`
  const subscription = rows[0]
  if (subscription?.status !== 'TRIALING') return
  if (Number(subscription.used) >= TRIAL_LIMITS[kind]) throw new TrialLimitReached(kind)
  await tx.subscription.update({
    where: { organisationId },
    data: { [column]: { increment: 1 } },
  })
}

describe('trial usage counters', { skip: !TEST_DB && 'No DATABASE_URL — skipping tests that need PostgreSQL' }, () => {
  let ownerId = ''
  let orgId = ''

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: `TEST-${SUFFIX}`, email: `${SUFFIX}@test.com`, passwordHash: 'x', emailVerifiedAt: new Date(), role: 'USER' },
    })
    ownerId = owner.id
    const org = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}`,
        subdomain: `test-${SUFFIX}`.slice(0, 50),
        ownerId: owner.id,
        subscription: { create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 864e5), simulated: true } },
      },
    })
    orgId = org.id
  })

  afterAll(async () => {
    await prisma.quote.deleteMany({ where: { organisationId: orgId } })
    await prisma.customer.deleteMany({ where: { organisationId: orgId } })
    await prisma.subscription.deleteMany({ where: { organisationId: orgId } })
    await prisma.organisation.deleteMany({ where: { id: orgId } })
    await prisma.user.deleteMany({ where: { id: ownerId } })
    await prisma.$disconnect()
  })

  it('counts up to the trial limit and then refuses', async () => {
    for (let i = 0; i < TRIAL_LIMITS.quotes; i += 1) {
      await prisma.$transaction((tx) => reserveTrialSlot(tx as unknown as PrismaClient, orgId, 'quotes'))
    }
    await expect(
      prisma.$transaction((tx) => reserveTrialSlot(tx as unknown as PrismaClient, orgId, 'quotes')),
    ).rejects.toBeInstanceOf(TrialLimitReached)

    const subscription = await prisma.subscription.findUnique({ where: { organisationId: orgId } })
    expect(subscription?.trialQuotesUsed).toBe(TRIAL_LIMITS.quotes)
  })

  it('never exceeds the limit when many creates run concurrently', async () => {
    await prisma.subscription.update({ where: { organisationId: orgId }, data: { trialInvoicesUsed: 0 } })
    const attempts = TRIAL_LIMITS.invoices * 3

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        prisma.$transaction((tx) => reserveTrialSlot(tx as unknown as PrismaClient, orgId, 'invoices')),
      ),
    )

    const succeeded = results.filter((result) => result.status === 'fulfilled').length
    const blocked = results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof TrialLimitReached,
    ).length

    const subscription = await prisma.subscription.findUnique({ where: { organisationId: orgId } })
    expect(subscription?.trialInvoicesUsed).toBe(TRIAL_LIMITS.invoices)
    expect(succeeded).toBe(TRIAL_LIMITS.invoices)
    expect(blocked).toBe(attempts - TRIAL_LIMITS.invoices)
  })

  it('counts revisions toward the monthly plan limit', async () => {
    // Separate workspace so the counters above are unaffected.
    const monthlyOwner = await prisma.user.create({
      data: { name: `TEST-${SUFFIX}-m`, email: `${SUFFIX}-m@test.com`, passwordHash: 'x', emailVerifiedAt: new Date(), role: 'USER' },
    })
    const monthlyOrg = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}-m`,
        subdomain: `test-${SUFFIX}-m`.slice(0, 50),
        ownerId: monthlyOwner.id,
        subscription: { create: { plan: 'STARTER', status: 'ACTIVE', trialEndsAt: new Date(Date.now() + 864e5), currentPeriodEndsAt: new Date(Date.now() + 864e5), simulated: true } },
      },
    })
    const cust = await prisma.customer.create({ data: { organisationId: monthlyOrg.id, ownerId: monthlyOwner.id, name: `TEST-${SUFFIX}-mc` } })
    const base = await prisma.quote.create({
      data: { organisationId: monthlyOrg.id, ownerId: monthlyOwner.id, customerId: cust.id, documentNumber: `TEST-${SUFFIX}-mb`, currency: 'KES', subtotal: 1, taxTotal: 0, total: 1 },
    })
    // Two revisions of one quote: under the old rule these were invisible to the monthly count.
    for (let i = 0; i < 2; i += 1) {
      await prisma.quote.create({
        data: { organisationId: monthlyOrg.id, ownerId: monthlyOwner.id, customerId: cust.id, documentNumber: `TEST-${SUFFIX}-rv${i}`, parentQuoteId: base.id, version: i + 2, currency: 'KES', subtotal: 1, taxTotal: 0, total: 1 },
      })
    }

    // 1 new quote + 2 revisions = 3 documents against a limit of 3.
    expect(await countQuotesThisMonth(monthlyOrg.id)).toBe(3)
    expect(quotaState(await countQuotesThisMonth(monthlyOrg.id), 3).allowed).toBe(false)
    // Excluding revisions would have reported 1 and let the user keep going.
    expect(await prisma.quote.count({ where: { organisationId: monthlyOrg.id, parentQuoteId: null } })).toBe(1)

    await prisma.quote.deleteMany({ where: { organisationId: monthlyOrg.id } })
    await prisma.customer.deleteMany({ where: { organisationId: monthlyOrg.id } })
    await prisma.subscription.deleteMany({ where: { organisationId: monthlyOrg.id } })
    await prisma.organisation.deleteMany({ where: { id: monthlyOrg.id } })
    await prisma.user.deleteMany({ where: { id: monthlyOwner.id } })
  })

  it('keeps slots consumed after documents are deleted', async () => {
    // A trial workspace at its cap, which then deletes every document it made.
    const cust = await prisma.customer.create({ data: { organisationId: orgId, ownerId, name: `TEST-${SUFFIX}-cust` } })
    for (let i = 0; i < 3; i += 1) {
      await prisma.quote.create({
        data: { organisationId: orgId, ownerId, customerId: cust.id, documentNumber: `TEST-${SUFFIX}-${i}`, status: 'DRAFT', currency: 'KES', subtotal: 1, taxTotal: 0, total: 1 },
      })
    }
    await prisma.quote.deleteMany({ where: { organisationId: orgId } })
    expect(await prisma.quote.count({ where: { organisationId: orgId } })).toBe(0)

    // The old row-counting check would have found 0 rows and allowed a new quote.
    // The counter must still refuse, because usage is monotonic.
    await expect(
      prisma.$transaction((tx) => reserveTrialSlot(tx as unknown as PrismaClient, orgId, 'quotes')),
    ).rejects.toBeInstanceOf(TrialLimitReached)

    const subscription = await prisma.subscription.findUnique({ where: { organisationId: orgId } })
    expect(subscription?.trialQuotesUsed).toBe(TRIAL_LIMITS.quotes)
  })
})
