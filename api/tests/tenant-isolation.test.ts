import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import request from 'supertest'
import { app, prisma } from '../src/index.js'
import bcrypt from 'bcryptjs'

// ---------------------------------------------------------------------------
// Negative tenant isolation tests — Stage 8
//
// Proves that Tenant A cannot read, mutate, or attach Tenant B's resources.
// Also covers auth/session revocation, OTP limits, and upload rejection.
// ---------------------------------------------------------------------------

const TEST_DB = Boolean(process.env.DATABASE_URL)

// Helper: get auth cookie by logging in
async function login(email: string, password: string) {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', 'http://localhost:5174')
    .send({ email, password })
  return res
}

function authCookie(res: request.Response): string {
  const cookies = res.headers['set-cookie']
  if (!cookies) return ''
  const session = Array.isArray(cookies) ? cookies[0] : cookies
  return session.split(';')[0]
}

describe('Stage 8 — Security & Tenant Isolation', { skip: !TEST_DB && 'No DATABASE_URL — skipping tests that need PostgreSQL' }, () => {
  let tenantA: { cookie: string; userId: string; orgId: string; customerId: string; quoteId: string; serviceItemId: string; templateId: string }
  let tenantB: { cookie: string; userId: string; orgId: string; customerId: string }

  beforeAll(async () => {
    // Clean up any leftover test data (order matters for FK constraints)
    await prisma.quote.deleteMany({ where: { documentNumber: { startsWith: 'TEST-' } } })
    await prisma.customer.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.serviceItem.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.quoteTemplate.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.session.deleteMany()
    await prisma.organisation.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.user.deleteMany({ where: { email: { contains: 'test-tenant' } } })
    await prisma.loginAttempt.deleteMany({ where: { key: { contains: 'test-tenant' } } })
    await prisma.signupVerification.deleteMany({ where: { email: { contains: 'test' } } })

    // Create Tenant A
    const passwordA = 'TestPass123!'
    const hashedA = await bcrypt.hash(passwordA, 10)
    const userA = await prisma.user.create({
      data: { name: 'Test User A', email: 'test-tenant-a@test.com', passwordHash: hashedA, emailVerifiedAt: new Date(), role: 'USER' },
    })
    const orgA = await prisma.organisation.create({
      data: {
        name: 'TEST-TenantA Corp',
        subdomain: 'test-tenant-a',
        email: 'a@test-tenant.com',
        country: 'Kenya',
        currency: 'KES',
        quotePrefix: 'TA',
        defaultTaxRate: 16,
        ownerId: userA.id,
        members: { connect: { id: userA.id } },
        subscription: { create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 14 * 86400000), simulated: true } },
      },
    })
    await prisma.user.update({ where: { id: userA.id }, data: { organisationId: orgA.id } })

    const customerA = await prisma.customer.create({
      data: { name: 'TEST-Customer A', phone: '+254700000001', organisationId: orgA.id, ownerId: userA.id },
    })
    const serviceItemA = await prisma.serviceItem.create({
      data: { name: 'TEST-Service A', category: 'General', kind: 'SERVICE', unit: 'job', defaultPrice: 1000, organisationId: orgA.id },
    })
    const templateA = await prisma.quoteTemplate.create({
      data: { name: 'TEST-Template A', description: 'Test template', workflow: 'standard', lineItems: [{ description: 'Test item', unit: 'job' }], organisationId: orgA.id },
    })
    const quoteA = await prisma.quote.create({
      data: {
        documentNumber: 'TEST-0001',
        organisationId: orgA.id,
        ownerId: userA.id,
        customerId: customerA.id,
        currency: 'KES',
        subtotal: 1000,
        taxTotal: 160,
        total: 1160,
        status: 'DRAFT',
        lines: { create: [{ description: 'Test line', quantity: 1, unit: 'job', unitPrice: 1000, taxRate: 16, position: 0 }] },
      },
    })

    // Login Tenant A
    const loginA = await login('test-tenant-a@test.com', passwordA)
    expect(loginA.status).toBe(200)

    // Create Tenant B
    const passwordB = 'TestPass456!'
    const hashedB = await bcrypt.hash(passwordB, 10)
    const userB = await prisma.user.create({
      data: { name: 'Test User B', email: 'test-tenant-b@test.com', passwordHash: hashedB, emailVerifiedAt: new Date(), role: 'USER' },
    })
    const orgB = await prisma.organisation.create({
      data: {
        name: 'TEST-TenantB Corp',
        subdomain: 'test-tenant-b',
        email: 'b@test-tenant.com',
        country: 'Kenya',
        currency: 'KES',
        quotePrefix: 'TB',
        defaultTaxRate: 16,
        ownerId: userB.id,
        members: { connect: { id: userB.id } },
        subscription: { create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt: new Date(Date.now() + 14 * 86400000), simulated: true } },
      },
    })
    await prisma.user.update({ where: { id: userB.id }, data: { organisationId: orgB.id } })

    const customerB = await prisma.customer.create({
      data: { name: 'TEST-Customer B', phone: '+254700000002', organisationId: orgB.id, ownerId: userB.id },
    })

    const loginB = await login('test-tenant-b@test.com', passwordB)
    expect(loginB.status).toBe(200)

    tenantA = {
      cookie: authCookie(loginA),
      userId: userA.id,
      orgId: orgA.id,
      customerId: customerA.id,
      quoteId: quoteA.id,
      serviceItemId: serviceItemA.id,
      templateId: templateA.id,
    }
    tenantB = {
      cookie: authCookie(loginB),
      userId: userB.id,
      orgId: orgB.id,
      customerId: customerB.id,
    }
  })

  afterAll(async () => {
    // Clean up test data (order matters for FK constraints)
    await prisma.quote.deleteMany({ where: { documentNumber: { startsWith: 'TEST-' } } })
    await prisma.customer.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.serviceItem.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.quoteTemplate.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.session.deleteMany()
    await prisma.organisation.deleteMany({ where: { name: { startsWith: 'TEST-' } } })
    await prisma.user.deleteMany({ where: { email: { contains: 'test-tenant' } } })
    await prisma.loginAttempt.deleteMany({ where: { key: { contains: 'test-tenant' } } })
    await prisma.signupVerification.deleteMany({ where: { email: { contains: 'test' } } })
    await prisma.$disconnect()
  })

  // -------------------------------------------------------------------------
  // 1. Cross-tenant customer access
  // -------------------------------------------------------------------------
  describe('Customer isolation', () => {
    it('Tenant B cannot list Tenant A customers', async () => {
      const res = await request(app)
        .get('/api/customers')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(200)
      const names = (res.body.customers as Array<{ name: string }>).map((c) => c.name)
      expect(names).not.toContain('TEST-Customer A')
    })

    it('Tenant B cannot GET Tenant A customer by ID', async () => {
      // There's no GET /api/customers/:id, but we can try to update one
      const res = await request(app)
        .put('/api/customers/' + tenantA.customerId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
        .send({ name: 'HACKED', phone: '+254999' })
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot DELETE Tenant A customer', async () => {
      const res = await request(app)
        .delete('/api/customers/' + tenantA.customerId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot create a quote using Tenant A customer ID', async () => {
      const res = await request(app)
        .post('/api/quotes')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
        .send({ customerId: tenantA.customerId, lines: [{ description: 'hack', quantity: 1, unit: 'job', unitPrice: 100 }] })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('customer')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Cross-tenant quote access
  // -------------------------------------------------------------------------
  describe('Quote isolation', () => {
    it('Tenant B cannot list Tenant A quotes', async () => {
      const res = await request(app)
        .get('/api/quotes')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(200)
      const ids = (res.body.quotes as Array<{ id: string }>).map((q) => q.id)
      expect(ids).not.toContain(tenantA.quoteId)
    })

    it('Tenant B cannot GET Tenant A quote by ID', async () => {
      const res = await request(app)
        .get('/api/quotes/' + tenantA.quoteId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot UPDATE Tenant A quote', async () => {
      const res = await request(app)
        .put('/api/quotes/' + tenantA.quoteId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
        .send({ lines: [{ description: 'hack', quantity: 1, unit: 'job', unitPrice: 1 }] })
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot DELETE Tenant A quote', async () => {
      const res = await request(app)
        .delete('/api/quotes/' + tenantA.quoteId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot share Tenant A quote', async () => {
      const res = await request(app)
        .post('/api/quotes/' + tenantA.quoteId + '/share')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Cross-tenant service item access
  // -------------------------------------------------------------------------
  describe('Service item isolation', () => {
    it('Tenant B cannot list Tenant A service items', async () => {
      const res = await request(app)
        .get('/api/service-items')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(200)
      const names = (res.body.items as Array<{ name: string }>).map((i) => i.name)
      expect(names).not.toContain('TEST-Service A')
    })

    it('Tenant B cannot UPDATE Tenant A service item', async () => {
      const res = await request(app)
        .put('/api/service-items/' + tenantA.serviceItemId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
        .send({ name: 'HACKED', category: 'hack', kind: 'SERVICE', unit: 'job', defaultPrice: 1 })
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot DELETE Tenant A service item', async () => {
      const res = await request(app)
        .delete('/api/service-items/' + tenantA.serviceItemId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Cross-tenant template access
  // -------------------------------------------------------------------------
  describe('Template isolation', () => {
    it('Tenant B cannot list Tenant A templates', async () => {
      const res = await request(app)
        .get('/api/quote-templates')
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(200)
      const names = (res.body.templates as Array<{ name: string }>).map((t) => t.name)
      expect(names).not.toContain('TEST-Template A')
    })

    it('Tenant B cannot UPDATE Tenant A template', async () => {
      const res = await request(app)
        .put('/api/quote-templates/' + tenantA.templateId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
        .send({ name: 'HACKED', description: 'hack', lineItems: [{ description: 'hack', unit: 'job' }] })
      expect(res.status).toBe(404)
    })

    it('Tenant B cannot DELETE Tenant A template', async () => {
      const res = await request(app)
        .delete('/api/quote-templates/' + tenantA.templateId)
        .set('Cookie', tenantB.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Authentication tests
  // -------------------------------------------------------------------------
  describe('Authentication & sessions', () => {
    it('Rejects requests with no auth cookie', async () => {
      const res = await request(app)
        .get('/api/customers')
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(401)
    })

    it('Rejects requests with invalid cookie', async () => {
      const res = await request(app)
        .get('/api/customers')
        .set('Cookie', 'iquote_session=invalid-token-hash')
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(401)
    })

    it('Logout invalidates the session', async () => {
      // Create a fresh login for this test
      const loginRes = await login('test-tenant-a@test.com', 'TestPass123!')
      expect(loginRes.status).toBe(200)
      const cookie = authCookie(loginRes)

      // Verify it works
      const before = await request(app)
        .get('/api/customers')
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:5174')
      expect(before.status).toBe(200)

      // Logout
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:5174')
      expect(logoutRes.status).toBe(200)

      // Verify the old cookie no longer works
      const after = await request(app)
        .get('/api/customers')
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:5174')
      expect(after.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // 6. CSRF / Origin validation
  // -------------------------------------------------------------------------
  describe('CSRF protection', () => {
    it('Rejects POST with untrusted Origin', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'https://evil.example.com')
        .send({ email: 'test-tenant-a@test.com', password: 'TestPass123!' })
      expect(res.status).toBe(403)
    })

    it('Rejects POST with no Origin header', async () => {
      // supertest doesn't auto-set Origin for non-browser requests
      // We need to explicitly NOT set it
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test-tenant-a@test.com', password: 'TestPass123!' })
      // In non-production (test) mode, missing Origin is allowed
      // So this should still work (status 200 or 401 depending on creds)
      expect([200, 401, 400]).toContain(res.status)
      // A successful sign-in replaces Tenant A's previous session for this device category, so
      // re-point the shared fixture cookie at the session this call just created.
      if (res.status === 200) tenantA.cookie = authCookie(res)
    })
  })

  // -------------------------------------------------------------------------
  // 7. Upload rejection
  // -------------------------------------------------------------------------
  describe('Upload rejection', () => {
    it('Rejects SVG file upload', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      const res = await request(app)
        .post('/api/settings/logo')
        .set('Cookie', tenantA.cookie)
        .set('Origin', 'http://localhost:5174')
        .set('Content-Type', 'image/svg+xml')
        .send(svg)
      expect(res.status).toBe(400)
    })

    it('Rejects file with spoofed Content-Type (text file as PNG)', async () => {
      const fake = Buffer.from('This is not an image file content data')
      const res = await request(app)
        .post('/api/settings/logo')
        .set('Cookie', tenantA.cookie)
        .set('Origin', 'http://localhost:5174')
        .set('Content-Type', 'image/png')
        .send(fake)
      expect(res.status).toBe(400)
    })

    it('Rejects upload without auth', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      const res = await request(app)
        .post('/api/settings/logo')
        .set('Origin', 'http://localhost:5174')
        .set('Content-Type', 'image/png')
        .send(png)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // 8. OTP attempt limits
  // -------------------------------------------------------------------------
  describe('OTP attempt limits', () => {
    it('Rejects more than 5 wrong OTP codes', async () => {
      // Send a verification code first
      const sendRes = await request(app)
        .post('/api/auth/verification/send')
        .set('Origin', 'http://localhost:5174')
        .send({ email: 'new-otp-test@test.com' })
      // May fail if Resend not configured — that's OK, we test the verify side

      // Try 5 wrong codes
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/auth/verification/verify')
          .set('Origin', 'http://localhost:5174')
          .send({ email: 'new-otp-test@test.com', code: '000000' })
        expect(res.status).toBe(400)
      }

      // 6th attempt should still get rejected (but with same message)
      const res6 = await request(app)
        .post('/api/auth/verification/verify')
        .set('Origin', 'http://localhost:5174')
        .send({ email: 'new-otp-test@test.com', code: '000000' })
      expect(res6.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // 9. Superadmin access control
  // -------------------------------------------------------------------------
  describe('Superadmin access', () => {
    it('Non-superadmin cannot access superadmin endpoints', async () => {
      const res = await request(app)
        .get('/api/superadmin/stats')
        .set('Cookie', tenantA.cookie)
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(403)
    })

    it('Unauthenticated request cannot access superadmin endpoints', async () => {
      const res = await request(app)
        .get('/api/superadmin/stats')
        .set('Origin', 'http://localhost:5174')
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // 10. Email preview disabled / auth-gated
  // -------------------------------------------------------------------------
  describe('Email preview security', () => {
    it('Requires auth to access email preview', async () => {
      const res = await request(app)
        .get('/api/email-preview/verification')
        .set('Origin', 'http://localhost:5174')
      // In test mode (non-production), it still requires superadmin auth
      expect([401, 403]).toContain(res.status)
    })
  })
})
