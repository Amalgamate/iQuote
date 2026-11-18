import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto'
import { getIndustryPack } from './industry-packs.js'

const prisma = new PrismaClient()
const app = express()
const port = Number(process.env.PORT ?? 4000)
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me'
const sessionCookieName = 'iquote_session'
const emailEncryptionKey = process.env.EMAIL_SETTINGS_ENCRYPTION_KEY

function encryptEmailSecret(value: string) {
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) throw new Error('Email settings encryption is not configured on the server.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHmac('sha256', 'iquote-email-settings').update(emailEncryptionKey).digest(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`
}

function decryptEmailSecret(value: string) {
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) throw new Error('Email settings encryption is not configured on the server.')
  const [ivText, tagText, encryptedText] = value.split('.')
  if (!ivText || !tagText || !encryptedText) throw new Error('Stored email credential is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', createHmac('sha256', 'iquote-email-settings').update(emailEncryptionKey).digest(), Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8')
}

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
)
app.use(express.json())
app.use(cookieParser())

function readTokenFromRequest(req: Request) {
  const cookieToken = req.cookies?.[sessionCookieName]
  if (cookieToken) return cookieToken

  const headerToken = req.headers.authorization
  if (headerToken && headerToken.startsWith('Bearer ')) {
    return headerToken.slice('Bearer '.length)
  }

  return null
}

function sendSessionCookie(res: Response, token: string) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

async function issueSession(userId: string) {
  const token = jwt.sign({ sub: userId }, jwtSecret, { expiresIn: '7d' })
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await prisma.session.upsert({
    where: { token },
    update: { userId, expiresAt },
    create: { token, userId, expiresAt },
  })

  return token
}

function toPublicUser(user: { id: string; name: string; email: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  }
}

function getRequestUser(req: Request) {
  return (req as Request & { user?: { id: string; name: string; email: string } }).user
}

function verificationDigest(email: string, code: string) {
  return createHmac('sha256', jwtSecret).update(`${email}:${code}`).digest('hex')
}

function createdEmailKey(email: string) {
  return createHmac('sha256', jwtSecret).update(email).digest('hex')
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

async function sendEmail(to: string, subject: string, html: string, idempotencyKey: string, organisationId?: string) {
  const tenantSettings = organisationId ? await prisma.tenantEmailSettings.findUnique({ where: { organisationId } }) : null
  const tenantKey = tenantSettings?.provider === 'CUSTOM' && tenantSettings.resendApiKeyCiphertext ? decryptEmailSecret(tenantSettings.resendApiKeyCiphertext) : null
  const apiKey = tenantKey ?? process.env.RESEND_API_KEY
  const from = tenantKey && tenantSettings?.senderEmail ? `${tenantSettings.senderName || 'iQuote'} <${tenantSettings.senderEmail}>` : process.env.RESEND_FROM_EMAIL
  if (!apiKey || !from) return false

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  })
  if (!response.ok) {
    console.error(`Resend email failed (${response.status}).`)
    throw new Error('Email delivery failed. Check the Resend API key and verified sender address.')
  }
  if (tenantSettings?.provider === 'CUSTOM' && tenantSettings.customDomain && tenantSettings.domainStatus !== 'VERIFIED') {
    const domainResponse = await fetch(`https://api.resend.com/domains`, { headers: { Authorization: `Bearer ${tenantKey}` } })
    if (domainResponse.ok) {
      const domains = await domainResponse.json() as { data?: Array<{ name?: string; status?: string; records?: unknown[] }> }
      const domain = domains.data?.find((item) => item.name?.toLowerCase() === tenantSettings.customDomain?.toLowerCase())
      if (domain?.status === 'verified') {
        await prisma.tenantEmailSettings.update({ where: { organisationId: tenantSettings.organisationId }, data: { domainStatus: 'VERIFIED', verifiedAt: new Date(), domainRecords: domain.records as object[] | undefined } })
      }
    }
  }
  return true
}

async function getOrganisationId(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { organisationId: true } })
  if (user?.organisationId) return user.organisationId
  const owned = await prisma.organisation.findFirst({ where: { ownerId: userId }, select: { id: true } })
  return owned?.id ?? null
}

async function ensureIndustryDefaults(organisationId: string) {
  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { businessType: true } })
  if (!organisation) return
  const pack = getIndustryPack(organisation.businessType)
  await prisma.serviceItem.createMany({
    data: pack.services.map((item) => ({ organisationId, ...item, isStarter: true })),
    skipDuplicates: true,
  })
  await prisma.quoteTemplate.createMany({
    data: pack.templates.map((template) => ({ organisationId, ...template, isStarter: true })),
    skipDuplicates: true,
  })
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizeQuoteLines(input: unknown, defaultTaxRate: number) {
  if (!Array.isArray(input)) return null
  const lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; taxRate: number | null; position: number }> = []

  for (const [position, value] of input.entries()) {
    if (!value || typeof value !== 'object') return null
    const line = value as Record<string, unknown>
    const description = String(line.description ?? '').trim()
    if (!description) continue
    const quantity = Number(line.quantity)
    const unitPrice = Number(line.unitPrice)
    const rawTax = line.taxRate === '' || line.taxRate === undefined ? defaultTaxRate : line.taxRate
    const taxRate = rawTax === null ? null : Number(rawTax)
    const unit = String(line.unit ?? 'unit').trim() || 'unit'

    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return null
    if (taxRate !== null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)) return null
    lines.push({ description, quantity, unit, unitPrice, taxRate, position })
  }

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0))
  const taxTotal = roundMoney(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice * (line.taxRate ?? 0) / 100, 0))
  return { lines, subtotal, taxTotal, total: roundMoney(subtotal + taxTotal) }
}

function serializeQuote<T extends { subtotal: unknown; taxTotal: unknown; total: unknown; lines?: Array<{ quantity: unknown; unitPrice: unknown; taxRate: unknown }> }>(quote: T) {
  return {
    ...quote,
    subtotal: Number(quote.subtotal),
    taxTotal: Number(quote.taxTotal),
    total: Number(quote.total),
    lines: quote.lines?.map((line) => ({ ...line, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice), taxRate: line.taxRate === null ? null : Number(line.taxRate) })),
  }
}

async function loadUserFromToken(token: string) {
  try {
    const payload = jwt.verify(token, jwtSecret) as { sub: string }
    const session = await prisma.session.findFirst({ where: { token, expiresAt: { gt: new Date() } } })
    if (!session) return null
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true },
    })

    return user ? toPublicUser(user) : null
  } catch {
    return null
  }
}

const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = readTokenFromRequest(req)
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const user = await loadUserFromToken(token)
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  ;(req as Request & { user?: typeof user }).user = user
  next()
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, service: 'iQuote API' })
})

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')
  const businessName = String(req.body?.businessName ?? '').trim()
  const businessType = String(req.body?.businessType ?? '').trim() || null
  const country = String(req.body?.country ?? '').trim()
  const phone = String(req.body?.phone ?? '').trim() || null
  const plan = String(req.body?.plan ?? 'STARTER').toUpperCase()

  if (!name || !email || password.length < 8 || !businessName || !country) {
    return res.status(400).json({ message: 'Name, email, password, business name and country are required.' })
  }
  if (!['STARTER', 'GROWTH', 'TEAM'].includes(plan)) return res.status(400).json({ message: 'Choose an available plan.' })

  const verification = await prisma.signupVerification.findUnique({ where: { email } })
  if (!verification?.verifiedAt || verification.verifiedAt < new Date(Date.now() - 15 * 60 * 1000)) {
    return res.status(403).json({ message: 'Verify your email before creating your workspace.' })
  }

  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser) {
    return res.status(409).json({ message: 'An account with that email already exists.' })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  const safeBusinessName = escapeHtml(businessName)
  const safeEmail = escapeHtml(email)
  const safeCountry = escapeHtml(country)
  const safeBusinessType = escapeHtml(businessType ?? 'Independent business')
  const safePhone = escapeHtml(phone ?? 'Not provided')
  const industryPack = getIndustryPack(businessType)
  const user = await prisma.$transaction(async (transaction) => {
    const created = await transaction.user.create({
      data: { name, email, passwordHash, emailVerifiedAt: verification.verifiedAt },
      select: { id: true, name: true, email: true },
    })
    const organisation = await transaction.organisation.create({
      data: {
        name: businessName,
        email,
        phone,
        country,
        businessType,
        defaultTaxRate: country === 'Kenya' ? 16 : 0,
        ownerId: created.id,
        currency: ({ Kenya: 'KES', Uganda: 'UGX', Tanzania: 'TZS', Rwanda: 'RWF', 'United Kingdom': 'GBP', 'United States': 'USD' } as Record<string, string>)[country] ?? 'USD',
        quotePrefix: 'QT',
        serviceItems: { create: industryPack.services.map((item) => ({ ...item, isStarter: true })) },
        quoteTemplates: { create: industryPack.templates.map((template) => ({ ...template, isStarter: true })) },
        members: { connect: { id: created.id } },
        subscription: {
          create: { plan, status: 'TRIALING', trialEndsAt, simulated: true },
        },
      },
    })
    await transaction.user.update({ where: { id: created.id }, data: { organisationId: organisation.id } })
    return { ...created, organisationId: organisation.id }
  })

  const welcomeEmailSent = await sendEmail(
    email,
    `Your ${businessName.replace(/[\r\n]/g, ' ').slice(0, 100)} iQuote workspace is ready`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1c1917"><p style="color:#0f766e;font-weight:700">iQuote · ${safeBusinessName}</p><h1>Your quoting workspace is ready.</h1><p>Your ${plan.toLowerCase()} plan is in a simulated 14-day trial through ${trialEndsAt.toLocaleDateString('en-GB')}.</p><h2>Your setup</h2><p>Business: ${safeBusinessName}<br>Business type: ${safeBusinessType}<br>Country: ${safeCountry}<br>Phone: ${safePhone}<br>Account email: ${safeEmail}</p><h2>Start in three steps</h2><ol><li>Add a customer and their contact details.</li><li>Create a quote with line items and terms.</li><li>Share its secure review link and track the decision.</li></ol><p>This local development trial does not collect payment details or charge you.</p></div>`,
    `welcome/${createdEmailKey(email)}`,
    user.organisationId ?? undefined,
  ).catch(() => false)

  const token = await issueSession(user.id)
  await prisma.signupVerification.deleteMany({ where: { email } })
  sendSessionCookie(res, token)

  res.status(201).json({ user: toPublicUser(user), welcomeEmailSent })
})

app.post('/api/auth/verification/send', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' })
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    return res.status(409).json({ message: 'An account with that email already exists. Sign in instead.' })
  }

  const existing = await prisma.signupVerification.findUnique({ where: { email } })
  if (existing && Date.now() - existing.lastSentAt.getTime() < 30_000) {
    return res.status(429).json({ message: 'Please wait before requesting another code.' })
  }

  const code = String(randomInt(100_000, 1_000_000))
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  if (!apiKey && process.env.NODE_ENV === 'production') return res.status(503).json({ message: 'Email verification is not configured. Add a Resend API key and verified sender address.' })
  if (apiKey && !from) return res.status(503).json({ message: 'Set RESEND_FROM_EMAIL to a verified sender address before sending email.' })
  let emailSent = false
  try {
    if (apiKey && from) {
      emailSent = await sendEmail(
        email,
        'Your iQuote verification code',
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1c1917"><p style="color:#0f766e;font-weight:700">iQuote</p><h1>Verify your email</h1><p>Enter this code to continue setting up your quoting workspace:</p><div style="padding:22px;text-align:center;background:#f1f8f6;color:#0f766e;font-size:32px;font-weight:700;letter-spacing:8px">${code}</div><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`,
        `verification/${email}/${code}`,
      )
    }
  } catch (error) {
    return res.status(502).json({ message: error instanceof Error ? error.message : 'Unable to send the verification email.' })
  }
  await prisma.signupVerification.upsert({
    where: { email },
    update: { codeHash: verificationDigest(email, code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), verifiedAt: null, attempts: 0, lastSentAt: new Date() },
    create: { email, codeHash: verificationDigest(email, code), expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  })
  const localSimulation = !apiKey && process.env.NODE_ENV !== 'production'
  res.json({ delivery: emailSent ? 'sent' : 'simulation', ...(localSimulation ? { devCode: code } : {}) })
}

app.get('/api/settings/email', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  const settings = await prisma.tenantEmailSettings.findUnique({ where: { organisationId } })
  res.json({
    provider: settings?.provider ?? 'PLATFORM',
    senderName: settings?.senderName ?? '',
    senderEmail: settings?.senderEmail ?? '',
    customDomain: settings?.customDomain ?? '',
    domainStatus: settings?.domainStatus ?? 'NOT_CONFIGURED',
    domainRecords: settings?.domainRecords ?? null,
    apiKeySet: Boolean(settings?.resendApiKeyCiphertext),
    encryptionReady: Boolean(emailEncryptionKey && emailEncryptionKey.length >= 32),
    platformSenderAvailable: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
  })
})

app.post('/api/settings/email/domain', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  const settings = await prisma.tenantEmailSettings.findUnique({ where: { organisationId } })
  if (!settings || settings.provider !== 'CUSTOM' || !settings.customDomain || !settings.resendApiKeyCiphertext) return res.status(400).json({ message: 'Save custom Resend delivery and a sender domain first.' })
  try {
    const response = await fetch('https://api.resend.com/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${decryptEmailSecret(settings.resendApiKeyCiphertext)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: settings.customDomain }),
    })
    const result = await response.json() as { id?: string; records?: Array<{ record?: string; name?: string; type?: string; value?: string; ttl?: string; status?: string }> ; message?: string }
    if (!response.ok && response.status !== 422) return res.status(502).json({ message: 'Resend could not create the domain. Check the key and try again.' })
    const records = result.records ?? []
    const updated = await prisma.tenantEmailSettings.update({ where: { organisationId }, data: { domainRecords: records, domainStatus: 'PENDING' } })
    return res.json({ domainStatus: updated.domainStatus, domainRecords: updated.domainRecords })
  } catch {
    return res.status(502).json({ message: 'Could not reach Resend to set up the domain.' })
  }
})

app.post('/api/settings/email/domain/check', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  const settings = await prisma.tenantEmailSettings.findUnique({ where: { organisationId } })
  if (!settings?.customDomain || !settings.resendApiKeyCiphertext) return res.status(400).json({ message: 'Configure a custom domain and Resend API key first.' })
  try {
    const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${decryptEmailSecret(settings.resendApiKeyCiphertext)}` } })
    if (!response.ok) return res.status(502).json({ message: 'Resend could not check the domain right now.' })
    const result = await response.json() as { data?: Array<{ name?: string; status?: string; records?: unknown[] }> }
    const domain = result.data?.find((item) => item.name?.toLowerCase() === settings.customDomain?.toLowerCase())
    if (!domain) return res.status(404).json({ message: 'Domain is not in this Resend account yet. Use Set up domain first.' })
    const verified = domain.status === 'verified'
    const updated = await prisma.tenantEmailSettings.update({ where: { organisationId }, data: { domainStatus: verified ? 'VERIFIED' : 'PENDING', verifiedAt: verified ? new Date() : null, domainRecords: domain.records as object[] | undefined } })
    return res.json({ domainStatus: updated.domainStatus, domainRecords: updated.domainRecords })
  } catch {
    return res.status(502).json({ message: 'Could not reach Resend to check the domain.' })
  }
})

app.put('/api/settings/email', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) return res.status(503).json({ message: 'Tenant email encryption is not configured by the platform yet.' })
  const provider = req.body?.provider === 'CUSTOM' ? 'CUSTOM' : 'PLATFORM'
  const senderName = String(req.body?.senderName ?? '').trim().slice(0, 100)
  const senderEmail = String(req.body?.senderEmail ?? '').trim().toLowerCase()
  const customDomain = String(req.body?.customDomain ?? '').trim().toLowerCase()
  const apiKey = String(req.body?.apiKey ?? '').trim()
  if (provider === 'CUSTOM') {
    if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) return res.status(400).json({ message: 'Enter a valid sender email address.' })
    if (customDomain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(customDomain) || customDomain !== senderEmail.split('@')[1])) {
      return res.status(400).json({ message: 'Use a valid domain that matches the sender email address.' })
    }
    if (apiKey && !apiKey.startsWith('re_')) return res.status(400).json({ message: 'That does not look like a Resend API key.' })
    if (!apiKey) {
      const existing = await prisma.tenantEmailSettings.findUnique({ where: { organisationId }, select: { resendApiKeyCiphertext: true } })
      if (!existing?.resendApiKeyCiphertext) return res.status(400).json({ message: 'Enter your Resend API key to use custom delivery.' })
    }
  }
  const existing = await prisma.tenantEmailSettings.findUnique({ where: { organisationId } })
  const encryptedKey = apiKey ? encryptEmailSecret(apiKey) : existing?.resendApiKeyCiphertext ?? null
  const domainChanged = customDomain !== (existing?.customDomain ?? '')
  const next = await prisma.tenantEmailSettings.upsert({
    where: { organisationId },
    create: {
      organisationId, provider, senderName: senderName || null, senderEmail: senderEmail || null,
      customDomain: customDomain || null, resendApiKeyCiphertext: encryptedKey,
      domainStatus: provider === 'CUSTOM' && customDomain ? 'PENDING' : 'NOT_CONFIGURED',
    },
    update: {
      provider, senderName: senderName || null, senderEmail: senderEmail || null,
      customDomain: customDomain || null, resendApiKeyCiphertext: encryptedKey,
      ...(domainChanged || provider !== 'CUSTOM' ? { domainStatus: provider === 'CUSTOM' && customDomain ? 'PENDING' : 'NOT_CONFIGURED', domainRecords: null, verifiedAt: null } : {}),
    },
  })
  res.json({ provider: next.provider, senderName: next.senderName ?? '', senderEmail: next.senderEmail ?? '', customDomain: next.customDomain ?? '', domainStatus: next.domainStatus, apiKeySet: Boolean(next.resendApiKeyCiphertext) })
})

app.post('/api/auth/verification/verify', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const code = String(req.body?.code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the six-digit code.' })
  const verification = await prisma.signupVerification.findUnique({ where: { email } })
  if (!verification || verification.expiresAt < new Date() || verification.attempts >= 5 || verification.codeHash !== verificationDigest(email, code)) {
    if (verification && verification.attempts < 5) await prisma.signupVerification.update({ where: { email }, data: { attempts: { increment: 1 } } })
    return res.status(400).json({ message: 'That code is invalid or has expired. Request a new code and try again.' })
  }
  await prisma.signupVerification.update({ where: { email }, data: { verifiedAt: new Date() } })
  res.json({ verified: true })
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true },
  })

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  const token = await issueSession(user.id)
  sendSessionCookie(res, token)

  res.json({ user: toPublicUser(user) })
})

app.post('/api/auth/logout', async (req, res) => {
  const token = readTokenFromRequest(req)

  if (token) {
    await prisma.session.deleteMany({ where: { token } }).catch(() => undefined)
  }

  clearSessionCookie(res)
  res.json({ success: true })
})

app.get('/api/auth/me', async (req, res) => {
  const token = readTokenFromRequest(req)
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const user = await loadUserFromToken(token)
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  res.json({ user })
})

app.get('/api/app', requireAuth, (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  res.json({ ok: true, user })
})

app.get('/api/customers', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })
  const customers = await prisma.customer.findMany({
    where: { organisationId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true, phone: true, email: true },
  })

  res.json({ customers })
})

app.post('/api/customers', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const name = String(req.body?.name ?? '').trim()
  const phone = String(req.body?.phone ?? '').trim() || null
  const email = String(req.body?.email ?? '').trim().toLowerCase() || null
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })

  if (!name || (!phone && !email)) {
    return res.status(400).json({ message: 'Customer name and at least one contact method are required.' })
  }

  const customer = await prisma.customer.create({
    data: {
      organisationId,
      ownerId: user.id,
      name,
      phone,
      email,
    },
    select: { id: true, name: true, phone: true, email: true },
  })

  res.status(201).json({ customer })
})

app.put('/api/customers/:id', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const customerId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })
  const name = String(req.body?.name ?? '').trim()
  const phone = String(req.body?.phone ?? '').trim() || null
  const email = String(req.body?.email ?? '').trim().toLowerCase() || null

  if (!name || (!phone && !email)) {
    return res.status(400).json({ message: 'Customer name and at least one contact method are required.' })
  }

  const existingCustomer = await prisma.customer.findFirst({
    where: { id: customerId, organisationId },
  })

  if (!existingCustomer) {
    return res.status(404).json({ message: 'Customer not found.' })
  }

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { name, phone, email },
    select: { id: true, name: true, phone: true, email: true },
  })

  res.json({ customer })
})

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const customerId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })

  const hasQuotes = await prisma.quote.count({ where: { customerId, organisationId } })
  if (hasQuotes) return res.status(409).json({ message: 'This customer has quotes and cannot be deleted.' })

  await prisma.customer.deleteMany({
    where: { id: customerId, organisationId },
  })

  res.json({ success: true })
})

app.get('/api/service-items', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  await ensureIndustryDefaults(organisationId)
  const items = await prisma.serviceItem.findMany({ where: { organisationId, active: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }] })
  res.json({ items: items.map((item) => ({ ...item, defaultPrice: Number(item.defaultPrice), defaultTaxRate: item.defaultTaxRate === null ? null : Number(item.defaultTaxRate) })) })
})

app.post('/api/service-items', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const name = String(req.body?.name ?? '').trim()
  const category = String(req.body?.category ?? '').trim()
  const kind = String(req.body?.kind ?? 'SERVICE').toUpperCase()
  const description = String(req.body?.description ?? '').trim() || null
  const unit = String(req.body?.unit ?? 'job').trim() || 'job'
  const defaultPrice = Number(req.body?.defaultPrice ?? 0)
  const rawTaxRate = req.body?.defaultTaxRate
  const defaultTaxRate = rawTaxRate === '' || rawTaxRate === null || rawTaxRate === undefined ? null : Number(rawTaxRate)
  if (!name || !category || !['SERVICE', 'PRODUCT'].includes(kind)) return res.status(400).json({ message: 'Enter a name, category, and valid service or product type.' })
  if (!Number.isFinite(defaultPrice) || defaultPrice < 0) return res.status(400).json({ message: 'Enter a valid non-negative price.' })
  if (defaultTaxRate !== null && (!Number.isFinite(defaultTaxRate) || defaultTaxRate < 0 || defaultTaxRate > 100)) return res.status(400).json({ message: 'Tax rate must be between 0 and 100.' })
  try {
    const item = await prisma.serviceItem.create({ data: { organisationId, name, category, kind, description, unit, defaultPrice, defaultTaxRate, isStarter: false } })
    res.status(201).json({ item: { ...item, defaultPrice: Number(item.defaultPrice), defaultTaxRate: item.defaultTaxRate === null ? null : Number(item.defaultTaxRate) } })
  } catch {
    res.status(409).json({ message: 'A service or product with that name already exists in this category.' })
  }
})

app.put('/api/service-items/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const itemId = String(req.params.id ?? '')
  const existing = await prisma.serviceItem.findFirst({ where: { id: itemId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Service or product not found.' })
  const name = String(req.body?.name ?? '').trim()
  const category = String(req.body?.category ?? '').trim()
  const kind = String(req.body?.kind ?? '').toUpperCase()
  const description = String(req.body?.description ?? '').trim() || null
  const unit = String(req.body?.unit ?? 'job').trim() || 'job'
  const defaultPrice = Number(req.body?.defaultPrice ?? 0)
  const rawTaxRate = req.body?.defaultTaxRate
  const defaultTaxRate = rawTaxRate === '' || rawTaxRate === null || rawTaxRate === undefined ? null : Number(rawTaxRate)
  if (!name || !category || !['SERVICE', 'PRODUCT'].includes(kind)) return res.status(400).json({ message: 'Enter a name, category, and valid service or product type.' })
  if (!Number.isFinite(defaultPrice) || defaultPrice < 0) return res.status(400).json({ message: 'Enter a valid non-negative price.' })
  if (defaultTaxRate !== null && (!Number.isFinite(defaultTaxRate) || defaultTaxRate < 0 || defaultTaxRate > 100)) return res.status(400).json({ message: 'Tax rate must be between 0 and 100.' })
  try {
    const item = await prisma.serviceItem.update({ where: { id: itemId }, data: { name, category, kind, description, unit, defaultPrice, defaultTaxRate, isStarter: existing.isStarter } })
    res.json({ item: { ...item, defaultPrice: Number(item.defaultPrice), defaultTaxRate: item.defaultTaxRate === null ? null : Number(item.defaultTaxRate) } })
  } catch {
    res.status(409).json({ message: 'A service or product with that name already exists in this category.' })
  }
})

app.delete('/api/service-items/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const result = await prisma.serviceItem.updateMany({ where: { id: String(req.params.id ?? ''), organisationId }, data: { active: false } })
  if (!result.count) return res.status(404).json({ message: 'Service or product not found.' })
  res.json({ success: true })
})

app.get('/api/quote-templates', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  await ensureIndustryDefaults(organisationId)
  const templates = await prisma.quoteTemplate.findMany({ where: { organisationId }, orderBy: [{ isStarter: 'desc' }, { name: 'asc' }] })
  res.json({ templates })
})

app.post('/api/quote-templates', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const name = String(req.body?.name ?? '').trim()
  const description = String(req.body?.description ?? '').trim()
  const inputLines = req.body?.lineItems
  if (!name || !description || !Array.isArray(inputLines) || inputLines.length === 0) return res.status(400).json({ message: 'Enter a name, a short workflow description, and at least one quote line.' })
  const lineItems = inputLines.slice(0, 40).map((value: unknown) => {
    const line = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return { description: String(line.description ?? '').trim().slice(0, 250), unit: String(line.unit ?? 'job').trim().slice(0, 24) || 'job' }
  }).filter((line: { description: string; unit: string }) => line.description)
  if (lineItems.length === 0) return res.status(400).json({ message: 'Add at least one line with a description.' })
  try {
    const template = await prisma.quoteTemplate.create({
      data: {
        organisationId,
        name: name.slice(0, 100),
        description: description.slice(0, 300),
        workflow: 'CUSTOM',
        lineItems,
        defaultNotes: String(req.body?.defaultNotes ?? '').trim().slice(0, 2000) || null,
        defaultTerms: String(req.body?.defaultTerms ?? '').trim().slice(0, 4000) || null,
        isStarter: false,
      },
    })
    res.status(201).json({ template })
  } catch {
    res.status(409).json({ message: 'A template with that name already exists.' })
  }
})

app.get('/api/quotes', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing quotes.' })
  await prisma.quote.updateMany({
    where: { organisationId, status: { in: ['SENT', 'VIEWED'] }, validUntil: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  })
  const quotes = await prisma.quote.findMany({
    where: { organisationId },
    include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  })
  res.json({ quotes: quotes.map(serializeQuote) })
})

app.post('/api/quotes', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  const organisation = organisationId ? await prisma.organisation.findUnique({ where: { id: organisationId } }) : null
  if (!organisation?.name) return res.status(409).json({ message: 'Complete your business profile before creating a quote.' })

  const customerId = String(req.body?.customerId ?? '')
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!customer) return res.status(400).json({ message: 'Choose a customer for this quote.' })

  const amounts = normalizeQuoteLines(req.body?.lines ?? [], Number(organisation.defaultTaxRate ?? 0))
  if (!amounts) return res.status(400).json({ message: 'Quote lines are invalid.' })
  const validUntil = req.body?.validUntil ? new Date(req.body.validUntil) : null
  if (validUntil && Number.isNaN(validUntil.getTime())) return res.status(400).json({ message: 'Enter a valid expiry date.' })

  try {
    const quote = await prisma.$transaction(async (transaction) => {
      const year = new Date().getFullYear()
      const sequence = await transaction.quoteSequence.upsert({
        where: { organisationId_year: { organisationId: organisation.id, year } },
        update: { nextNumber: { increment: 1 } },
        create: { organisationId: organisation.id, year, nextNumber: 1 },
      })
      const documentNumber = `${organisation.quotePrefix || 'QT'}-${year}-${String(sequence.nextNumber).padStart(4, '0')}`
      return transaction.quote.create({
        data: {
          organisationId: organisation.id,
          ownerId: user.id,
          customerId,
          documentNumber,
          currency: organisation.currency,
          validUntil,
          notes: String(req.body?.notes ?? '').trim() || null,
          terms: String(req.body?.terms ?? organisation.terms ?? '').trim() || null,
          subtotal: amounts.subtotal,
          taxTotal: amounts.taxTotal,
          total: amounts.total,
          lines: { create: amounts.lines },
        },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
      })
    })
    res.status(201).json({ quote: serializeQuote(quote) })
  } catch {
    res.status(500).json({ message: 'Unable to create this quote.' })
  }
})

app.get('/api/quotes/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, organisationId: await getOrganisationId(user.id) ?? '__none__' },
    include: { customer: { select: { id: true, name: true, phone: true, email: true } }, organisation: true, lines: { orderBy: { position: 'asc' } } },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })
  res.json({ quote: serializeQuote(quote) })
})

app.put('/api/quotes/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, organisationId: organisationId ?? '__none__' } })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })
  if (quote.status !== 'DRAFT') return res.status(409).json({ message: 'Only draft quotes can be edited.' })

  const customerId = String(req.body?.customerId ?? quote.customerId)
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId: quote.organisationId } })
  if (!customer) return res.status(400).json({ message: 'Choose a customer for this quote.' })
  const organisation = await prisma.organisation.findUnique({ where: { id: quote.organisationId } })
  const amounts = normalizeQuoteLines(req.body?.lines, Number(organisation?.defaultTaxRate ?? 0))
  if (!amounts) return res.status(400).json({ message: 'Quote lines are invalid. Each line needs a description and positive quantity.' })
  const validUntil = req.body?.validUntil ? new Date(req.body.validUntil) : null
  if (validUntil && Number.isNaN(validUntil.getTime())) return res.status(400).json({ message: 'Enter a valid expiry date.' })

  try {
    const updated = await prisma.$transaction(async (transaction) => {
      await transaction.quoteLine.deleteMany({ where: { quoteId: quote.id } })
      return transaction.quote.update({
        where: { id: quote.id },
        data: {
          customerId,
          validUntil,
          notes: String(req.body?.notes ?? '').trim() || null,
          terms: String(req.body?.terms ?? '').trim() || null,
          subtotal: amounts.subtotal,
          taxTotal: amounts.taxTotal,
          total: amounts.total,
          lines: { create: amounts.lines },
        },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
      })
    })
    res.json({ quote: serializeQuote(updated) })
  } catch {
    res.status(500).json({ message: 'Unable to save this quote.' })
  }
})

app.delete('/api/quotes/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const deleted = await prisma.quote.deleteMany({ where: { id: quoteId, organisationId: await getOrganisationId(user.id) ?? '__none__', status: 'DRAFT' } })
  if (!deleted.count) return res.status(404).json({ message: 'Draft quote not found.' })
  res.json({ success: true })
})

app.post('/api/quotes/:id/share', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, organisationId: await getOrganisationId(user.id) ?? '__none__' } })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })
  if (quote.status !== 'DRAFT') return res.status(409).json({ message: 'This quote has already been shared.' })
  const lineCount = await prisma.quoteLine.count({ where: { quoteId: quote.id } })
  if (!lineCount) return res.status(400).json({ message: 'Add at least one line item before sharing this quote.' })

  const shared = await prisma.quote.update({
    where: { id: quote.id },
    data: { status: 'SENT', publicToken: randomBytes(24).toString('base64url') },
    select: { id: true, documentNumber: true, publicToken: true, status: true },
  })
  res.json({ quote: shared })
})

app.get('/api/public/quotes/:token', async (req, res) => {
  const publicToken = String(req.params.token ?? '')
  const quote = await prisma.quote.findUnique({
    where: { publicToken },
    include: {
      customer: { select: { name: true } },
      organisation: { select: { name: true, email: true, phone: true, country: true, currency: true, logoUrl: true, paymentInstructions: true } },
      lines: { orderBy: { position: 'asc' } },
    },
  })
  if (!quote || quote.status === 'DRAFT') return res.status(404).json({ message: 'This quote link is not available.' })

  const expired = quote.validUntil && quote.validUntil < new Date() && ['SENT', 'VIEWED'].includes(quote.status)
  if (expired) {
    quote.status = 'EXPIRED'
    await prisma.quote.update({ where: { id: quote.id }, data: { status: 'EXPIRED' } })
  } else if (quote.status === 'SENT') {
    quote.status = 'VIEWED'
    quote.viewedAt = new Date()
    await prisma.quote.update({ where: { id: quote.id }, data: { status: 'VIEWED', viewedAt: quote.viewedAt } })
  }
  res.json({
    quote: {
      documentNumber: quote.documentNumber,
      status: quote.status,
      currency: quote.currency,
      validUntil: quote.validUntil,
      notes: quote.notes,
      terms: quote.terms,
      subtotal: Number(quote.subtotal),
      taxTotal: Number(quote.taxTotal),
      total: Number(quote.total),
      createdAt: quote.createdAt,
      viewedAt: quote.viewedAt,
      decisionComment: quote.decisionComment,
      decidedAt: quote.decidedAt,
      lines: quote.lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unit: line.unit, unitPrice: Number(line.unitPrice), taxRate: line.taxRate === null ? null : Number(line.taxRate) })),
      customer: quote.customer,
      organisation: quote.organisation,
    },
  })
})

app.post('/api/public/quotes/:token/decision', async (req, res) => {
  const decision = String(req.body?.decision ?? '').toUpperCase()
  if (!['APPROVED', 'DECLINED'].includes(decision)) return res.status(400).json({ message: 'Choose approve or decline.' })
  const publicToken = String(req.params.token ?? '')
  const quote = await prisma.quote.findUnique({ where: { publicToken } })
  if (!quote) return res.status(404).json({ message: 'This quote link is not available.' })
  if (!['SENT', 'VIEWED'].includes(quote.status)) return res.status(409).json({ message: 'This quote can no longer be changed.' })
  if (quote.validUntil && quote.validUntil < new Date()) {
    await prisma.quote.update({ where: { id: quote.id }, data: { status: 'EXPIRED' } })
    return res.status(409).json({ message: 'This quote has expired.' })
  }

  const nextStatus = decision === 'APPROVED' ? 'APPROVED' : 'DECLINED'
  const decidedAt = new Date()
  const result = await prisma.quote.updateMany({
    where: { id: quote.id, status: { in: ['SENT', 'VIEWED'] } },
    data: { status: nextStatus, decisionComment: String(req.body?.comment ?? '').trim() || null, decidedAt },
  })
  if (!result.count) return res.status(409).json({ message: 'This quote can no longer be changed.' })
  const updated = { status: nextStatus, decidedAt }
  res.json({ quote: updated })
})

app.get('/api/business/me', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const organisationId = await getOrganisationId(user.id)
  const organisation = organisationId ? await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      country: true,
      businessType: true,
      currency: true,
      defaultTaxRate: true,
      quotePrefix: true,
      logoUrl: true,
      paymentInstructions: true,
      terms: true,
      subscription: { select: { plan: true, status: true, trialEndsAt: true, simulated: true } },
    },
  }) : null

  res.json({ organisation })
})

app.post('/api/business/setup', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const name = String(req.body?.name ?? '').trim()
  const email = String(req.body?.email ?? '').trim().toLowerCase() || null
  const phone = String(req.body?.phone ?? '').trim() || null
  const country = String(req.body?.country ?? '').trim() || null
  const businessType = String(req.body?.businessType ?? '').trim() || null
  const currency = String(req.body?.currency ?? 'KES').trim().toUpperCase() || 'KES'
  const quotePrefix = String(req.body?.quotePrefix ?? 'QT').trim().toUpperCase() || 'QT'
  const logoUrl = String(req.body?.logoUrl ?? '').trim() || null
  const paymentInstructions = String(req.body?.paymentInstructions ?? '').trim() || null
  const terms = String(req.body?.terms ?? '').trim() || null

  const rawTaxRate = req.body?.defaultTaxRate
  let defaultTaxRate: number | null = null
  if (rawTaxRate !== undefined && rawTaxRate !== null && rawTaxRate !== '') {
    defaultTaxRate = Number(rawTaxRate)
    if (Number.isNaN(defaultTaxRate) || defaultTaxRate < 0 || defaultTaxRate > 100) {
      return res.status(400).json({ message: 'Default tax rate must be between 0 and 100.' })
    }
  }

  if (!name || !currency) {
    return res.status(400).json({ message: 'Business name and currency are required.' })
  }

  const organisation = await prisma.organisation.upsert({
    where: { ownerId: user.id },
    update: {
      name,
      email,
      phone,
      country,
      businessType,
      currency,
      defaultTaxRate,
      quotePrefix,
      logoUrl,
      paymentInstructions,
      terms,
    },
    create: {
      ownerId: user.id,
      name,
      email,
      phone,
      country,
      businessType,
      currency,
      defaultTaxRate: defaultTaxRate === null ? undefined : defaultTaxRate,
      quotePrefix,
      logoUrl,
      paymentInstructions,
      terms,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      country: true,
      businessType: true,
      currency: true,
      defaultTaxRate: true,
      quotePrefix: true,
      logoUrl: true,
      paymentInstructions: true,
      terms: true,
    },
  })

  res.status(201).json({ organisation })
})

app.listen(port, () => {
  console.log(`iQuote API listening on http://localhost:${port}`)
})
