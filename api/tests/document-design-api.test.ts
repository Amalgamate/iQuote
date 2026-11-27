import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { app, prisma } from '../src/index.js'

// ---------------------------------------------------------------------------
// Document design settings API (docs/DOCUMENT_DESIGN_PLAN.md, Phase 1)
//
// Covers the rules that the pure validator cannot see: who may read and write the design, that one
// workspace cannot touch another's design or snapshots, and that the plan check on the template is
// enforced by the server rather than only hidden in the picker.
// ---------------------------------------------------------------------------

const TEST_DB = Boolean(process.env.DATABASE_URL)
const ORIGIN = 'http://localhost:5174'
const PREFIX = 'TEST-DESIGN-'
// Login lowercases the address, so fixtures must store it lowercased too. The display name keeps
// the uppercase prefix; only the email column needs this.
const EMAIL_PREFIX = PREFIX.toLowerCase()

async function login(email: string, password: string) {
  return request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email, password })
}

function cookieOf(res: request.Response): string {
  const cookies = res.headers['set-cookie']
  if (!cookies) return ''
  const session = Array.isArray(cookies) ? cookies[0] : cookies
  return session.split(';')[0]
}

type Workspace = { orgId: string; ownerCookie: string; memberCookie: string; adminCookie: string; plan: string }

async function makeWorkspace(slug: string, plan: 'STARTER' | 'GROWTH' | 'TEAM', withAdmin = false): Promise<Workspace> {
  const password = 'TestPass123!'
  const passwordHash = await bcrypt.hash(password, 10)
  const email = `${EMAIL_PREFIX}${slug}@test.com`
  const owner = await prisma.user.create({
    data: { name: `Test Owner ${slug}`, email, passwordHash, emailVerifiedAt: new Date(), role: 'USER' },
  })
  const org = await prisma.organisation.create({
    data: {
      name: `${PREFIX}${slug}`,
      subdomain: `${PREFIX}${slug}`.toLowerCase(),
      email,
      currency: 'KES',
      quotePrefix: 'TD',
      ownerId: owner.id,
      members: { connect: { id: owner.id } },
      subscription: { create: { plan, status: 'ACTIVE', trialEndsAt: new Date(Date.now() + 30 * 86400000), currentPeriodEndsAt: new Date(Date.now() + 30 * 86400000), simulated: true } },
    },
  })
  await prisma.user.update({ where: { id: owner.id }, data: { organisationId: org.id } })

  const ownerLogin = await login(email, password)
  expect(ownerLogin.status).toBe(200)

  const memberPassword = 'MemberPass123!'
  const memberHash = await bcrypt.hash(memberPassword, 10)
  await prisma.user.create({
    data: {
      name: `Test Member ${slug}`,
      email: `${EMAIL_PREFIX}${slug}-member@test.com`,
      passwordHash: memberHash,
      emailVerifiedAt: new Date(),
      role: 'USER',
      teamRole: 'MEMBER',
      organisationId: org.id,
    },
  })
  const memberLogin = await login(`${EMAIL_PREFIX}${slug}-member@test.com`, memberPassword)
  expect(memberLogin.status).toBe(200)

  let adminCookie = ''
  if (withAdmin) {
    const adminPassword = 'AdminPass123!'
    await prisma.user.create({
      data: {
        name: `Test Admin ${slug}`,
        email: `${EMAIL_PREFIX}${slug}-admin@test.com`,
        passwordHash: await bcrypt.hash(adminPassword, 10),
        emailVerifiedAt: new Date(),
        role: 'USER',
        teamRole: 'ADMIN',
        organisationId: org.id,
      },
    })
    const adminLogin = await login(`${EMAIL_PREFIX}${slug}-admin@test.com`, adminPassword)
    expect(adminLogin.status).toBe(200)
    adminCookie = cookieOf(adminLogin)
  }

  return { orgId: org.id, ownerCookie: cookieOf(ownerLogin), memberCookie: cookieOf(memberLogin), adminCookie, plan }
}

async function cleanUp() {
  const orgs = await prisma.organisation.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })
  const ids = orgs.map((org) => org.id)
  if (ids.length) {
    await prisma.quoteDelivery.deleteMany({ where: { quote: { organisationId: { in: ids } } } })
    await prisma.quote.deleteMany({ where: { organisationId: { in: ids } } })
    await prisma.customer.deleteMany({ where: { organisationId: { in: ids } } })
    await prisma.organisation.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.session.deleteMany()
  await prisma.user.deleteMany({ where: { email: { contains: PREFIX, mode: 'insensitive' } } })
  await prisma.loginAttempt.deleteMany({ where: { key: { contains: PREFIX, mode: 'insensitive' } } })
}

describe('Document design settings API', { skip: !TEST_DB && 'No DATABASE_URL — skipping tests that need PostgreSQL' }, () => {
  const savedFlags = { ...process.env }

  beforeAll(async () => {
    // The endpoints are off unless the deployment turns the feature on; the tests exercise them.
    process.env.DOCUMENT_DESIGN_ENABLED = '1'
    process.env.SERVER_PDF_ENABLED = '1'
    await cleanUp()
  })

  afterAll(async () => {
    await cleanUp()
    process.env.DOCUMENT_DESIGN_ENABLED = savedFlags.DOCUMENT_DESIGN_ENABLED
    if (savedFlags.DOCUMENT_DESIGN_ENABLED === undefined) delete process.env.DOCUMENT_DESIGN_ENABLED
    process.env.SERVER_PDF_ENABLED = savedFlags.SERVER_PDF_ENABLED
    if (savedFlags.SERVER_PDF_ENABLED === undefined) delete process.env.SERVER_PDF_ENABLED
    await prisma.$disconnect()
  })

  describe('when the feature flag is off', () => {
    it('returns 404 rather than leaking an unreleased feature', async () => {
      const starter = await makeWorkspace('flag-off', 'STARTER')
      delete process.env.DOCUMENT_DESIGN_ENABLED
      try {
        const res = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
        expect(res.status).toBe(404)
      } finally {
        process.env.DOCUMENT_DESIGN_ENABLED = '1'
      }
    })
  })

  describe('reading and writing', () => {
    let starter: Workspace

    beforeAll(async () => {
      starter = await makeWorkspace('starter', 'STARTER', true)
    })

    it('returns the default design for a workspace that has never saved one', async () => {
      const res = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      expect(res.status).toBe(200)
      expect(res.body.design.template).toBe('modern')
      expect(res.body.design.brandColor).toBe('#1a5c3f')
      expect(res.body.design.text.quoteTitle).toBe('Quotation')
      expect(res.body.identity).toEqual({ kraPin: '', vatNumber: '', address: '' })
      expect(res.body.templateLocked).toBe(false)
    })

    it('lists every template with whether the plan allows it', async () => {
      const res = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      const byKey = Object.fromEntries((res.body.templates as Array<{ key: string; allowed: boolean }>).map((t) => [t.key, t.allowed]))
      expect(byKey).toEqual({ modern: true, classic: true, minimal: false, compact: false, bold: false })
    })

    it('saves a design and reads it back', async () => {
      const design = {
        template: 'classic',
        brandColor: '#2b6cb0',
        logo: { scale: 120 },
        show: { qr: false },
        text: { quoteTitle: 'Quotation', footer: 'Asante sana.' },
        payment: { paybill: '123456', till: '' },
      }
      const put = await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design })
      expect(put.status).toBe(200)
      expect(put.body.design.template).toBe('classic')
      expect(put.body.design.brandColor).toBe('#2b6cb0')
      expect(put.body.design.logo.scale).toBe(120)
      expect(put.body.design.show.qr).toBe(false)
      expect(put.body.design.text.footer).toBe('Asante sana.')
      expect(put.body.design.payment.paybill).toBe('123456')
      // Classic's preset wins for keys the request did not name.
      expect(put.body.design.typeface).toBe('serif')
      expect(put.body.design.table).toBe('boxed')

      const get = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      expect(get.body.design).toEqual(put.body.design)
    })

    it('saves the tax and identity fields alongside the design', async () => {
      const res = await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', starter.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'classic' }, identity: { kraPin: 'A123456789Z', vatNumber: 'VAT-001', address: 'P.O. Box 1, Nairobi' } })
      expect(res.status).toBe(200)
      expect(res.body.identity).toEqual({ kraPin: 'A123456789Z', vatNumber: 'VAT-001', address: 'P.O. Box 1, Nairobi' })
    })

    it('rejects a malformed KRA PIN', async () => {
      const res = await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', starter.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'classic' }, identity: { kraPin: 'not-a-pin' } })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('KRA PIN')
    })

    it('leaves the identity fields alone when the request omits them', async () => {
      const before = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'modern' } })
      const after = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      expect(after.body.identity).toEqual(before.body.identity)
    })

    it('reports every validation problem, not just the first', async () => {
      const res = await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', starter.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { brandColor: 'blue', payment: { paybill: '12' } } })
      expect(res.status).toBe(400)
      expect((res.body.errors as string[]).length).toBeGreaterThanOrEqual(2)
    })

    it('rejects unknown keys so a typo cannot be silently ignored', async () => {
      const res = await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', starter.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'modern', brandColour: '#000000' } })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('brandColour')
    })

    it('lets an ADMIN save, not only the owner', async () => {
      const res = await request(app).put('/api/settings/document-design').set('Cookie', starter.adminCookie).set('Origin', ORIGIN).send({ design: { template: 'modern' } })
      expect(res.status).toBe(200)
    })

    it('refuses a MEMBER on both read and write', async () => {
      const read = await request(app).get('/api/settings/document-design').set('Cookie', starter.memberCookie).set('Origin', ORIGIN)
      expect(read.status).toBe(403)
      const write = await request(app).put('/api/settings/document-design').set('Cookie', starter.memberCookie).set('Origin', ORIGIN).send({ design: { template: 'modern' } })
      expect(write.status).toBe(403)
    })

    it('refuses a request with no session', async () => {
      const res = await request(app).get('/api/settings/document-design').set('Origin', ORIGIN)
      expect(res.status).toBe(401)
    })
  })

  describe('plan gating on the template', () => {
    let starter: Workspace
    let growth: Workspace

    beforeAll(async () => {
      starter = await makeWorkspace('gate-starter', 'STARTER')
      growth = await makeWorkspace('gate-growth', 'GROWTH')
    })

    it('refuses a Growth-only template on Starter with the plan feature code', async () => {
      const res = await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'bold' } })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('PLAN_FEATURE_UNAVAILABLE')
      expect(res.body.template).toBe('bold')
      expect(res.body.message).toContain('Team')
    })

    it('does not change the stored design when the template is refused', async () => {
      await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'classic' } })
      await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'bold' } })
      const get = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      expect(get.body.design.template).toBe('classic')
    })

    it('allows Minimal on Growth but refuses Bold', async () => {
      const minimal = await request(app).put('/api/settings/document-design').set('Cookie', growth.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'minimal' } })
      expect(minimal.status).toBe(200)
      const bold = await request(app).put('/api/settings/document-design').set('Cookie', growth.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'bold' } })
      expect(bold.status).toBe(403)
      expect(bold.body.message).toContain('Team')
    })

    it('falls back to Modern and reports the lock when a saved template is no longer on the plan', async () => {
      // Simulates a downgrade: the row says minimal, the plan is now Starter.
      await prisma.organisation.update({
        where: { id: starter.orgId },
        data: { documentDesign: { template: 'minimal', typeface: 'sans', header: 'plain', table: 'minimal', total: 'rule', spacing: 'comfortable', brandColor: '#aa3311' } },
      })
      const res = await request(app).get('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN)
      expect(res.status).toBe(200)
      expect(res.body.templateLocked).toBe(true)
      expect(res.body.design.template).toBe('modern')
      // Colours survive: only the template's layout is gated.
      expect(res.body.design.brandColor).toBe('#aa3311')
      // The stored value is kept so an upgrade restores it.
      expect(res.body.saved.template).toBe('minimal')
      const colourSave = await request(app).put('/api/settings/document-design').set('Cookie', starter.ownerCookie).set('Origin', ORIGIN).send({ design: { template: 'modern', brandColor: '#224466' } })
      expect(colourSave.status).toBe(200)
      expect(colourSave.body.design.template).toBe('modern')
      expect(colourSave.body.design.brandColor).toBe('#224466')
      expect(colourSave.body.saved.template).toBe('minimal')
    })

    it('resets to the template defaults, keeping identity fields', async () => {
      const res = await request(app).post('/api/settings/document-design/reset').set('Cookie', growth.ownerCookie).set('Origin', ORIGIN).send({ template: 'minimal' })
      expect(res.status).toBe(200)
      expect(res.body.design.template).toBe('minimal')
      expect(res.body.design.brandColor).toBe('#1a5c3f')
      expect(res.body.design.logo.scale).toBe(100)
    })

    it('refuses to reset to a template the plan does not include', async () => {
      const res = await request(app).post('/api/settings/document-design/reset').set('Cookie', growth.ownerCookie).set('Origin', ORIGIN).send({ template: 'bold' })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('PLAN_FEATURE_UNAVAILABLE')
    })
  })

  describe('tenant isolation', () => {
    let alpha: Workspace
    let beta: Workspace

    beforeAll(async () => {
      alpha = await makeWorkspace('alpha', 'GROWTH')
      beta = await makeWorkspace('beta', 'GROWTH')
    })

    it('does not show one workspace the design another saved', async () => {
      await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', alpha.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'classic', brandColor: '#123456' }, identity: { kraPin: 'A111111111Z' } })

      const betaRead = await request(app).get('/api/settings/document-design').set('Cookie', beta.ownerCookie).set('Origin', ORIGIN)
      expect(betaRead.body.design.brandColor).toBe('#1a5c3f')
      expect(betaRead.body.identity.kraPin).toBe('')
    })

    it('scopes a save to the caller, leaving the other workspace untouched', async () => {
      await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', beta.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'modern', brandColor: '#abcdef' } })

      const alphaRead = await request(app).get('/api/settings/document-design').set('Cookie', alpha.ownerCookie).set('Origin', ORIGIN)
      expect(alphaRead.body.design.brandColor).toBe('#123456')
      expect(alphaRead.body.design.template).toBe('classic')

      const alphaRow = await prisma.organisation.findUnique({ where: { id: alpha.orgId }, select: { documentDesign: true } })
      const betaRow = await prisma.organisation.findUnique({ where: { id: beta.orgId }, select: { documentDesign: true } })
      expect((alphaRow?.documentDesign as { brandColor?: string } | null)?.brandColor).toBe('#123456')
      expect((betaRow?.documentDesign as { brandColor?: string } | null)?.brandColor).toBe('#abcdef')
    })

    it('ignores an organisation id supplied in the body', async () => {
      await request(app)
        .put('/api/settings/document-design')
        .set('Cookie', beta.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ design: { template: 'modern', brandColor: '#000001' }, organisationId: alpha.orgId })

      const alphaRead = await request(app).get('/api/settings/document-design').set('Cookie', alpha.ownerCookie).set('Origin', ORIGIN)
      expect(alphaRead.body.design.brandColor).toBe('#123456')
    })

    it('exposes design snapshots only through the owning workspace', async () => {
      // A quote living in alpha, with a snapshot, is invisible to beta.
      const alphaOwner = await prisma.user.findFirst({ where: { organisationId: alpha.orgId, teamRole: 'OWNER' }, select: { id: true } })
      const customer = await prisma.customer.create({
        data: { name: `${PREFIX}customer-alpha`, phone: '+254700000010', organisationId: alpha.orgId, ownerId: alphaOwner!.id },
      })
      const quote = await prisma.quote.create({
        data: {
          documentNumber: `${PREFIX}Q-1`,
          publicToken: `${PREFIX.toLowerCase()}public-alpha`,
          organisationId: alpha.orgId,
          ownerId: alphaOwner!.id,
          customerId: customer.id,
          currency: 'KES',
          subtotal: 100,
          taxTotal: 16,
          total: 116,
          status: 'SENT',
          designSnapshot: { template: 'classic', brandColor: '#123456' },
          lines: { create: [{ description: 'Line', quantity: 1, unit: 'job', unitPrice: 100, taxRate: 16, position: 0 }] },
        },
      })

      const betaGet = await request(app).get(`/api/quotes/${quote.id}`).set('Cookie', beta.ownerCookie).set('Origin', ORIGIN)
      expect([403, 404]).toContain(betaGet.status)
      expect(JSON.stringify(betaGet.body)).not.toContain('#123456')

      const betaPdf = await request(app).get(`/api/quotes/${quote.id}/pdf`).set('Cookie', beta.ownerCookie).set('Origin', ORIGIN)
      expect(betaPdf.status).toBe(404)
      const alphaPdf = await request(app).get(`/api/quotes/${quote.id}/pdf`).set('Cookie', alpha.ownerCookie).set('Origin', ORIGIN)
      expect(alphaPdf.status).toBe(200)
      expect(alphaPdf.headers['content-type']).toContain('application/pdf')
      expect(alphaPdf.body.subarray(0, 5).toString()).toBe('%PDF-')
      const publicPdf = await request(app).get(`/api/public/quotes/${quote.publicToken}/pdf`).set('Origin', ORIGIN)
      expect(publicPdf.status).toBe(200)
      expect(publicPdf.headers['content-type']).toContain('application/pdf')

      const alphaGet = await request(app).get(`/api/quotes/${quote.id}`).set('Cookie', alpha.ownerCookie).set('Origin', ORIGIN)
      expect(alphaGet.status).toBe(200)
      // The editor must not change the frozen snapshot by editing and saving.
      const put = await request(app)
        .put(`/api/quotes/${quote.id}`)
        .set('Cookie', alpha.ownerCookie)
        .set('Origin', ORIGIN)
        .send({ notes: 'Edited after sending' })
      if (put.status === 200) {
        const stored = await prisma.quote.findUnique({ where: { id: quote.id }, select: { designSnapshot: true } })
        expect(stored?.designSnapshot).toEqual({ template: 'classic', brandColor: '#123456' })
      }
    })
  })
})
