import { describe, beforeAll, afterAll, it, expect, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { app, prisma, expireDueTrials } from '../src/index.js'

// ---------------------------------------------------------------------------
// Trial notices by email
//
// Two gaps this covers:
//   1. Hitting the trial document cap sent nothing, so the owner only found out
//      when a create failed in front of them.
//   2. A trial that simply ran out never produced an event at all: expiry is
//      applied lazily the next time someone touches the subscription, so an
//      abandoned workspace stayed "TRIALING" forever and no one was told.
//
// Both notices must be sent exactly once per workspace, no matter how many
// requests trip the cap or how often the sweep runs.
// ---------------------------------------------------------------------------

const TEST_DB = Boolean(process.env.DATABASE_URL)
const SUFFIX = `trial-notice-${Date.now()}`

type SentMail = { to: string[]; subject: string; html: string; idempotencyKey: string }
const sent: SentMail[] = []

function installResendStub() {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { to: string[]; subject: string; html: string }
      const headers = new Headers(init?.headers)
      sent.push({ ...body, idempotencyKey: headers.get('Idempotency-Key') ?? '' })
      return new Response(JSON.stringify({ id: `stub-${sent.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return original(input as RequestInfo, init)
  })
}

async function login(email: string, password: string) {
  const res = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5174').send({ email, password })
  const cookies = res.headers['set-cookie']
  const cookie = Array.isArray(cookies) ? cookies[0].split(';')[0] : String(cookies ?? '').split(';')[0]
  return { res, cookie }
}

describe('trial notices by email', { skip: !TEST_DB && 'No DATABASE_URL — skipping tests that need PostgreSQL' }, () => {
  const password = 'TrialNotice123!'
  let ownerId = ''
  let orgId = ''
  let cookie = ''
  let customerId = ''
  let serviceItemId = ''
  let quoteTemplateId = ''

  beforeAll(async () => {
    // The email provider must look configured, or sendEmail returns false silently.
    process.env.RESEND_API_KEY = 're_test_stub'
    process.env.RESEND_FROM_EMAIL = 'billing@trendscore.co.ke'
    process.env.SUPPORT_EMAIL = 'support@trendscore.co.ke'
    installResendStub()

    const hashed = await bcrypt.hash(password, 10)
    const owner = await prisma.user.create({
      data: { name: 'Trial Notice Owner', email: `${SUFFIX}@test.com`, passwordHash: hashed, emailVerifiedAt: new Date(), role: 'USER' },
    })
    ownerId = owner.id
    const org = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}`,
        subdomain: SUFFIX.slice(0, 40),
        email: `${SUFFIX}@test.com`,
        country: 'Kenya',
        currency: 'KES',
        quotePrefix: 'TN',
        defaultTaxRate: 16,
        ownerId: owner.id,
        members: { connect: { id: owner.id } },
        // Already at the quote cap; the invoice counter is untouched.
        subscription: {
          create: {
            plan: 'STARTER',
            status: 'TRIALING',
            trialEndsAt: new Date(Date.now() + 14 * 86400000),
            simulated: true,
            trialQuotesUsed: 7,
          },
        },
      },
    })
    orgId = org.id
    await prisma.user.update({ where: { id: owner.id }, data: { organisationId: org.id } })

    const customer = await prisma.customer.create({
      data: { name: `TEST-${SUFFIX} Customer`, phone: '+254700000777', organisationId: org.id, ownerId: owner.id },
    })
    customerId = customer.id
    const item = await prisma.serviceItem.create({
      data: { name: `TEST-${SUFFIX} Item`, category: 'General', kind: 'SERVICE', unit: 'job', defaultPrice: 1000, organisationId: org.id },
    })
    serviceItemId = item.id
    const template = await prisma.quoteTemplate.create({
      data: { name: `TEST-${SUFFIX} Template`, description: 'Test template', workflow: 'standard', lineItems: [{ description: 'Work', unit: 'job' }], organisationId: org.id },
    })
    quoteTemplateId = template.id

    const session = await login(owner.email, password)
    expect(session.res.status).toBe(200)
    cookie = session.cookie
  })

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { organisationId: orgId } })
    await prisma.quote.deleteMany({ where: { organisationId: orgId } })
    await prisma.customer.deleteMany({ where: { organisationId: orgId } })
    await prisma.serviceItem.deleteMany({ where: { organisationId: orgId } })
    await prisma.quoteTemplate.deleteMany({ where: { organisationId: orgId } })
    await prisma.subscription.deleteMany({ where: { organisationId: orgId } })
    await prisma.organisation.deleteMany({ where: { id: orgId } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, ...extraOwners] } } })
    vi.unstubAllGlobals()
  })


  // Organisation.ownerId is unique, so every throwaway workspace needs its own owner.
  const extraOwners: string[] = []
  async function ownerFor(label: string) {
    const user = await prisma.user.create({
      data: { name: `Trial Notice ${label}`, email: `${SUFFIX}-${label}@test.com`, passwordHash: 'x', emailVerifiedAt: new Date(), role: 'USER' },
    })
    extraOwners.push(user.id)
    return user.id
  }

  const createQuote = () => request(app)
    .post('/api/quotes')
    .set('Origin', 'http://localhost:5174')
    .set('Cookie', cookie)
    .send({
      customerId,
      quoteTemplateId,
      lines: [{ description: 'Trial cap test', quantity: 1, unitPrice: 1000, unit: 'job' }],
    })

  it('emails the owner once when the quote cap is reached, even on repeat attempts', async () => {
    sent.length = 0
    const first = await createQuote()
    expect(first.status).toBe(403)
    expect(first.body.kind).toBe('quotes')

    const second = await createQuote()
    expect(second.status).toBe(403)

    const capMails = sent.filter((mail) => mail.subject.includes('trial quotes'))
    expect(capMails).toHaveLength(1)
    expect(capMails[0].to).toEqual([`${SUFFIX}@test.com`])
    expect(capMails[0].html).toContain('You have used all 7 trial quotes')
    expect(capMails[0].idempotencyKey).toBe(`trial-cap/${orgId}/quotes`)

    const markers = await prisma.notification.count({ where: { organisationId: orgId, sourceKey: `trial-cap:quotes:${orgId}` } })
    expect(markers).toBe(1)
  })

  it('emails the owner once when the invoice cap is reached', async () => {
    sent.length = 0
    const invoiceOwner = await ownerFor('invoices')
    const invoiceOrg = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}-invoices`,
        email: `${SUFFIX}@test.com`,
        quotePrefix: 'TI',
        ownerId: invoiceOwner,
        members: { connect: { id: invoiceOwner } },
        subscription: {
          create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 14 * 86400000), simulated: true, trialInvoicesUsed: 7 },
        },
      },
    })
    try {
      const hashed = await bcrypt.hash(password, 10)
      await prisma.user.update({ where: { id: invoiceOwner }, data: { organisationId: invoiceOrg.id, passwordHash: hashed } })
      const customer = await prisma.customer.create({ data: { name: `TEST-${SUFFIX} Inv Customer`, organisationId: invoiceOrg.id, ownerId: invoiceOwner } })
      // Invoicing is only allowed from an approved quote, so seed one directly.
      const quote = await prisma.quote.create({
        data: {
          documentNumber: `TI-2026-${Date.now().toString().slice(-5)}`,
          status: 'APPROVED',
          organisationId: invoiceOrg.id,
          ownerId: invoiceOwner,
          customerId: customer.id,
          currency: 'KES',
          subtotal: 1000,
          taxTotal: 160,
          total: 1160,
        },
      })
      const session = await login(`${SUFFIX}-invoices@test.com`, password)
      expect(session.res.status).toBe(200)

      const first = await request(app)
        .post('/api/invoices')
        .set('Origin', 'http://localhost:5174')
        .set('Cookie', session.cookie)
        .send({ quoteId: quote.id })
      expect(first.status).toBe(403)
      expect(first.body.kind).toBe('invoices')

      const second = await request(app)
        .post('/api/invoices')
        .set('Origin', 'http://localhost:5174')
        .set('Cookie', session.cookie)
        .send({ quoteId: quote.id })
      expect(second.status).toBe(403)

      const invoiceMails = sent.filter((mail) => mail.subject.includes('trial invoices'))
      expect(invoiceMails).toHaveLength(1)
      expect(invoiceMails[0].html).toContain('You have used all 7 trial invoices')
      expect(invoiceMails[0].idempotencyKey).toBe(`trial-cap/${invoiceOrg.id}/invoices`)
    } finally {
      await prisma.invoice.deleteMany({ where: { organisationId: invoiceOrg.id } })
      await prisma.quote.deleteMany({ where: { organisationId: invoiceOrg.id } })
      await prisma.customer.deleteMany({ where: { organisationId: invoiceOrg.id } })
      await prisma.notification.deleteMany({ where: { organisationId: invoiceOrg.id } })
      await prisma.subscription.deleteMany({ where: { organisationId: invoiceOrg.id } })
      await prisma.organisation.delete({ where: { id: invoiceOrg.id } })
    }
  })

  it('emails the owner once when a trial expires, and only moves TRIALING rows', async () => {
    sent.length = 0
    const expiredOwner = await ownerFor('expired')
    const expiredOrg = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}-expired`,
        email: `${SUFFIX}@test.com`,
        ownerId: expiredOwner,
        subscription: {
          create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt: new Date(Date.now() - 60_000), simulated: true },
        },
      },
    })
    try {
      const result = await expireDueTrials()
      expect(result.due).toBeGreaterThanOrEqual(1)

      const subscription = await prisma.subscription.findUnique({ where: { organisationId: expiredOrg.id } })
      expect(subscription?.status).toBe('EXPIRED')

      const expiryMails = sent.filter((mail) => mail.subject.includes('trial has ended'))
      const forThisOrg = expiryMails.filter((mail) => mail.idempotencyKey === `trial-expired/${expiredOrg.id}`)
      expect(forThisOrg).toHaveLength(1)
      expect(forThisOrg[0].html).toContain('Your trial has ended')

      // A second sweep must not resend: the row is no longer TRIALING and the
      // marker is already there.
      const again = await expireDueTrials()
      expect(again.notified).toBe(0)
      const afterSecond = sent.filter((mail) => mail.idempotencyKey === `trial-expired/${expiredOrg.id}`)
      expect(afterSecond).toHaveLength(1)
    } finally {
      await prisma.notification.deleteMany({ where: { organisationId: expiredOrg.id } })
      await prisma.subscription.deleteMany({ where: { organisationId: expiredOrg.id } })
      await prisma.organisation.delete({ where: { id: expiredOrg.id } })
    }
  })

  it('leaves an active paid subscription alone during the sweep', async () => {
    const paidOwner = await ownerFor('paid')
    const paidOrg = await prisma.organisation.create({
      data: {
        name: `TEST-${SUFFIX}-paid`,
        email: `${SUFFIX}@test.com`,
        ownerId: paidOwner,
        subscription: {
          create: { plan: 'GROWTH', status: 'ACTIVE', trialEndsAt: new Date(Date.now() - 60_000), currentPeriodEndsAt: new Date(Date.now() + 30 * 86400000), simulated: true },
        },
      },
    })
    try {
      await expireDueTrials()
      const subscription = await prisma.subscription.findUnique({ where: { organisationId: paidOrg.id } })
      expect(subscription?.status).toBe('ACTIVE')
    } finally {
      await prisma.notification.deleteMany({ where: { organisationId: paidOrg.id } })
      await prisma.subscription.deleteMany({ where: { organisationId: paidOrg.id } })
      await prisma.organisation.delete({ where: { id: paidOrg.id } })
    }
  })
})
