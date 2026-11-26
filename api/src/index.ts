import 'dotenv/config'
import pkg from '@prisma/client'
import type { Prisma as PrismaTypes } from '@prisma/client'
const { PrismaClient, Prisma } = pkg
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { generateSecret, generateURI, verifySync } from 'otplib'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import sizeOf from 'image-size'
import { getIndustryPack } from './industry-packs.js'
import { initiateNcbaStkPush, ncbaPlanPrice, ncbaStkConfigured, normalizeKenyanPhone, queryNcbaStkPush, setPlatformNcbaConfig } from './ncba-client.js'
import { initiateMerchantStkPush, NcbaMerchantRequestError, normalizeCustomerPhone, normalizeMerchantCode, queryMerchantStkPush, verifyNotificationHash } from './customer-mpesa.js'
import { verificationEmailHtml, welcomeEmailHtml, quoteDecisionEmailHtml, quoteDeliveryEmailHtml, invoiceDeliveryEmailHtml, receiptDeliveryEmailHtml, emailSubjects } from './email-templates.js'
import { entitlementsFor, limitReachedMessage, quotaState, startOfMonthEAT, trialLimitReachedMessage, PLAN_ENTITLEMENTS, PLAN_LIMIT_CODE, TRIAL_LIMITS } from './plans.js'

const prisma = new PrismaClient()
const app = express()

// ---- Login rate limiting (database-backed, works across multiple instances) ----
const MAX_LOGIN_ATTEMPTS = 5
const LOGIN_LOCK_MS = 15 * 60 * 1000 // 15 minutes

async function checkLoginRateLimit(key: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const entry = await prisma.loginAttempt.findUnique({ where: { key } })
  if (entry && entry.lockedUntil && entry.lockedUntil.getTime() > Date.now()) {
    return { allowed: false, retryAfterMs: entry.lockedUntil.getTime() - Date.now() }
  }
  return { allowed: true, retryAfterMs: 0 }
}

async function recordFailedLogin(key: string) {
  const entry = await prisma.loginAttempt.findUnique({ where: { key } })
  const count = (entry?.count ?? 0) + 1
  const isLocked = count >= MAX_LOGIN_ATTEMPTS
  const lockedUntil = isLocked ? new Date(Date.now() + LOGIN_LOCK_MS) : null
  await prisma.loginAttempt.upsert({
    where: { key },
    update: { count: isLocked ? 0 : count, lockedUntil, updatedAt: new Date() },
    create: { key, count: isLocked ? 0 : count, lockedUntil },
  })
}

async function clearLoginAttempts(key: string) {
  await prisma.loginAttempt.deleteMany({ where: { key } }).catch(() => {})
}

// ---- Public endpoint rate limiting (in-memory, per-IP) ----
// Public quote endpoints (view, decide) are unauthenticated, so we limit
// by IP to prevent scraping and brute-force token guessing.
// Budget: 60 requests per 5 minutes per IP (generous — a human viewing
// a quote makes 1-2 requests; a scraper hitting thousands gets blocked).
const PUBLIC_WINDOW_MS = 5 * 60 * 1000
const PUBLIC_MAX_REQUESTS = 60
const publicHits = new Map<string, { count: number; resetAt: number }>()

function checkPublicRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = publicHits.get(ip)
  if (!entry || entry.resetAt < now) {
    publicHits.set(ip, { count: 1, resetAt: now + PUBLIC_WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= PUBLIC_MAX_REQUESTS
}

// Clean up expired public rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of publicHits.entries()) {
    if (entry.resetAt < now) publicHits.delete(ip)
  }
}, 10 * 60 * 1000)

const publicRateLimit = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  if (!checkPublicRateLimit(ip)) {
    return res.status(429).json({ message: 'Too many requests. Please try again later.' })
  }
  next()
}

const port = Number(process.env.PORT ?? 4000)
const isProduction = process.env.NODE_ENV === 'production'

// ---- App secret: used for HMAC digests (OTP verification, email keys) ----
// In development a default is used for convenience. In production the app
// refuses to start if JWT_SECRET is missing or shorter than 32 characters.
// To rotate: set a new JWT_SECRET, restart the API (existing sessions become
// invalid — users will need to log in again), and optionally delete old
// Session rows: DELETE FROM "Session" WHERE "expiresAt" < NOW();
// Note: the env var is named JWT_SECRET for backwards compatibility, but
// session tokens are now opaque random tokens (not JWTs).
const appSecret = process.env.JWT_SECRET ?? (isProduction ? '' : 'dev-secret-change-me')
if (isProduction && (!appSecret || appSecret.length < 32)) {
  console.error('FATAL: JWT_SECRET must be set to a random string of at least 32 characters in production.')
  console.error('Generate one with: openssl rand -hex 32')
  process.exit(1)
}

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

function encryptPlatformNcbaSecret(value: string) {
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) throw new Error('Platform credential encryption is not configured on the server.')
  const iv = randomBytes(12)
  const key = createHmac('sha256', 'iquote-platform-ncba').update(emailEncryptionKey).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`
}

function decryptPlatformNcbaSecret(value: string) {
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) throw new Error('Platform credential encryption is not configured on the server.')
  const [ivText, tagText, encryptedText] = value.split('.')
  if (!ivText || !tagText || !encryptedText) throw new Error('Stored NCBA credential is invalid.')
  const key = createHmac('sha256', 'iquote-platform-ncba').update(emailEncryptionKey).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8')
}

async function hydratePlatformNcbaConfig() {
  const row = await prisma.platformNcbaConfig.findUnique({ where: { id: 'platform' } })
  if (row?.stkUsernameCiphertext && row.stkSecretCiphertext && row.paybillNumber && row.tillAccountNumber) {
    setPlatformNcbaConfig({ username: decryptPlatformNcbaSecret(row.stkUsernameCiphertext), secret: decryptPlatformNcbaSecret(row.stkSecretCiphertext), paybill: row.paybillNumber, tillAccount: row.tillAccountNumber })
  } else {
    setPlatformNcbaConfig(null)
  }
}

function encryptMfaSecret(value: string) {
  const iv = randomBytes(12)
  const key = createHmac('sha256', appSecret).update('iquote-superadmin-mfa').digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
}

function decryptMfaSecret(value: string) {
  if (!value.startsWith('enc:v1:')) return value // Upgrade legacy plaintext records on successful verification.
  const [, , ivText, tagText, encryptedText] = value.split(':')
  if (!ivText || !tagText || !encryptedText) throw new Error('Stored authenticator secret is invalid.')
  const key = createHmac('sha256', appSecret).update('iquote-superadmin-mfa').digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8')
}

// ---- CORS: explicit trusted origins only ----
// TRUSTED_ORIGINS is a comma-separated list of exact URLs allowed to make
// credentialed requests (e.g. "https://iquote.trendscore.co.ke").
// In development, localhost origins are auto-allowed.
const trustedOrigins: string[] = (process.env.TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const devOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false
  // Exact match against trusted list
  if (trustedOrigins.includes(origin)) return true
  // Dev origins only in non-production
  if (!isProduction && devOrigins.includes(origin)) return true
  // Tenant subdomains: https://*.trendscore.co.ke (wildcard from TENANT_BASE_DOMAIN)
  const baseDomain = process.env.TENANT_BASE_DOMAIN
  if (baseDomain) {
    const subdomainPrefix = `https://*.${baseDomain}`
    // Match https://anything.trendscore.co.ke
    const wildcardRegex = new RegExp(`^https://[a-z0-9-]+\\.${baseDomain.replace(/\./g, '\\.')}$`, 'i')
    if (wildcardRegex.test(origin)) return true
    void subdomainPrefix // kept for documentation
  }
  return false
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) callback(null, true)
      else callback(null, false) // reject silently — don't echo the origin
    },
    credentials: true,
  }),
)

// ---- CSRF protection: reject non-safe methods without trusted Origin ----
// For cookie-authenticated requests, the browser automatically sends the
// Origin header on cross-site requests. We reject POST/PUT/DELETE/PATCH
// if the Origin is missing or not trusted. GET/HEAD/OPTIONS are allowed.
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']
app.use((req, res, next) => {
  if (SAFE_METHODS.includes(req.method)) return next()
  // NCBA posts provider-signed payment notifications from its servers without a browser Origin.
  // The callback handler validates its per-merchant credentials and signed hash before applying money.
  if (req.method === 'POST' && req.path === '/api/webhooks/ncba/customer-payment') return next()
  const origin = req.headers.origin
  // If no Origin header, check Referer as fallback
  const referer = req.headers.referer
  const checkUrl = origin ?? (referer ? new URL(referer).origin : undefined)
  if (!checkUrl) {
    // No Origin/Referer at all — could be a direct API call (e.g. curl).
    // Allow in development, reject in production for cookie-authenticated writes.
    if (!isProduction) return next()
    return res.status(403).json({ message: 'Missing Origin header.' })
  }
  if (!isOriginAllowed(checkUrl)) {
    return res.status(403).json({ message: 'Origin not allowed.' })
  }
  next()
})

// ---- Trust proxy: needed behind Nginx for correct req.ip, secure cookies ----
app.set('trust proxy', isProduction ? 1 : false)

app.use(express.json({ limit: '10mb' }))
app.use(cookieParser())

// ---- Webhook raw body capture for signature verification ----
// The webhook endpoint needs the raw body to verify the Svix/Resend signature.
// We store it on the request object for later use.
app.use('/api/webhooks/resend', express.json({
  limit: '1mb',
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf
  },
}))

// ---- Logo uploads: static serving ----
const uploadsDir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads')
app.use('/uploads/job-attachments', (_req, res) => res.status(404).end())
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true }))

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

// ---- Session token hashing ----
// We store SHA-256 hashes of opaque session tokens in the database, never
// raw tokens. This way a database leak does not expose valid session tokens.
// The raw token is only ever sent to the user via the httpOnly cookie.
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

async function issueSession(userId: string, mfaVerified = false): Promise<string> {
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await prisma.session.create({
    data: { token: tokenHash, userId, expiresAt, ...(mfaVerified ? { mfaVerifiedAt: new Date() } : {}) },
  })

  return rawToken
}

function toPublicUser(user: { id: string; name: string; email: string; role?: string; teamRole?: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role ?? 'USER',
    teamRole: user.teamRole ?? 'OWNER',
  }
}

function getRequestUser(req: Request) {
  return (req as Request & { user?: { id: string; name: string; email: string; role?: string; teamRole?: string } }).user
}

async function writeSuperadminAudit(req: Request, actor: { id: string; email: string }, action: string, targetType: string, targetId: string | null, summary: string, metadata?: PrismaTypes.InputJsonValue, db: PrismaTypes.TransactionClient | typeof prisma = prisma) {
  return (db as any).superadminAuditEvent.create({
    data: {
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetType,
      targetId,
      summary,
      ...(metadata ? { metadata } : {}),
      ipAddress: req.ip ?? req.socket.remoteAddress ?? null,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
    },
  })
}

function verificationDigest(email: string, code: string) {
  return createHmac('sha256', appSecret).update(`${email}:${code}`).digest('hex')
}

function createdEmailKey(email: string) {
  return createHmac('sha256', appSecret).update(email).digest('hex')
}

function platformSenderEmail() {
  return process.env.RESEND_FROM_EMAIL || process.env.BILLING_FROM_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_FROM || ''
}

function platformSenderName() {
  return process.env.RESEND_FROM_NAME || process.env.BILLING_FROM_NAME || process.env.EMAIL_FROM_NAME || process.env.PLATFORM_NAME || 'iQuote'
}

function platformEmailReady() {
  return Boolean(process.env.RESEND_API_KEY && platformSenderEmail())
}

async function checkResendProviderHealth(): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return 'NOT_CONFIGURED'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (response.ok) return 'HEALTHY'
    if (response.status === 401 || response.status === 403) return 'INVALID_CREDENTIALS'
    return `HTTP_${response.status}`
  } catch {
    return 'UNAVAILABLE'
  } finally {
    clearTimeout(timeout)
  }
}

type SendEmailResult = { success: true; messageId: string | null }

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  idempotencyKey: string,
  organisationId?: string,
  attachments?: Array<{ filename: string; content: string }>,
  cc?: string[] | string,
  replyToOverride?: string,
): Promise<SendEmailResult | false> {
  const tenantSettings = organisationId ? await prisma.tenantEmailSettings.findUnique({ where: { organisationId } }) : null
  const tenantKey = tenantSettings?.provider === 'CUSTOM' && tenantSettings.resendApiKeyCiphertext ? decryptEmailSecret(tenantSettings.resendApiKeyCiphertext) : null
  const apiKey = tenantKey ?? process.env.RESEND_API_KEY
  const senderEmail = platformSenderEmail()
  const from = tenantKey && tenantSettings?.senderEmail
    ? `${tenantSettings.senderName || 'iQuote'} <${tenantSettings.senderEmail}>`
    : senderEmail ? `${platformSenderName()} <${senderEmail}>` : ''
  if (!apiKey || !from) return false

  // Replies go to the sending business when one is supplied, otherwise to platform support.
  const replyTo = (replyToOverride && isValidEmail(replyToOverride) ? replyToOverride : process.env.SUPPORT_EMAIL) || undefined

  const ccList = Array.isArray(cc)
    ? cc.map((item) => String(item).trim()).filter(Boolean)
    : (cc ? String(cc).split(',').map((item) => item.trim()).filter(Boolean) : [])

  const body: Record<string, unknown> = {
    from,
    to: [to],
    subject,
    html,
    ...(ccList.length > 0 ? { cc: ccList } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  }
  if (attachments && attachments.length > 0) {
    body.attachments = attachments
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    console.error(`Resend email failed (${response.status}).`)
    throw new Error('Email delivery failed. Check the Resend API key and verified sender address.')
  }
  const responseBody = await response.json().catch(() => ({})) as { id?: string }
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
  return { success: true as const, messageId: responseBody.id ?? null }
}

async function getOrganisationId(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { organisationId: true } })
  if (user?.organisationId) return user.organisationId
  const owned = await prisma.organisation.findFirst({ where: { ownerId: userId }, select: { id: true } })
  return owned?.id ?? null
}

async function getWorkspaceSuspension(userId: string) {
  const organisationId = await getOrganisationId(userId)
  if (!organisationId) return null
  return prisma.organisation.findUnique({ where: { id: organisationId }, select: { status: true, suspensionReason: true } })
}

function makeSubdomainBase(name: string) {
  let slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  slug ||= 'business'
  if (['admin', 'api', 'iquote', 'www'].includes(slug)) slug = `${slug}-workspace`
  return slug
}

async function allocateSubdomain(transaction: PrismaTypes.TransactionClient, businessName: string) {
  const base = makeSubdomainBase(businessName)
  // pg_advisory_xact_lock returns void; cast to text so Prisma can deserialize it.
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${base}))::text`
  let candidate = base
  let suffix = 2
  while (await transaction.organisation.findUnique({ where: { subdomain: candidate }, select: { id: true } })) {
    candidate = `${base.slice(0, 44)}-${suffix++}`
  }
  return candidate
}

function tenantSubdomainFromHost(host: string) {
  const hostname = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const baseDomain = (process.env.TENANT_BASE_DOMAIN ?? 'trendscore.co.ke').toLowerCase().replace(/^\.+|\.+$/g, '')
  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  if (!label || label.includes('.') || ['www', 'iquote', 'api'].includes(label)) return null
  return label
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

async function getNetInvoiceAllocations(db: any, invoiceId: string, organisationId: string) {
  const [allocated, reversed] = await Promise.all([
    db.paymentAllocation.aggregate({ where: { invoiceId, organisationId, eventType: 'ALLOCATE' }, _sum: { amount: true } }),
    db.paymentAllocation.aggregate({ where: { invoiceId, organisationId, eventType: 'REVERSE' }, _sum: { amount: true } }),
  ])
  return roundMoney(Number(allocated._sum.amount ?? 0) - Number(reversed._sum.amount ?? 0))
}

async function updateInvoiceFromLedger(tx: any, invoice: any, organisationId: string) {
  const [allocated, reversed, refunds] = await Promise.all([
    tx.paymentAllocation.aggregate({ where: { invoiceId: invoice.id, organisationId, eventType: 'ALLOCATE' }, _sum: { amount: true } }),
    tx.paymentAllocation.aggregate({ where: { invoiceId: invoice.id, organisationId, eventType: 'REVERSE' }, _sum: { amount: true } }),
    tx.paymentRefund.aggregate({ where: { invoiceId: invoice.id, organisationId }, _sum: { amount: true } }),
  ])
  const netPaid = roundMoney(Number(allocated._sum.amount ?? 0) - Number(reversed._sum.amount ?? 0) - Number(refunds._sum.amount ?? 0))
  const balanceDue = roundMoney(Number(invoice.total) - netPaid)
  const status = invoice.status === 'CANCELLED' || invoice.status === 'DRAFT' ? invoice.status : balanceDue <= 0.001 ? 'PAID' : netPaid > 0 ? 'PARTIALLY_PAID' : invoice.dueDate && invoice.dueDate < new Date() ? 'OVERDUE' : 'SENT'
  return tx.invoice.update({ where: { id: invoice.id }, data: { amountPaid: netPaid, balanceDue, status } })
}

async function listInvoiceAllocatedPayments(db: any, invoiceId: string, organisationId: string) {
  const events = await db.paymentAllocation.findMany({
    where: { invoiceId, organisationId },
    orderBy: { createdAt: 'asc' },
    include: { payment: { include: { invoice: { select: { invoiceNumber: true } } } } },
  })
  const byPayment = new Map<string, { amount: number; payment: any }>()
  for (const event of events) {
    const current = byPayment.get(event.paymentId) ?? { amount: 0, payment: event.payment }
    current.amount += event.eventType === 'ALLOCATE' ? Number(event.amount) : -Number(event.amount)
    byPayment.set(event.paymentId, current)
  }
  const entries = [...byPayment.values()].filter((entry) => entry.amount > 0.001)
  if (!entries.length) return []
  const paymentIds = entries.map((entry) => entry.payment.id)
  const refunds = await db.paymentRefund.findMany({ where: { invoiceId, organisationId, paymentId: { in: paymentIds } }, orderBy: { createdAt: 'asc' } })
  const deliveries = await db.receiptDelivery.findMany({ where: { paymentId: { in: paymentIds } }, orderBy: { createdAt: 'desc' } })
  return entries.map(({ amount, payment }) => ({
    id: payment.id,
    receiptNumber: payment.receiptNumber || `RCP-${payment.id.toUpperCase()}`,
    amount: roundMoney(amount),
    sourceAmount: Number(payment.amount),
    currency: payment.currency,
    method: payment.method,
    reference: payment.reference,
    isDeposit: payment.isDeposit ?? false,
    paymentDate: payment.paymentDate,
    receivedBy: payment.receivedBy,
    createdAt: payment.createdAt,
    invoiceNumber: payment.invoice.invoiceNumber,
    refunds: refunds.filter((refund: any) => refund.paymentId === payment.id).map((refund: any) => ({ ...refund, amount: Number(refund.amount) })),
    receiptDeliveries: deliveries.filter((delivery: any) => delivery.paymentId === payment.id).map((delivery: any) => ({
      id: delivery.id,
      recipientEmail: delivery.recipientEmail,
      recipientName: delivery.recipientName,
      status: delivery.status,
      errorMessage: delivery.errorMessage,
      sentAt: delivery.sentAt,
      createdAt: delivery.createdAt,
    })),
  }))
}

async function listInvoiceAllocationHistory(db: any, invoiceId: string, organisationId: string) {
  const events = await db.paymentAllocation.findMany({
    where: { invoiceId, organisationId },
    orderBy: { createdAt: 'desc' },
    include: { payment: { select: { receiptNumber: true } }, invoice: { select: { invoiceNumber: true } } },
  })
  return events.map((event: any) => ({ ...event, amount: Number(event.amount), receiptNumber: event.payment.receiptNumber || `RCP-${event.paymentId.toUpperCase()}`, invoiceNumber: event.invoice.invoiceNumber }))
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
    const tokenHash = hashToken(token)
    const session = await prisma.session.findFirst({ where: { token: tokenHash, expiresAt: { gt: new Date() } } })
    if (!session) return null
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, name: true, email: true, role: true, teamRole: true },
    })

    return user ? toPublicUser(user) : null
  } catch {
    return null
  }
}

async function markSessionMfaVerified(token: string) {
  await prisma.session.updateMany({ where: { token: hashToken(token), expiresAt: { gt: new Date() } }, data: { mfaVerifiedAt: new Date() } })
}

async function hasVerifiedSuperadminSession(token: string, userId: string) {
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaEnabledAt: true } })
  if (!account?.mfaEnabled || !account.mfaEnabledAt) return false
  const session = await prisma.session.findFirst({ where: { token: hashToken(token), expiresAt: { gt: new Date() } }, select: { mfaVerifiedAt: true } })
  return Boolean(session?.mfaVerifiedAt && session.mfaVerifiedAt >= account.mfaEnabledAt)
}

async function refreshSubscriptionState(organisationId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { organisationId } })
  if (!subscription) return null
  const now = new Date()
  const expiredTrial = subscription.status === 'TRIALING' && subscription.trialEndsAt <= now
  const expiredPaidPeriod = subscription.status === 'ACTIVE' && subscription.currentPeriodEndsAt !== null && subscription.currentPeriodEndsAt <= now
  if (expiredTrial || expiredPaidPeriod) {
    return prisma.subscription.update({ where: { organisationId }, data: { status: 'EXPIRED' } })
  }
  return subscription
}

const BILLING_PLANS = ['STARTER', 'GROWTH', 'TEAM'] as const

async function platformPlanPrices() {
  const saved = await prisma.platformPlanPrice.findMany({ where: { plan: { in: [...BILLING_PLANS] } } })
  const savedByPlan = new Map(saved.map((row) => [row.plan, row]))
  return BILLING_PLANS.map((plan) => {
    const row = savedByPlan.get(plan)
    const amount = row ? (row.amount === null ? null : Number(row.amount)) : ncbaPlanPrice(plan)
    return { plan, amount, currency: 'KES', source: row ? 'ADMIN' : amount === null ? 'UNSET' : 'ENVIRONMENT' }
  })
}

async function platformPlanPrice(plan: string) {
  if (!BILLING_PLANS.includes(plan as typeof BILLING_PLANS[number])) return null
  const saved = await prisma.platformPlanPrice.findUnique({ where: { plan } })
  if (saved) return saved.amount === null ? null : Number(saved.amount)
  return ncbaPlanPrice(plan)
}

async function workspaceBillingIsCurrent(userId: string) {
  const organisationId = await getOrganisationId(userId)
  if (!organisationId) return true
  const subscription = await refreshSubscriptionState(organisationId)
  if (!subscription) return true
  return subscription.status === 'TRIALING' || subscription.status === 'ACTIVE'
}

// ---- Plan entitlements and usage (see docs/PLANS.md) ----
// Limits only block creating NEW things; existing data always stays readable.
async function getEntitlements(organisationId: string) {
  const subscription = await refreshSubscriptionState(organisationId)
  return entitlementsFor(subscription?.plan, subscription?.status)
}

// New quotes this calendar month (East Africa Time). Revisions of an existing quote do not count.
async function countQuotesThisMonth(organisationId: string) {
  return prisma.quote.count({ where: { organisationId, parentQuoteId: null, createdAt: { gte: startOfMonthEAT() } } })
}

// Returns the plan's daily email limit when it has been reached, otherwise null.
async function dailyEmailLimitReached(organisationId: string): Promise<number | null> {
  const entitlements = await getEntitlements(organisationId)
  const sent = await prisma.quoteDelivery.count({
    where: { quote: { organisationId }, status: { not: 'FAILED' }, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  })
  return quotaState(sent, entitlements.emailsPerDay).allowed ? null : entitlements.emailsPerDay
}

// Free-trial cap: a workspace on its trial may create only a few quotes and invoices in total.
// Returns the message to show when the cap is reached, otherwise null. Paid workspaces are never affected.
async function trialLimitReached(organisationId: string, kind: 'quotes' | 'invoices'): Promise<string | null> {
  const subscription = await refreshSubscriptionState(organisationId)
  if (subscription?.status !== 'TRIALING') return null
  const limit = TRIAL_LIMITS[kind]
  const used = kind === 'quotes'
    ? await prisma.quote.count({ where: { organisationId, parentQuoteId: null } })
    : await prisma.invoice.count({ where: { organisationId } })
  return quotaState(used, limit).allowed ? null : trialLimitReachedMessage(kind, limit)
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

  if (user.role === 'SUPERADMIN' && !(await hasVerifiedSuperadminSession(token, user.id))) {
    return res.status(403).json({ message: 'Verify your authenticator code to continue.', code: 'MFA_REQUIRED' })
  }

  if (user.role !== 'SUPERADMIN') {
    const workspace = await getWorkspaceSuspension(user.id)
    if (workspace?.status === 'SUSPENDED') return res.status(403).json({ message: `This workspace is suspended. ${workspace.suspensionReason ?? 'Contact iQuote support for assistance.'}`, code: 'WORKSPACE_SUSPENDED' })
    if (!req.path.startsWith('/api/billing/') && !await workspaceBillingIsCurrent(user.id)) {
      return res.status(402).json({ message: 'Your trial or subscription has ended. Complete payment to reopen this workspace.', code: 'SUBSCRIPTION_PAYMENT_REQUIRED' })
    }
  }

  ;(req as Request & { user?: typeof user }).user = user
  next()
}

const requireSuperadmin = async (req: Request, res: Response, next: NextFunction) => {
  const token = readTokenFromRequest(req)
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const user = await loadUserFromToken(token)
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  if (user.role !== 'SUPERADMIN') {
    return res.status(403).json({ message: 'Superadmin access required.' })
  }

  if (!(await hasVerifiedSuperadminSession(token, user.id))) {
    return res.status(403).json({ message: 'Verify your authenticator code to continue.', code: 'MFA_REQUIRED' })
  }

  ;(req as Request & { user?: typeof user }).user = user
  next()
}

type TeamRoleName = 'OWNER' | 'ADMIN' | 'MEMBER'

async function loadUserWithTeamRole(userId: string): Promise<{ id: string; name: string; email: string; role: string; teamRole: TeamRoleName; organisationId: string | null } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, teamRole: true, organisationId: true },
  })
  if (!user) return null
  return { ...user, teamRole: user.teamRole as TeamRoleName }
}

function requireTeamRole(...allowed: TeamRoleName[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readTokenFromRequest(req)
    if (!token) return res.status(401).json({ message: 'Unauthorized' })

    const sessionUser = await loadUserFromToken(token)
    if (!sessionUser) return res.status(401).json({ message: 'Unauthorized' })

    const fullUser = await loadUserWithTeamRole(sessionUser.id)
    if (!fullUser) return res.status(401).json({ message: 'Unauthorized' })

    if (fullUser.role === 'SUPERADMIN' && !(await hasVerifiedSuperadminSession(token, fullUser.id))) {
      return res.status(403).json({ message: 'Verify your authenticator code to continue.', code: 'MFA_REQUIRED' })
    }

    if (fullUser.role !== 'SUPERADMIN') {
      const workspace = await getWorkspaceSuspension(fullUser.id)
      if (workspace?.status === 'SUSPENDED') return res.status(403).json({ message: `This workspace is suspended. ${workspace.suspensionReason ?? 'Contact iQuote support for assistance.'}`, code: 'WORKSPACE_SUSPENDED' })
      if (!req.path.startsWith('/api/billing/') && !await workspaceBillingIsCurrent(fullUser.id)) {
        return res.status(402).json({ message: 'Your trial or subscription has ended. Complete payment to reopen this workspace.', code: 'SUBSCRIPTION_PAYMENT_REQUIRED' })
      }
    }

    if (fullUser.role === 'SUPERADMIN' || allowed.includes(fullUser.teamRole)) {
      ;(req as Request & { user?: typeof sessionUser }).user = sessionUser
      ;(req as Request & { teamRole?: TeamRoleName }).teamRole = fullUser.teamRole
      return next()
    }

    return res.status(403).json({ message: 'You do not have permission to perform this action.' })
  }
}

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', database: 'connected' })
  } catch {
    res.status(503).json({ status: 'degraded', database: 'disconnected' })
  }
})

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, service: 'iQuote API' })
})

// Deployed commit identification — set by Docker build or deploy script
app.get('/api/version', (_req, res) => {
  res.json({
    version: process.env.APP_VERSION ?? 'unknown',
    commit: process.env.GIT_COMMIT ?? 'unknown',
    buildTime: process.env.BUILD_TIME ?? 'unknown',
    node: process.version,
  })
})

// Wildcard DNS/Nginx sends tenant hostnames to the same shared application.
// Hostname resolution is for public workspace branding only; authentication
// and every private data query continue to use the signed-in user's workspace.
app.get('/api/tenant/current', async (req, res) => {
  const subdomain = tenantSubdomainFromHost(req.get('host') ?? '')
  if (!subdomain) return res.json({ tenant: null })
  const organisation = await prisma.organisation.findUnique({
    where: { subdomain },
    select: { name: true, subdomain: true, logoUrl: true, logoWidth: true, logoHeight: true, country: true, currency: true },
  })
  if (!organisation) return res.status(404).json({ tenant: null })
  res.json({ tenant: organisation })
})

// Email template preview — renders HTML in browser for design review.
// Disabled in production; requires superadmin auth otherwise.
app.get('/api/email-preview/:template', requireSuperadmin, (req, res) => {
  if (isProduction) {
    return res.status(404).json({ message: 'This endpoint does not exist.' })
  }
  const template = String(req.params.template ?? '')
  if (template === 'verification') {
    return res.set('Content-Type', 'text/html').send(verificationEmailHtml({ email: 'user@example.com', code: '483920' }))
  }
  if (template === 'welcome') {
    return res.set('Content-Type', 'text/html').send(welcomeEmailHtml({
      name: 'Jane Wanjiru',
      businessName: 'Wanjiru & Sons Plumbing',
      businessType: 'Plumbing',
      country: 'Kenya',
      plan: 'STARTER',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      phone: '+254 712 345 678',
      loginUrl: 'http://localhost:5174',
    }))
  }
  if (template === 'quote-approved') {
    return res.set('Content-Type', 'text/html').send(quoteDecisionEmailHtml({
      ownerName: 'Jane Wanjiru',
      documentNumber: 'QT-2026-0042',
      customerName: 'Acme Construction Ltd',
      total: 185000,
      currency: 'KES',
      decision: 'APPROVED',
      comment: 'Looks good, please proceed.',
      quoteUrl: 'http://localhost:5174/quote/abc123',
    }))
  }
  if (template === 'quote-declined') {
    return res.set('Content-Type', 'text/html').send(quoteDecisionEmailHtml({
      ownerName: 'Jane Wanjiru',
      documentNumber: 'QT-2026-0042',
      customerName: 'Acme Construction Ltd',
      total: 185000,
      currency: 'KES',
      decision: 'DECLINED',
      comment: 'The total is above our budget. Can you offer a discount?',
      quoteUrl: 'http://localhost:5174/quote/abc123',
    }))
  }
  res.status(404).json({ message: 'Unknown template. Use: verification, welcome, quote-approved, quote-declined' })
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
  const industryPack = getIndustryPack(businessType)
  const user = await prisma.$transaction(async (transaction) => {
    const created = await transaction.user.create({
      data: { name, email, passwordHash, emailVerifiedAt: verification.verifiedAt },
      select: { id: true, name: true, email: true, role: true },
    })
    const subdomain = await allocateSubdomain(transaction, businessName)
    const organisation = await transaction.organisation.create({
      data: {
        name: businessName,
        subdomain,
        email,
        phone,
        country,
        businessType,
        defaultTaxRate: country === 'Kenya' ? 16 : 0,
        ownerId: created.id,
        currency: ({
          Kenya: 'KES', Uganda: 'UGX', Tanzania: 'TZS', Rwanda: 'RWF', Nigeria: 'NGN', Ghana: 'GHS',
          'South Africa': 'ZAR', Egypt: 'EGP', Morocco: 'MAD', Ethiopia: 'ETB', Algeria: 'DZD', Angola: 'AOA',
          Botswana: 'BWP', Zambia: 'ZMW', Malawi: 'MWK', Mozambique: 'MZN', Namibia: 'NAD', Mauritius: 'MUR',
          Madagascar: 'MGA', Senegal: 'XOF', 'Côte d’Ivoire': 'XOF', Cameroon: 'XAF', 'DR Congo': 'CDF',
          Tunisia: 'TND', Zimbabwe: 'ZWG', Eswatini: 'SZL', 'United Kingdom': 'GBP', 'United States': 'USD',
        } as Record<string, string>)[country] ?? 'USD',
        quotePrefix: 'QT',
        serviceItems: { create: industryPack.services.map((item) => ({ ...item, isStarter: true })) },
        quoteTemplates: { create: industryPack.templates.map((template) => ({ ...template, isStarter: true })) },
        members: { connect: { id: created.id } },
        subscription: { create: { plan, status: 'TRIALING', trialEndsAt, simulated: true } },
      },
    })
    await transaction.user.update({ where: { id: created.id }, data: { organisationId: organisation.id } })
    return { ...created, organisationId: organisation.id, subdomain }
  })

  const platformUrl = process.env.PLATFORM_URL ?? 'http://localhost:5174'
  const baseDomain = (process.env.TENANT_BASE_DOMAIN ?? 'trendscore.co.ke').replace(/^\.+|\.+$/g, '')
  const workspaceUrl = process.env.NODE_ENV === 'production' ? `https://${user.subdomain}.${baseDomain}` : platformUrl
  const welcomeEmailSent = await sendEmail(
    email,
    emailSubjects.welcome(businessName),
    welcomeEmailHtml({ name, businessName, businessType, country, plan, trialEndsAt, phone, loginUrl: workspaceUrl }),
    `welcome/${createdEmailKey(email)}`,
    user.organisationId,
  ).catch(() => false)

  const token = await issueSession(user.id)
  await prisma.signupVerification.deleteMany({ where: { email } })
  sendSessionCookie(res, token)

  res.status(201).json({ user: toPublicUser(user), welcomeEmailSent, subdomain: user.subdomain })
})

app.post('/api/auth/verification/send', publicRateLimit, async (req, res) => {
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
  const from = platformSenderEmail()
  if (!apiKey && process.env.NODE_ENV === 'production') return res.status(503).json({ message: 'Email verification is not configured. Add a Resend API key and verified sender address.' })
  if (apiKey && !from) return res.status(503).json({ message: 'Set a verified Resend sender address before sending email.' })
  let emailSent: false | { success: true; messageId: string | null } = false
  try {
    if (apiKey && from) {
      emailSent = await sendEmail(
        email,
        emailSubjects.verification,
        verificationEmailHtml({ email, code }),
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
})

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
    platformSenderAvailable: platformEmailReady(),
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
      ...(domainChanged || provider !== 'CUSTOM' ? { domainStatus: provider === 'CUSTOM' && customDomain ? 'PENDING' : 'NOT_CONFIGURED', domainRecords: Prisma.DbNull, verifiedAt: null } : {}),
    },
  })
  res.json({ provider: next.provider, senderName: next.senderName ?? '', senderEmail: next.senderEmail ?? '', customDomain: next.customDomain ?? '', domainStatus: next.domainStatus, apiKeySet: Boolean(next.resendApiKeyCiphertext) })
})

function decryptPaymentSecret(value: string | null | undefined) {
  if (!value) return null
  return decryptEmailSecret(value)
}

app.get('/api/settings/payments', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  const settings = await prisma.tenantPaymentSettings.findUnique({ where: { organisationId } })
  return res.json({
    provider: settings?.provider ?? 'NCBA', merchantType: settings?.merchantType ?? 'TILL',
    tillNumber: settings?.tillNumber ?? '', paybillNumber: settings?.paybillNumber ?? '', enabled: Boolean(settings?.enabled),
    stkCredentialsSet: Boolean(settings?.stkUsernameCiphertext && settings.stkSecretCiphertext),
    notificationCredentialsSet: Boolean(settings?.notificationUsernameCiphertext && settings.notificationPasswordCiphertext && settings.notificationSecretCiphertext),
    encryptionReady: Boolean(emailEncryptionKey && emailEncryptionKey.length >= 32),
  })
})

app.put('/api/settings/payments', requireTeamRole('OWNER'), async (req, res) => {
  const user = getRequestUser(req)
  const organisationId = user ? await getOrganisationId(user.id) : null
  if (!organisationId) return res.status(404).json({ message: 'Business workspace not found.' })
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) return res.status(503).json({ message: 'Secure payment credential storage is not configured by the platform.' })
  const merchantType = String(req.body?.merchantType ?? 'TILL').toUpperCase()
  if (!['TILL', 'PAYBILL'].includes(merchantType)) return res.status(400).json({ message: 'Choose a Till or Paybill merchant account.' })
  const tillNumber = normalizeMerchantCode(req.body?.tillNumber)
  const paybillNumber = normalizeMerchantCode(req.body?.paybillNumber)
  const stkUsername = String(req.body?.stkUsername ?? '').trim()
  const stkSecret = String(req.body?.stkSecret ?? '').trim()
  const notificationUsername = String(req.body?.notificationUsername ?? '').trim()
  const notificationPassword = String(req.body?.notificationPassword ?? '').trim()
  const notificationSecret = String(req.body?.notificationSecret ?? '').trim()
  const requestedEnabled = Boolean(req.body?.enabled)
  if (merchantType === 'TILL' && !tillNumber) return res.status(400).json({ message: 'Enter the NCBA Till number.' })
  if (merchantType === 'PAYBILL' && !paybillNumber) return res.status(400).json({ message: 'Enter the Paybill number.' })
  if ((notificationUsername || notificationPassword || notificationSecret) && !(notificationUsername && notificationPassword && notificationSecret)) return res.status(400).json({ message: 'Enter all three NCBA notification credentials, or leave them blank to use transaction-status checks.' })
  const existing = await prisma.tenantPaymentSettings.findUnique({ where: { organisationId } })
  const nextStkUsername = stkUsername ? encryptEmailSecret(stkUsername) : existing?.stkUsernameCiphertext ?? null
  const nextStkSecret = stkSecret ? encryptEmailSecret(stkSecret) : existing?.stkSecretCiphertext ?? null
  const enabled = requestedEnabled && Boolean(nextStkUsername && nextStkSecret)
  if (requestedEnabled && !enabled) return res.status(400).json({ message: 'Enter and save the NCBA STK username and secret before enabling customer payments.' })
  const next = await prisma.tenantPaymentSettings.upsert({
    where: { organisationId },
    create: {
      organisationId, merchantType, tillNumber: merchantType === 'TILL' ? tillNumber : null,
      paybillNumber: merchantType === 'PAYBILL' ? paybillNumber : null,
      stkUsernameCiphertext: nextStkUsername, stkSecretCiphertext: nextStkSecret, enabled,
      notificationUsernameCiphertext: notificationUsername ? encryptEmailSecret(notificationUsername) : existing?.notificationUsernameCiphertext ?? null,
      notificationPasswordCiphertext: notificationPassword ? encryptEmailSecret(notificationPassword) : existing?.notificationPasswordCiphertext ?? null,
      notificationSecretCiphertext: notificationSecret ? encryptEmailSecret(notificationSecret) : existing?.notificationSecretCiphertext ?? null,
    },
    update: {
      merchantType, tillNumber: merchantType === 'TILL' ? tillNumber : null,
      paybillNumber: merchantType === 'PAYBILL' ? paybillNumber : null,
      stkUsernameCiphertext: nextStkUsername, stkSecretCiphertext: nextStkSecret, enabled,
      notificationUsernameCiphertext: notificationUsername ? encryptEmailSecret(notificationUsername) : existing?.notificationUsernameCiphertext ?? null,
      notificationPasswordCiphertext: notificationPassword ? encryptEmailSecret(notificationPassword) : existing?.notificationPasswordCiphertext ?? null,
      notificationSecretCiphertext: notificationSecret ? encryptEmailSecret(notificationSecret) : existing?.notificationSecretCiphertext ?? null,
    },
  })
  return res.json({ merchantType: next.merchantType, tillNumber: next.tillNumber ?? '', paybillNumber: next.paybillNumber ?? '', enabled: next.enabled, stkCredentialsSet: Boolean(next.stkUsernameCiphertext && next.stkSecretCiphertext), notificationCredentialsSet: Boolean(next.notificationUsernameCiphertext && next.notificationPasswordCiphertext && next.notificationSecretCiphertext), encryptionReady: true })
})

function safeSecretMatch(received: unknown, expected: string | null) {
  if (typeof received !== 'string' || !expected) return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function callbackField(payload: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (payload[name] !== undefined && payload[name] !== null) return String(payload[name]).trim()
  return ''
}

function parseNcbaXmlCallback(xml: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const match of xml.matchAll(/<(?:\w+:)?([A-Za-z][\w.-]*)\b[^>]*>([^<>]*)<\/(?:\w+:)?\1\s*>/g)) {
    const key = match[1]
    const value = match[2].replace(/<[^>]+>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").trim()
    if (value) payload[key] = value
  }
  return payload
}

app.post('/api/webhooks/ncba/customer-payment', express.text({ type: ['application/xml', 'text/xml', 'application/soap+xml'], limit: '32kb' }), async (req, res) => {
  const xmlRequest = typeof req.body === 'string' || String(req.header('content-type') ?? '').includes('xml')
  const reply = (ok: boolean) => {
    if (xmlRequest) return res.status(200).type('application/xml').send(`<Result>${ok ? 'OK' : 'FAIL'}</Result>`)
    return res.status(ok ? 200 : 400).json({ ResultCode: ok ? '0' : '1', ResultDesc: ok ? 'Accepted' : 'Invalid payment notification' })
  }
  const payload = typeof req.body === 'string' ? parseNcbaXmlCallback(req.body) : req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
  const transactionId = callbackField(payload, 'TransID', 'TransactionID')
  if (!transactionId) return reply(false)
  const attempt = await prisma.invoicePaymentAttempt.findUnique({ where: { transactionId } })
  if (!attempt) return reply(false)
  if (attempt.status === 'PAID') return reply(true)
  const settings = await prisma.tenantPaymentSettings.findUnique({ where: { organisationId: attempt.organisationId } })
  if (!settings?.notificationUsernameCiphertext || !settings.notificationPasswordCiphertext || !settings.notificationSecretCiphertext) return reply(false)
  const username = decryptPaymentSecret(settings.notificationUsernameCiphertext)
  const password = decryptPaymentSecret(settings.notificationPasswordCiphertext)
  const secret = decryptPaymentSecret(settings.notificationSecretCiphertext)
  if (!safeSecretMatch(callbackField(payload, 'Username', 'UserName'), username) || !safeSecretMatch(callbackField(payload, 'Password'), password) || !verifyNotificationHash(payload, secret ?? '')) return reply(false)
  const amount = Number(callbackField(payload, 'TransAmount', 'amount'))
  if (!Number.isFinite(amount) || Math.abs(amount - Number(attempt.amount)) > 0.001) return reply(false)
  const transactionType = callbackField(payload, 'TransType').toUpperCase()
  if (transactionType && !transactionType.includes('PAY')) return reply(false)
  const shortcode = callbackField(payload, 'BusinessShortCode')
  const receivingAccount = callbackField(payload, 'AccountNr', 'CreditAccount')
  const billReference = callbackField(payload, 'BillRefNumber', 'Narrative')
  const merchantMatches = attempt.merchantType === 'TILL'
    ? shortcode === '880100' && [receivingAccount, billReference].some((value) => value.toUpperCase().includes(attempt.merchantCode.toUpperCase()))
    : shortcode === attempt.merchantCode && billReference.toUpperCase() === attempt.invoiceNumber.toUpperCase()
  if (!merchantMatches) return reply(false)
  const result = await applyCustomerMpesaPayment(attempt.id, transactionId)
  return reply(result.ok)
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

  // Rate limit by email and IP — prevents brute-force attacks
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const rateLimitKey = `${email}:${ip}`
  const rateCheck = await checkLoginRateLimit(rateLimitKey)
  if (!rateCheck.allowed) {
    const minutes = Math.ceil(rateCheck.retryAfterMs / 60000)
    return res.status(429).json({ message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` })
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, passwordHash: true, mfaEnabled: true },
  })

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await recordFailedLogin(rateLimitKey)
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  if (user.role !== 'SUPERADMIN') {
    const workspace = await getWorkspaceSuspension(user.id)
    if (workspace?.status === 'SUSPENDED') return res.status(403).json({ message: `This workspace is suspended. ${workspace.suspensionReason ?? 'Contact iQuote support for assistance.'}`, code: 'WORKSPACE_SUSPENDED' })
  }

  await clearLoginAttempts(rateLimitKey)
  const token = await issueSession(user.id, user.role !== 'SUPERADMIN')
  sendSessionCookie(res, token)

  res.json({ user: toPublicUser(user), mfaRequired: user.role === 'SUPERADMIN' && user.mfaEnabled, mfaSetupRequired: user.role === 'SUPERADMIN' && !user.mfaEnabled })
})

app.post('/api/auth/superadmin-mfa/verify', async (req, res) => {
  const token = readTokenFromRequest(req)
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const user = await loadUserFromToken(token)
  if (!user || user.role !== 'SUPERADMIN') return res.status(403).json({ message: 'Superadmin access required.' })
  const code = String(req.body?.code ?? '').trim()
  if (!token || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter your six-digit authenticator code.' })
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!account?.mfaEnabled || !account.mfaSecret) return res.status(409).json({ message: 'MFA is not configured for this account.' })
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const rateLimitKey = `admin-mfa:${user.email}:${ip}`
  const rateCheck = await checkLoginRateLimit(rateLimitKey)
  if (!rateCheck.allowed) return res.status(429).json({ message: 'Too many incorrect authenticator codes. Try again later.' })
  const mfaSecret = decryptMfaSecret(account.mfaSecret)
  if (!verifySync({ token: code, secret: mfaSecret })) {
    await recordFailedLogin(rateLimitKey)
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_LOGIN_FAILED', 'USER', user.id, 'A super-admin authenticator code was rejected.')
    return res.status(401).json({ message: 'That authenticator code is invalid. Try again.' })
  }
  await clearLoginAttempts(rateLimitKey)
  if (!account.mfaSecret.startsWith('enc:v1:')) await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: encryptMfaSecret(mfaSecret) } })
  await markSessionMfaVerified(token)
  await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_LOGIN_VERIFIED', 'USER', user.id, 'Super-admin sign-in completed with authenticator verification.')
  res.json({ verified: true })
})

app.post('/api/auth/logout', async (req, res) => {
  const token = readTokenFromRequest(req)

  if (token) {
    const tokenHash = hashToken(token)
    await prisma.session.deleteMany({ where: { token: tokenHash } }).catch(() => undefined)
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

  if (user.role !== 'SUPERADMIN') {
    const workspace = await getWorkspaceSuspension(user.id)
    if (workspace?.status === 'SUSPENDED') return res.status(403).json({ message: `This workspace is suspended. ${workspace.suspensionReason ?? 'Contact iQuote support for assistance.'}`, code: 'WORKSPACE_SUSPENDED' })
  }

  if (user.role === 'SUPERADMIN' && !(await hasVerifiedSuperadminSession(token, user.id))) {
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaEnabled: true } })
    return res.json({ user, mfaRequired: Boolean(account?.mfaEnabled), mfaSetupRequired: !account?.mfaEnabled })
  }

  res.json({ user })
})

function addOneMonth(from: Date) {
  const result = new Date(from)
  const day = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + 1)
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(day, lastDay))
  return result
}

async function activateSubscriptionFromPayment(paymentId: string, providerStatus: string, description: string | null) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billingPayment.findUnique({ where: { id: paymentId } })
    if (!payment) return null
    if (payment.status !== 'PENDING') return payment

    const normalizedStatus = providerStatus.trim().toUpperCase()
    if (normalizedStatus === 'FAILED' || normalizedStatus === 'CANCELLED') {
      return tx.billingPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', statusDescription: description || 'The payment was not completed.' } })
    }
    if (normalizedStatus !== 'SUCCESS') {
      return tx.billingPayment.update({ where: { id: payment.id }, data: { statusDescription: description || 'Waiting for payment confirmation.' } })
    }

    const now = new Date()
    const subscription = await tx.subscription.findUnique({ where: { organisationId: payment.organisationId } })
    if (!subscription) return tx.billingPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', statusDescription: 'The workspace subscription record is missing.' } })
    const startFrom = [now, subscription.currentPeriodEndsAt, subscription.trialEndsAt].filter((date): date is Date => Boolean(date)).reduce((latest, date) => date > latest ? date : latest, now)
    const periodEndsAt = addOneMonth(startFrom)
    const updated = await tx.billingPayment.update({
      where: { id: payment.id },
      data: { status: 'PAID', statusDescription: description || 'Payment confirmed by NCBA.', paidAt: now, periodEndsAt },
    })
    await tx.subscription.update({
      where: { organisationId: payment.organisationId },
      data: { plan: payment.plan, status: 'ACTIVE', simulated: false, currentPeriodEndsAt: periodEndsAt },
    })
    return updated
  })
}

app.get('/api/billing/status', requireAuth, async (req, res) => {
  await hydratePlatformNcbaConfig()
  const user = (req as Request & { user?: { id: string } }).user
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing billing.' })
  const [subscription, latestPayment] = await Promise.all([
    refreshSubscriptionState(organisationId),
    prisma.billingPayment.findFirst({ where: { organisationId }, orderBy: { createdAt: 'desc' }, select: { id: true, plan: true, amount: true, currency: true, phone: true, status: true, statusDescription: true, createdAt: true } }),
  ])
  const plans = await platformPlanPrices()
  const state = subscription?.status ?? 'NO_SUBSCRIPTION'
  const quotesThisMonth = await countQuotesThisMonth(organisationId)
  const trialUsage = state === 'TRIALING'
    ? { quotes: await prisma.quote.count({ where: { organisationId, parentQuoteId: null } }), invoices: await prisma.invoice.count({ where: { organisationId } }) }
    : null
  return res.json({
    plan: subscription?.plan ?? 'STARTER', status: state, trialEndsAt: subscription?.trialEndsAt ?? null,
    currentPeriodEndsAt: subscription?.currentPeriodEndsAt ?? null,
    locked: Boolean(subscription && state !== 'TRIALING' && state !== 'ACTIVE'),
    providerConfigured: ncbaStkConfigured(), pricesConfigured: plans.some((item) => item.amount !== null),
    plans,
    entitlements: entitlementsFor(subscription?.plan, subscription?.status),
    usage: { quotesThisMonth, monthStartedAt: startOfMonthEAT().toISOString() },
    trialLimits: state === 'TRIALING' ? TRIAL_LIMITS : null,
    trialUsage,
    latestPayment: latestPayment ? { ...latestPayment, amount: Number(latestPayment.amount), phone: `${latestPayment.phone.slice(0, 5)}••••${latestPayment.phone.slice(-2)}` } : null,
  })
})

app.post('/api/billing/stk', requireTeamRole('OWNER'), async (req, res) => {
  await hydratePlatformNcbaConfig()
  const user = (req as Request & { user?: { id: string } }).user
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before paying.' })
  const plan = String(req.body?.plan ?? '').toUpperCase()
  const amount = await platformPlanPrice(plan)
  const phone = normalizeKenyanPhone(req.body?.phone)
  const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim()
  if (!['STARTER', 'GROWTH', 'TEAM'].includes(plan) || amount === null) return res.status(400).json({ message: 'That plan is not configured for billing.' })
  if (!phone) return res.status(400).json({ message: 'Enter a valid Kenyan Safaricom number, for example 0712345678.' })
  if (!/^[\w:-]{12,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Refresh the payment form and try again.' })
  if (!ncbaStkConfigured()) return res.status(503).json({ message: 'NCBA STK credentials and merchant Till details are not configured yet.' })

  const repeated = await prisma.billingPayment.findUnique({ where: { idempotencyKey } })
  if (repeated) {
    if (repeated.organisationId !== organisationId) return res.status(409).json({ message: 'This payment request has already been used.' })
    return res.json({ payment: { id: repeated.id, plan: repeated.plan, amount: Number(repeated.amount), currency: repeated.currency, status: repeated.status, statusDescription: repeated.statusDescription } })
  }
  await prisma.billingPayment.updateMany({ where: { organisationId, status: 'PENDING', createdAt: { lte: new Date(Date.now() - 15 * 60 * 1000) } }, data: { status: 'EXPIRED', statusDescription: 'Payment request expired. Start a new request to try again.' } })
  const openPayment = await prisma.billingPayment.findFirst({ where: { organisationId, status: 'PENDING', createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) } }, orderBy: { createdAt: 'desc' } })
  if (openPayment) return res.status(409).json({ message: 'A payment request is already waiting. Confirm it or wait for it to expire before retrying.' })

  let payment: Awaited<ReturnType<typeof prisma.billingPayment.create>>
  try {
    payment = await prisma.billingPayment.create({ data: { organisationId, plan, amount, currency: 'KES', phone, idempotencyKey, status: 'PENDING', statusDescription: 'Starting secure payment request.' } })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return res.status(409).json({ message: 'A payment request is already waiting. Confirm it or wait for it to expire before retrying.' })
    throw error
  }
  try {
    const provider = await initiateNcbaStkPush({ telephone: phone, amount })
    const updated = await prisma.billingPayment.update({ where: { id: payment.id }, data: { transactionId: provider.TransactionID, providerReference: provider.ReferenceID, statusDescription: provider.StatusDescription || 'Approve the M-Pesa prompt on your phone.' } })
    return res.status(201).json({ payment: { id: updated.id, plan: updated.plan, amount: Number(updated.amount), currency: updated.currency, status: updated.status, statusDescription: updated.statusDescription } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'NCBA could not start this payment.'
    await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', statusDescription: message } })
    return res.status(502).json({ message })
  }
})

app.get('/api/billing/payments/:id', requireAuth, async (req, res) => {
  await hydratePlatformNcbaConfig()
  const user = (req as Request & { user?: { id: string } }).user
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(404).json({ message: 'Payment was not found.' })
  let payment = await prisma.billingPayment.findFirst({ where: { id: String(req.params.id), organisationId } })
  if (!payment) return res.status(404).json({ message: 'Payment was not found.' })
  if (payment.status === 'PENDING' && payment.transactionId && Date.now() - payment.updatedAt.getTime() >= 5_000) {
    try {
      const result = await queryNcbaStkPush(payment.transactionId)
      payment = await activateSubscriptionFromPayment(payment.id, String(result.status ?? 'PENDING'), String(result.description ?? '')) ?? payment
    } catch {
      // Keep the payment pending when NCBA is temporarily unavailable; the customer can check again.
    }
  }
  return res.json({ payment: { id: payment.id, plan: payment.plan, amount: Number(payment.amount), currency: payment.currency, status: payment.status, statusDescription: payment.statusDescription, paidAt: payment.paidAt, periodEndsAt: payment.periodEndsAt } })
})

// Public plan catalogue for the marketing and signup pages. Prices come from the admin price table
// (or the environment) and limits from plans.ts, so the website cannot drift from what the app enforces.
app.get('/api/public/plans', publicRateLimit, async (_req, res) => {
  const prices = await platformPlanPrices()
  res.json({
    trialLimits: TRIAL_LIMITS,
    plans: prices.map((price) => ({
      plan: price.plan,
      amount: price.amount,
      currency: price.currency,
      entitlements: PLAN_ENTITLEMENTS[price.plan as keyof typeof PLAN_ENTITLEMENTS],
    })),
  })
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

  const includeArchived = req.query?.includeArchived === 'true'
  const page = Math.max(Number(req.query?.page ?? 1), 1)
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = (page - 1) * limit
  const searchQuery = String(req.query?.search ?? '').trim().toLowerCase()

  const where: PrismaTypes.CustomerWhereInput = { organisationId }
  if (!includeArchived) {
    where.archivedAt = null
  }
  if (searchQuery) {
    where.OR = [
      { name: { contains: searchQuery, mode: 'insensitive' } },
      { email: { contains: searchQuery, mode: 'insensitive' } },
      { phone: { contains: searchQuery, mode: 'insensitive' } },
    ]
  }

  const [customers, totalCount] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
      select: { id: true, name: true, phone: true, email: true, archivedAt: true },
    }),
    prisma.customer.count({ where }),
  ])

  res.json({ customers, totalCount, page, limit, hasMore: offset + customers.length < totalCount })
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

  if (!name) {
    return res.status(400).json({ message: 'Customer name is required.' })
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Enter a valid email address.' })
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

  if (!name) {
    return res.status(400).json({ message: 'Customer name is required.' })
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Enter a valid email address.' })
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

  const existing = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Customer not found.' })

  const hasQuotes = await prisma.quote.count({ where: { customerId, organisationId } })
  if (hasQuotes) return res.status(409).json({ message: 'This customer has quotes and cannot be deleted.' })

  await prisma.customer.delete({ where: { id: customerId } })

  res.json({ success: true })
})

app.post('/api/customers/:id/archive', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const customerId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })

  const existing = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Customer not found.' })

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { archivedAt: new Date() },
    select: { id: true, name: true, phone: true, email: true, archivedAt: true },
  })

  res.json({ customer })
})

app.post('/api/customers/:id/restore', requireAuth, async (req, res) => {
  const user = (req as Request & { user?: { id: string; name: string; email: string } }).user
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const customerId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before managing customers.' })

  const existing = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Customer not found.' })

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { archivedAt: null },
    select: { id: true, name: true, phone: true, email: true, archivedAt: true },
  })

  res.json({ customer })
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
  const category = String(req.body?.category ?? '').trim() || 'General'
  const kind = String(req.body?.kind ?? 'SERVICE').toUpperCase()
  const description = String(req.body?.description ?? '').trim() || null
  const unit = String(req.body?.unit ?? 'job').trim() || 'job'
  const defaultPrice = Number(req.body?.defaultPrice ?? 0)
  const rawTaxRate = req.body?.defaultTaxRate
  const defaultTaxRate = rawTaxRate === '' || rawTaxRate === null || rawTaxRate === undefined ? null : Number(rawTaxRate)
  if (!name || !['SERVICE', 'PRODUCT'].includes(kind)) return res.status(400).json({ message: 'Enter a valid name and service or product type.' })
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

app.put('/api/quote-templates/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const templateId = String(req.params.id ?? '')
  const existing = await prisma.quoteTemplate.findFirst({ where: { id: templateId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Template not found.' })
  if (existing.isStarter) return res.status(403).json({ message: 'Starter templates cannot be edited.' })
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
    const template = await prisma.quoteTemplate.update({
      where: { id: templateId },
      data: {
        name: name.slice(0, 100),
        description: description.slice(0, 300),
        lineItems,
        defaultNotes: String(req.body?.defaultNotes ?? '').trim().slice(0, 2000) || null,
        defaultTerms: String(req.body?.defaultTerms ?? '').trim().slice(0, 4000) || null,
      },
    })
    res.json({ template })
  } catch {
    res.status(409).json({ message: 'A template with that name already exists.' })
  }
})

app.delete('/api/quote-templates/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const templateId = String(req.params.id ?? '')
  const existing = await prisma.quoteTemplate.findFirst({ where: { id: templateId, organisationId } })
  if (!existing) return res.status(404).json({ message: 'Template not found.' })
  if (existing.isStarter) return res.status(403).json({ message: 'Starter templates cannot be deleted.' })
  await prisma.quoteTemplate.delete({ where: { id: templateId } })
  res.json({ success: true })
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

  const page = Math.max(Number(req.query?.page ?? 1), 1)
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = (page - 1) * limit
  const statusFilter = String(req.query?.status ?? '').toUpperCase()
  const searchQuery = String(req.query?.search ?? '').trim().toLowerCase()

  const where: PrismaTypes.QuoteWhereInput = { organisationId }
  if (statusFilter && ['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED'].includes(statusFilter)) {
    where.status = statusFilter as never
  }
  if (searchQuery) {
    where.OR = [
      { documentNumber: { contains: searchQuery, mode: 'insensitive' } },
      { customer: { name: { contains: searchQuery, mode: 'insensitive' } } },
    ]
  }

  const [quotes, totalCount] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } }, invoice: { select: { id: true, invoiceNumber: true, status: true } }, jobs: { select: { id: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.quote.count({ where }),
  ])
  res.json({ quotes: quotes.map(serializeQuote), totalCount, page, limit, hasMore: offset + quotes.length < totalCount })
})

app.post('/api/quotes', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  const organisation = organisationId ? await prisma.organisation.findUnique({ where: { id: organisationId } }) : null
  if (!organisation?.name) return res.status(409).json({ message: 'Complete your business profile before creating a quote.' })

  const customerId = String(req.body?.customerId ?? '')
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId: organisationId ?? '__none__' } })
  if (!customer) return res.status(400).json({ message: 'Choose a customer for this quote.' })

  const trialQuoteBlock = await trialLimitReached(organisation.id, 'quotes')
  if (trialQuoteBlock) return res.status(403).json({ message: trialQuoteBlock, code: PLAN_LIMIT_CODE })

  const planLimits = await getEntitlements(organisation.id)
  if (!quotaState(await countQuotesThisMonth(organisation.id), planLimits.quotesPerMonth).allowed) {
    return res.status(403).json({ message: limitReachedMessage('quotes', planLimits.quotesPerMonth), code: PLAN_LIMIT_CODE })
  }

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

app.post('/api/quotes/:id/revisions', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const source = await prisma.quote.findFirst({
    where: { id: String(req.params.id ?? ''), organisationId },
    include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { id: true, name: true, phone: true, email: true } } },
  })
  if (!source) return res.status(404).json({ message: 'Quote not found.' })
  if (source.status === 'DRAFT') return res.status(409).json({ message: 'This quote is already a draft. Open it directly to edit.' })

  const existingDraft = await prisma.quote.findFirst({
    where: { organisationId, parentQuoteId: source.id, status: 'DRAFT' },
    include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
    orderBy: { version: 'desc' },
  })
  if (existingDraft) return res.json({ quote: serializeQuote(existingDraft), revisedFrom: serializeQuote(source) })

  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId } })
  if (!organisation) return res.status(404).json({ message: 'Business workspace not found.' })
  const revision = await prisma.$transaction(async (tx) => {
    const year = new Date().getFullYear()
    const sequence = await tx.quoteSequence.upsert({
      where: { organisationId_year: { organisationId, year } },
      update: { nextNumber: { increment: 1 } },
      create: { organisationId, year, nextNumber: 1 },
    })
    const documentNumber = `${organisation.quotePrefix || 'QT'}-${year}-${String(sequence.nextNumber).padStart(4, '0')}`
    return tx.quote.create({
      data: {
        organisationId,
        ownerId: user.id,
        customerId: source.customerId,
        documentNumber,
        parentQuoteId: source.id,
        version: source.version + 1,
        currency: source.currency,
        validUntil: source.validUntil,
        notes: source.notes,
        terms: source.terms,
        subtotal: source.subtotal,
        taxTotal: source.taxTotal,
        total: source.total,
        lines: { create: source.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, taxRate: line.taxRate, position: line.position })) },
      },
      include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
    })
  })
  return res.status(201).json({ quote: serializeQuote(revision), revisedFrom: serializeQuote(source) })
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

app.get('/api/notifications', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const notifications = await prisma.notification.findMany({ where: { recipientUserId: user.id }, include: { quote: { select: { id: true, documentNumber: true } } }, orderBy: { createdAt: 'desc' }, take: 30 })
  const unreadCount = await prisma.notification.count({ where: { recipientUserId: user.id, readAt: null } })
  res.json({ notifications, unreadCount })
})

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  await prisma.notification.updateMany({ where: { recipientUserId: user.id, readAt: null }, data: { readAt: new Date() } })
  res.json({ ok: true })
})

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  await prisma.notification.updateMany({ where: { id: String(req.params.id), recipientUserId: user.id, readAt: null }, data: { readAt: new Date() } })
  res.json({ ok: true })
})

app.get('/api/quotes/:id/messages', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quote = await prisma.quote.findFirst({ where: { id: String(req.params.id), organisationId: await getOrganisationId(user.id) ?? '__none__' } })
  if (!quote || quote.status === 'DRAFT' || !quote.publicToken) return res.status(404).json({ message: 'Conversation is not available.' })
  const messages = await prisma.quoteMessage.findMany({ where: { quoteId: quote.id }, orderBy: { createdAt: 'asc' }, take: 100 })
  res.json({ messages })
})

app.post('/api/quotes/:id/messages', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quote = await prisma.quote.findFirst({ where: { id: String(req.params.id), organisationId: await getOrganisationId(user.id) ?? '__none__' }, include: { owner: { select: { name: true } }, customer: { select: { name: true } } } })
  if (!quote || quote.status === 'DRAFT' || !quote.publicToken) return res.status(404).json({ message: 'Conversation is not available.' })
  if (quote.status === 'EXPIRED') return res.status(409).json({ message: 'This quote has expired; messaging is closed.' })
  const content = String(req.body?.content ?? '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ message: 'Write a message up to 4,000 characters.' })
  const message = await prisma.quoteMessage.create({ data: { quoteId: quote.id, organisationId: quote.organisationId, authorUserId: user.id, authorType: 'BUSINESS', authorName: user.name, content } })
  res.status(201).json({ message })
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

// ---- Quote delivery by email ----

/** Validate email format */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Check for a PENDING delivery in the last N milliseconds */
async function hasRecentPendingDelivery(quoteId: string, recipientEmail: string, withinMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinMs)
  const count = await prisma.quoteDelivery.count({
    where: {
      quoteId,
      recipientEmail: recipientEmail.toLowerCase(),
      status: 'PENDING',
      createdAt: { gte: cutoff },
    },
  })
  return count > 0
}

/** Check for any delivery to this recipient within N milliseconds (any status) */
async function hasRecentDeliveryToRecipient(quoteId: string, recipientEmail: string, withinMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinMs)
  const count = await prisma.quoteDelivery.count({
    where: {
      quoteId,
      recipientEmail: recipientEmail.toLowerCase(),
      createdAt: { gte: cutoff },
    },
  })
  return count > 0
}

app.post('/api/quotes/:id/send', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, organisationId: organisationId ?? '__none__' },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      organisation: { select: { id: true, name: true, email: true, currency: true, logoUrl: true, logoWidth: true, logoHeight: true } },
      lines: { orderBy: { position: 'asc' } },
    },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })

  // Allow sending from DRAFT or SENT status
  if (!['DRAFT', 'SENT'].includes(quote.status)) {
    return res.status(409).json({ message: 'This quote cannot be sent in its current state.' })
  }

  const recipientEmail = String(req.body?.recipientEmail ?? '').trim().toLowerCase()
  const recipientName = String(req.body?.recipientName ?? '').trim() || null
  const message = String(req.body?.message ?? '').trim() || null

  if (!recipientEmail) return res.status(400).json({ message: 'Recipient email is required.' })
  if (!isValidEmail(recipientEmail)) return res.status(400).json({ message: 'Enter a valid email address.' })

  const rawCc = req.body?.ccEmails
  let ccList: string[] = []
  if (Array.isArray(rawCc)) {
    ccList = rawCc.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
  } else if (typeof rawCc === 'string' && rawCc.trim()) {
    ccList = rawCc.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  }

  for (const cc of ccList) {
    if (!isValidEmail(cc)) {
      return res.status(400).json({ message: `Invalid CC email: "${cc}". Please verify the address.` })
    }
  }

  // Plan email cap first, so a blocked send has no side effects (such as syncing the customer email).
  const emailLimit = await dailyEmailLimitReached(quote.organisationId)
  if (emailLimit !== null) return res.status(403).json({ message: limitReachedMessage('emails', emailLimit), code: PLAN_LIMIT_CODE })

  const syncCustomerEmail = Boolean(req.body?.syncCustomerEmail)
  if (syncCustomerEmail && quote.customerId) {
    await prisma.customer.update({
      where: { id: quote.customerId },
      data: { email: recipientEmail },
    }).catch((err) => console.error('Failed to auto-sync customer email:', err))
  }

  // Idempotent: check for PENDING delivery in last 60 seconds
  if (await hasRecentPendingDelivery(quoteId, recipientEmail, 60_000)) {
    return res.status(409).json({ message: 'A send is already in progress. Wait a moment and try again.' })
  }

  // Prevent duplicate sends to same recipient within 5 minutes
  if (await hasRecentDeliveryToRecipient(quoteId, recipientEmail, 5 * 60_000)) {
    return res.status(409).json({ message: 'This quote was recently sent to this recipient. Wait 5 minutes before resending.' })
  }

  // Validate line items exist
  if (!quote.lines.length) {
    return res.status(400).json({ message: 'Add at least one line item before sending this quote.' })
  }

  // Generate or regenerate public token
  const publicToken = quote.publicToken ?? randomBytes(24).toString('base64url')
  const now = new Date()

  const deliveryMessage = ccList.length > 0
    ? (message ? `${message}\n[CC: ${ccList.join(', ')}]` : `[CC: ${ccList.join(', ')}]`)
    : message

  // Create the delivery record
  const delivery = await prisma.quoteDelivery.create({
    data: {
      quoteId: quote.id,
      recipientEmail,
      recipientName,
      message: deliveryMessage,
      status: 'PENDING',
    },
  })

  // Update quote status to SENT and set publicToken
  await prisma.quote.update({
    where: { id: quote.id },
    data: { status: 'SENT', publicToken, tokenRevokedAt: null, tokenRevokedBy: null },
  })

  // Build the public quote URL
  const platformUrl = process.env.PLATFORM_URL ?? 'http://localhost:5174'
  const quoteUrl = `${platformUrl}/quote/${encodeURIComponent(publicToken)}`

  // Build line items for email summary
  const lineItems = quote.lines.map((line) => ({
    description: line.description,
    quantity: Number(line.quantity),
    unitPrice: Number(line.unitPrice),
    total: roundMoney(Number(line.quantity) * Number(line.unitPrice)),
  }))

  // Send the email
  try {
    const result = await sendEmail(
      recipientEmail,
      emailSubjects.quoteDelivery(quote.organisation.name ?? 'iQuote', quote.documentNumber),
      quoteDeliveryEmailHtml({
        recipientName: recipientName ?? quote.customer.name,
        businessName: quote.organisation.name ?? 'iQuote',
        documentNumber: quote.documentNumber,
        total: Number(quote.total),
        currency: quote.currency,
        validUntil: quote.validUntil ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(quote.validUntil) : null,
        lineItems,
        customMessage: message,
        quoteUrl,
      }),
      `quote-delivery/${delivery.id}`,
      quote.organisationId,
      undefined,
      ccList,
      quote.organisation.email ?? undefined,
    )

    await prisma.quoteDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        providerMessageId: result !== false ? (result.messageId ?? null) : null,
        sentAt: now,
      },
    })

    res.json({
      delivery: {
        id: delivery.id,
        recipientEmail,
        recipientName,
        status: 'SENT',
        providerMessageId: result !== false ? (result.messageId ?? null) : null,
        sentAt: now.toISOString(),
      },
      quote: { id: quote.id, status: 'SENT', publicToken },
      customerUpdated: syncCustomerEmail,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Email delivery failed.'
    await prisma.quoteDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', errorMessage },
    })
    res.status(502).json({ message: errorMessage, deliveryId: delivery.id })
  }
})

app.post('/api/quotes/:id/resend', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, organisationId: organisationId ?? '__none__' },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      organisation: { select: { id: true, name: true, email: true, currency: true } },
      lines: { orderBy: { position: 'asc' } },
    },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })

  const recipientEmail = String(req.body?.recipientEmail ?? '').trim().toLowerCase()
  const recipientName = String(req.body?.recipientName ?? '').trim() || null
  const message = String(req.body?.message ?? '').trim() || null

  if (!recipientEmail) return res.status(400).json({ message: 'Recipient email is required.' })
  if (!isValidEmail(recipientEmail)) return res.status(400).json({ message: 'Enter a valid email address.' })

  // Drafts have no live public link (the public page returns 404 for them), so they cannot be resent.
  if (quote.status === 'DRAFT') return res.status(409).json({ message: 'Send this quote first. Drafts cannot be resent.' })

  // Keep the existing public link so links already emailed keep working.
  // A new token is only created when the link was revoked (publicToken is null).
  const publicToken = quote.publicToken ?? randomBytes(24).toString('base64url')
  const now = new Date()

  const emailLimit = await dailyEmailLimitReached(quote.organisationId)
  if (emailLimit !== null) return res.status(403).json({ message: limitReachedMessage('emails', emailLimit), code: PLAN_LIMIT_CODE })

  // Create a new delivery record (explicit resend bypasses the 5-min dedup)
  const delivery = await prisma.quoteDelivery.create({
    data: {
      quoteId: quote.id,
      recipientEmail,
      recipientName,
      message,
      status: 'PENDING',
    },
  })

  await prisma.quote.update({
    where: { id: quote.id },
    data: { publicToken, tokenRevokedAt: null, tokenRevokedBy: null },
  })

  const platformUrl = process.env.PLATFORM_URL ?? 'http://localhost:5174'
  const quoteUrl = `${platformUrl}/quote/${encodeURIComponent(publicToken)}`

  const lineItems = quote.lines.map((line) => ({
    description: line.description,
    quantity: Number(line.quantity),
    unitPrice: Number(line.unitPrice),
    total: roundMoney(Number(line.quantity) * Number(line.unitPrice)),
  }))

  try {
    const result = await sendEmail(
      recipientEmail,
      emailSubjects.quoteDelivery(quote.organisation.name ?? 'iQuote', quote.documentNumber),
      quoteDeliveryEmailHtml({
        recipientName: recipientName ?? quote.customer.name,
        businessName: quote.organisation.name ?? 'iQuote',
        documentNumber: quote.documentNumber,
        total: Number(quote.total),
        currency: quote.currency,
        validUntil: quote.validUntil ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(quote.validUntil) : null,
        lineItems,
        customMessage: message,
        quoteUrl,
      }),
      `quote-delivery/${delivery.id}`,
      quote.organisationId,
      undefined,
      undefined,
      quote.organisation.email ?? undefined,
    )

    await prisma.quoteDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        providerMessageId: result !== false ? (result.messageId ?? null) : null,
        sentAt: now,
      },
    })

    res.json({
      delivery: {
        id: delivery.id,
        recipientEmail,
        recipientName,
        status: 'SENT',
        providerMessageId: result !== false ? (result.messageId ?? null) : null,
        sentAt: now.toISOString(),
      },
      quote: { id: quote.id, publicToken },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Email delivery failed.'
    await prisma.quoteDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', errorMessage },
    })
    res.status(502).json({ message: errorMessage, deliveryId: delivery.id })
  }
})

app.get('/api/quotes/:id/deliveries', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, organisationId: organisationId ?? '__none__' },
    select: { id: true },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })

  const deliveries = await prisma.quoteDelivery.findMany({
    where: { quoteId: quote.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  res.json({
    deliveries: deliveries.map((d) => ({
      id: d.id,
      recipientEmail: d.recipientEmail,
      recipientName: d.recipientName,
      status: d.status,
      providerMessageId: d.providerMessageId,
      errorMessage: d.errorMessage,
      sentAt: d.sentAt,
      deliveredAt: d.deliveredAt,
      bouncedAt: d.bouncedAt,
      createdAt: d.createdAt,
    })),
  })
})

app.post('/api/quotes/:id/revoke-link', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const quoteId = String(req.params.id ?? '')
  const organisationId = await getOrganisationId(user.id)

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, organisationId: organisationId ?? '__none__' },
    select: { id: true, publicToken: true },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })
  if (!quote.publicToken) return res.status(409).json({ message: 'This quote has no active public link.' })

  const generateNew = Boolean(req.body?.generateNew)
  const newToken = generateNew ? randomBytes(24).toString('base64url') : null

  await prisma.quote.update({
    where: { id: quote.id },
    data: {
      publicToken: newToken,
      tokenRevokedAt: new Date(),
      tokenRevokedBy: user.id,
    },
  })

  res.json({
    revoked: true,
    revokedAt: new Date().toISOString(),
    revokedBy: user.id,
    newToken: generateNew ? newToken : null,
  })
})

app.get('/api/public/quotes/:token', publicRateLimit, async (req, res) => {
  const publicToken = String(req.params.token ?? '')
  const quote = await prisma.quote.findUnique({
    where: { publicToken },
    include: {
      customer: { select: { name: true } },
      organisation: { select: { name: true, email: true, phone: true, country: true, currency: true, logoUrl: true, logoWidth: true, logoHeight: true, website: true, paymentInstructions: true } },
      lines: { orderBy: { position: 'asc' } },
      jobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { title: true, status: true, updatedAt: true, milestones: { where: { customerVisible: true }, orderBy: { position: 'asc' }, select: { id: true, title: true, dueDate: true, completedAt: true } } } },
      invoice: { select: { invoiceNumber: true, status: true, currency: true, subtotal: true, taxTotal: true, total: true, amountPaid: true, balanceDue: true, issueDate: true, dueDate: true, lineItems: true } },
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
  if (quote.status === 'VIEWED' && quote.viewedAt) {
    await prisma.notification.upsert({ where: { sourceKey: `quote-viewed:${quote.id}` }, update: {}, create: { recipientUserId: quote.ownerId, organisationId: quote.organisationId, quoteId: quote.id, type: 'QUOTE_VIEWED', title: 'Quote viewed', body: `${quote.customer.name} viewed ${quote.documentNumber}.`, sourceKey: `quote-viewed:${quote.id}` } }).catch(() => {})
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
      project: quote.jobs[0] ?? null,
      invoice: serializePublicInvoice(quote.invoice),
    },
  })
})

app.post('/api/public/quotes/:token/decision', publicRateLimit, async (req, res) => {
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
    data: { status: nextStatus, decisionComment: String(req.body?.comment ?? '').trim().slice(0, 4000) || null, decidedAt },
  })
  if (!result.count) return res.status(409).json({ message: 'This quote can no longer be changed.' })

  // Send decision notification email to the business owner
  const fullQuote = await prisma.quote.findUnique({
    where: { id: quote.id },
    select: {
      documentNumber: true,
      total: true,
      currency: true,
      customer: { select: { name: true } },
      decisionComment: true,
      publicToken: true,
      owner: { select: { id: true, name: true, email: true } },
      organisationId: true,
    },
  })
  if (fullQuote) {
    if (fullQuote.decisionComment) {
      await prisma.quoteMessage.create({ data: { quoteId: quote.id, organisationId: fullQuote.organisationId, authorType: 'CUSTOMER', authorName: fullQuote.customer.name, content: fullQuote.decisionComment } }).catch(() => {})
    }
    await prisma.notification.upsert({ where: { sourceKey: `quote-decision:${quote.id}` }, update: {}, create: { recipientUserId: fullQuote.owner.id, organisationId: fullQuote.organisationId, quoteId: quote.id, type: 'QUOTE_DECISION', title: decision === 'APPROVED' ? 'Quote approved' : 'Quote declined', body: `${fullQuote.customer.name} ${decision === 'APPROVED' ? 'approved' : 'declined'} ${fullQuote.documentNumber}.`, sourceKey: `quote-decision:${quote.id}` } }).catch(() => {})
    const platformUrl = process.env.PLATFORM_URL ?? 'http://localhost:5174'
    const quoteUrl = `${platformUrl}/quote/${encodeURIComponent(fullQuote.publicToken ?? '')}`
    sendEmail(
      fullQuote.owner.email,
      decision === 'APPROVED' ? emailSubjects.quoteApproved(fullQuote.documentNumber) : emailSubjects.quoteDeclined(fullQuote.documentNumber),
      quoteDecisionEmailHtml({
        ownerName: fullQuote.owner.name,
        documentNumber: fullQuote.documentNumber,
        customerName: fullQuote.customer.name,
        total: Number(fullQuote.total),
        currency: fullQuote.currency,
        decision: decision as 'APPROVED' | 'DECLINED',
        comment: fullQuote.decisionComment,
        quoteUrl,
      }),
      `decision/${fullQuote.owner.id}/${quote.id}/${decision}`,
      fullQuote.organisationId ?? undefined,
    ).catch(() => false) // non-blocking — the decision is already recorded
  }

  const updated = { status: nextStatus, decidedAt }
  res.json({ quote: updated })
})

app.get('/api/public/quotes/:token/messages', publicRateLimit, async (req, res) => {
  const quote = await prisma.quote.findUnique({ where: { publicToken: String(req.params.token ?? '') } })
  if (!quote || quote.status === 'DRAFT') return res.status(404).json({ message: 'Conversation is not available.' })
  const messages = await prisma.quoteMessage.findMany({ where: { quoteId: quote.id }, orderBy: { createdAt: 'asc' }, take: 100 })
  res.json({ messages })
})

app.post('/api/public/quotes/:token/messages', publicRateLimit, async (req, res) => {
  const quote = await prisma.quote.findUnique({ where: { publicToken: String(req.params.token ?? '') }, include: { customer: { select: { name: true } } } })
  if (!quote || quote.status === 'DRAFT') return res.status(404).json({ message: 'Conversation is not available.' })
  if (quote.status === 'EXPIRED' || (quote.validUntil && quote.validUntil < new Date() && ['SENT', 'VIEWED'].includes(quote.status))) return res.status(409).json({ message: 'This quote has expired; messaging is closed.' })
  const content = String(req.body?.content ?? '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ message: 'Write a message up to 4,000 characters.' })
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.quoteMessage.create({ data: { quoteId: quote.id, organisationId: quote.organisationId, authorType: 'CUSTOMER', authorName: quote.customer.name, content } })
    await tx.notification.create({ data: { recipientUserId: quote.ownerId, organisationId: quote.organisationId, quoteId: quote.id, quoteMessageId: created.id, type: 'QUOTE_MESSAGE', title: 'New quote message', body: `${quote.customer.name} sent a message about ${quote.documentNumber}.`, sourceKey: `quote-message:${created.id}` } })
    return created
  })
  res.status(201).json({ message })
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
      logoWidth: true,
      logoHeight: true,
      website: true,
      paymentInstructions: true,
      terms: true,
      subdomain: true,
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

  const name = String(req.body?.name ?? '').trim().slice(0, 200)
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254) || null
  const phone = String(req.body?.phone ?? '').trim().slice(0, 50) || null
  const country = String(req.body?.country ?? '').trim().slice(0, 100) || null
  const businessType = String(req.body?.businessType ?? '').trim().slice(0, 100) || null
  const currency = String(req.body?.currency ?? 'KES').trim().toUpperCase().slice(0, 3) || 'KES'
  const quotePrefix = String(req.body?.quotePrefix ?? 'QT').trim().toUpperCase().slice(0, 8).replace(/[^A-Z0-9]/g, '') || 'QT'
  const paymentInstructions = String(req.body?.paymentInstructions ?? '').trim().slice(0, 5000) || null
  const terms = String(req.body?.terms ?? '').trim().slice(0, 10000) || null

  // logoUrl is now only set via the file upload endpoint — reject arbitrary URLs from the form
  // undefined = leave the stored logo untouched; null = explicitly remove it.
  const rawLogoUrl = String(req.body?.logoUrl ?? '').trim()
  const logoUrl: string | null | undefined = rawLogoUrl.startsWith('/uploads/')
    ? rawLogoUrl.slice(0, 200)
    : req.body?.logoUrl === null || (typeof req.body?.logoUrl === 'string' && rawLogoUrl === '')
      ? null
      : undefined
  const website = String(req.body?.website ?? '').trim().slice(0, 200) || null

  const rawTaxRate = req.body?.defaultTaxRate
  let defaultTaxRate: number | null = null
  if (rawTaxRate !== undefined && rawTaxRate !== null && rawTaxRate !== '') {
    defaultTaxRate = Number(rawTaxRate)
    if (Number.isNaN(defaultTaxRate) || defaultTaxRate < 0 || defaultTaxRate > 100) {
      return res.status(400).json({ message: 'Default tax rate must be between 0 and 100.' })
    }
  }

  if (!name) {
    return res.status(400).json({ message: 'Business name is required.' })
  }

  // Validate currency is a plausible ISO 4217 code (3 letters)
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ message: 'Currency must be a 3-letter code (e.g. KES, USD, GBP).' })
  }
  const organisationId = await getOrganisationId(user.id)
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  const select = {
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
    logoWidth: true,
    logoHeight: true,
    website: true,
    paymentInstructions: true,
    terms: true,
    subdomain: true,
    subscription: { select: { plan: true, status: true, trialEndsAt: true, simulated: true } },
  } as const

  let organisation
  let createdWorkspace = false
  if (organisationId) {
    const existing = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { ownerId: true, subdomain: true } })
    if (!existing) return res.status(404).json({ message: 'Business workspace not found.' })
    if (existing.ownerId !== user.id) return res.status(403).json({ message: 'Only the workspace owner can change business settings.' })
    organisation = await prisma.$transaction(async (transaction) => {
      const subdomain = existing.subdomain ?? await allocateSubdomain(transaction, name)
      return transaction.organisation.update({
        where: { id: organisationId },
        data: { subdomain, name, email, phone, country, businessType, currency, defaultTaxRate, quotePrefix, logoUrl, website, paymentInstructions, terms },
        select,
      })
    })
  } else {
    const industryPack = getIndustryPack(businessType)
    organisation = await prisma.$transaction(async (transaction) => {
      const subdomain = await allocateSubdomain(transaction, name)
      const created = await transaction.organisation.create({
        data: {
          ownerId: user.id,
          subdomain,
          name,
          email: email ?? user.email,
          phone,
          country,
          businessType,
          currency,
          defaultTaxRate: defaultTaxRate === null ? undefined : defaultTaxRate,
          quotePrefix,
          logoUrl,
          website,
          paymentInstructions,
          terms,
          members: { connect: { id: user.id } },
          serviceItems: { create: industryPack.services.map((item) => ({ ...item, isStarter: true })) },
          quoteTemplates: { create: industryPack.templates.map((template) => ({ ...template, isStarter: true })) },
          subscription: { create: { plan: 'STARTER', status: 'TRIALING', trialEndsAt, simulated: true } },
        },
        select,
      })
      await transaction.user.update({ where: { id: user.id }, data: { organisationId: created.id } })
      return created
    })
    createdWorkspace = true
  }

  let welcomeEmailSent: boolean = false
  if (createdWorkspace) {
    const platformUrl = process.env.PLATFORM_URL ?? 'http://localhost:5174'
    const baseDomain = (process.env.TENANT_BASE_DOMAIN ?? 'trendscore.co.ke').replace(/^\.+|\.+$/g, '')
    const workspaceUrl = process.env.NODE_ENV === 'production'
      ? `https://${organisation.subdomain}.${baseDomain}`
      : platformUrl
    welcomeEmailSent = !!(await sendEmail(
      user.email,
      emailSubjects.welcome(name),
      welcomeEmailHtml({ name: user.name, businessName: name, businessType, country: country ?? '', plan: 'STARTER', trialEndsAt, phone, loginUrl: workspaceUrl }),
      `welcome/${createdEmailKey(user.email)}`,
      organisation.id,
    ).catch(() => false))
  }

  res.status(createdWorkspace ? 201 : 200).json({ organisation, welcomeEmailSent })
})

// ---- Logo file upload ----
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_LOGO_SIZE = 5 * 1024 * 1024 // 5 MB

// Magic bytes signatures for real image validation (not just Content-Type)
const IMAGE_SIGNATURES: Array<{ bytes: number[]; ext: string; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], ext: '.png', mime: 'image/png' },       // PNG
  { bytes: [0xFF, 0xD8, 0xFF], ext: '.jpg', mime: 'image/jpeg' },              // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: '.gif', mime: 'image/gif' },         // GIF (GIF8)
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.webp', mime: 'image/webp' },       // WebP (RIFF....WEBP)
]

function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  // Binary formats: match by magic bytes
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((byte, i) => buffer[i] === byte)) {
      // WebP needs extra check: bytes 8-11 should be 'WEBP'
      if (sig.ext === '.webp') {
        const vp8 = buffer.subarray(8, 12).toString('ascii')
        if (vp8 !== 'WEBP') continue
      }
      return sig
    }
  }
  return null
}

app.post('/api/settings/logo', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace before uploading a logo.' })

  const contentType = req.headers['content-type'] ?? ''
  if (!ALLOWED_IMAGE_TYPES.some((type) => contentType.includes(type))) {
    return res.status(400).json({ message: 'Logo must be a PNG, JPEG, WebP, or GIF image.' })
  }

  const chunks: Buffer[] = []
  let totalSize = 0
  req.on('data', (chunk: Buffer) => {
    totalSize += chunk.length
    if (totalSize > MAX_LOGO_SIZE) {
      req.destroy()
      return
    }
    chunks.push(chunk)
  })

  req.on('end', async () => {
    if (totalSize === 0) return res.status(400).json({ message: 'No file received.' })
    if (totalSize > MAX_LOGO_SIZE) return res.status(413).json({ message: 'Logo file is too large. Maximum 5 MB.' })

    const buffer = Buffer.concat(chunks)

    // Validate actual file content via magic bytes — prevents spoofed Content-Type attacks
    const detected = detectImageType(buffer)
    if (!detected) {
      return res.status(400).json({ message: 'The file does not appear to be a valid image. The content could not be verified.' })
    }

    const filename = `logo-${organisationId}-${Date.now()}${detected.ext}`

    try {
      await mkdir(uploadsDir, { recursive: true })
      await writeFile(join(uploadsDir, filename), buffer)

      const logoUrl = `/uploads/${filename}`
      
      // Extract logo dimensions
      let logoWidth: number | undefined
      let logoHeight: number | undefined
      try {
        const dimensions = sizeOf(buffer)
        logoWidth = dimensions.width
        logoHeight = dimensions.height
      } catch {
        // If dimension extraction fails (e.g., unsupported SVG variant), leave dimensions undefined
      }

      await prisma.organisation.update({ 
        where: { id: organisationId }, 
        data: { logoUrl, logoWidth, logoHeight } 
      })

      res.json({ logoUrl })
    } catch {
      res.status(500).json({ message: 'Could not save the logo file.' })
    }
  })

  req.on('error', () => {
    if (!res.headersSent) res.status(500).json({ message: 'Logo upload failed.' })
  })
})

app.delete('/api/settings/logo', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'No workspace found.' })

  await prisma.organisation.update({ where: { id: organisationId }, data: { logoUrl: null, logoWidth: null, logoHeight: null } })
  res.json({ success: true })
})

// ---- Superadmin routes ----
app.get('/api/superadmin/billing/prices', requireSuperadmin, async (_req, res) => {
  const prices = await platformPlanPrices()
  res.json({ prices })
})

app.put('/api/superadmin/billing/prices', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  if (!actor) return res.status(401).json({ message: 'Unauthorized' })
  const reason = String(req.body?.reason ?? '').trim().slice(0, 300)
  if (reason.length < 5) return res.status(400).json({ message: 'Add a short reason for this pricing change.' })
  const inputs = req.body?.prices
  if (!Array.isArray(inputs) || inputs.length !== BILLING_PLANS.length) return res.status(400).json({ message: 'Provide a price for each of the three plans.' })
  const normalized: Array<{ plan: typeof BILLING_PLANS[number]; amount: number | null }> = []
  for (const plan of BILLING_PLANS) {
    const matches = inputs.filter((item: unknown) => item && typeof item === 'object' && String((item as Record<string, unknown>).plan ?? '').toUpperCase() === plan)
    if (matches.length !== 1) return res.status(400).json({ message: `Provide exactly one price for ${plan}.` })
    const raw = (matches[0] as Record<string, unknown>).amount
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      normalized.push({ plan, amount: null })
      continue
    }
    const amount = Number(raw)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 || Number(amount.toFixed(2)) !== amount) {
      return res.status(400).json({ message: `${plan} must be a positive KES price with at most two decimal places, or left blank.` })
    }
    normalized.push({ plan, amount })
  }

  const changes = await prisma.$transaction(async (tx) => {
    const rows: Array<{ plan: string; amount: unknown; currency: string }> = []
    for (const { plan, amount } of normalized) {
      rows.push(await tx.platformPlanPrice.upsert({
        where: { plan },
        create: { plan, amount, currency: 'KES', updatedByEmail: actor.email },
        update: { amount, currency: 'KES', updatedByEmail: actor.email },
      }))
    }
    await writeSuperadminAudit(req, actor, 'SUBSCRIPTION_PRICES_UPDATED', 'PLATFORM_BILLING', null, 'Updated monthly subscription plan prices.', {
      reason,
      prices: rows.map((row) => ({ plan: row.plan, amount: row.amount === null ? null : Number(row.amount), currency: row.currency })),
    }, tx)
    return rows
  })
  res.json({ prices: await platformPlanPrices(), message: 'Plan prices saved. New checkouts will use these prices.' })
})

app.get('/api/superadmin/billing/ncba', requireSuperadmin, async (_req, res) => {
  const row = await prisma.platformNcbaConfig.findUnique({ where: { id: 'platform' } })
  const databaseConfigured = Boolean(row?.stkUsernameCiphertext && row?.stkSecretCiphertext && row.paybillNumber && row.tillAccountNumber)
  res.json({
    configured: databaseConfigured || ncbaStkConfigured(),
    source: databaseConfigured ? 'ADMIN' : ncbaStkConfigured() ? 'ENVIRONMENT' : 'UNSET',
    username: row?.stkUsernameCiphertext ? decryptPlatformNcbaSecret(row.stkUsernameCiphertext) : process.env.NCBA_STK_USERNAME ?? '',
    paybillNumber: row?.paybillNumber ?? process.env.NCBA_PAYBILL_NO ?? '',
    tillAccountNumber: row?.tillAccountNumber ?? process.env.NCBA_TILL_ACCOUNT_NO ?? '',
    secretConfigured: databaseConfigured || Boolean(process.env.NCBA_STK_SECRET_KEY?.trim()),
    encryptionReady: Boolean(emailEncryptionKey && emailEncryptionKey.length >= 32),
    updatedAt: row?.updatedAt ?? null,
  })
})

app.put('/api/superadmin/billing/ncba', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  if (!actor) return res.status(401).json({ message: 'Unauthorized.' })
  if (!emailEncryptionKey || emailEncryptionKey.length < 32) return res.status(503).json({ message: 'Platform credential encryption is not configured on the server.' })
  const username = String(req.body?.username ?? '').trim().slice(0, 200)
  const secret = String(req.body?.secret ?? '').trim().slice(0, 500)
  const paybillNumber = String(req.body?.paybillNumber ?? '').trim().slice(0, 40)
  const tillAccountNumber = String(req.body?.tillAccountNumber ?? '').trim().slice(0, 80)
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!username || !paybillNumber || !tillAccountNumber || !reason) return res.status(400).json({ message: 'Enter the NCBA username, Paybill, Till account reference, and reason for this change.' })
  const previous = await prisma.platformNcbaConfig.findUnique({ where: { id: 'platform' } })
  const secretToSave = secret || (previous?.stkSecretCiphertext ? decryptPlatformNcbaSecret(previous.stkSecretCiphertext) : process.env.NCBA_STK_SECRET_KEY?.trim() ?? '')
  if (!secretToSave) return res.status(400).json({ message: 'Enter the NCBA STK secret key to configure the connection.' })
  const saved = await prisma.$transaction(async (tx) => {
    const config = await tx.platformNcbaConfig.upsert({
      where: { id: 'platform' },
      create: { id: 'platform', stkUsernameCiphertext: encryptPlatformNcbaSecret(username), stkSecretCiphertext: encryptPlatformNcbaSecret(secretToSave), paybillNumber, tillAccountNumber, updatedByEmail: actor.email },
      update: { stkUsernameCiphertext: encryptPlatformNcbaSecret(username), stkSecretCiphertext: encryptPlatformNcbaSecret(secretToSave), paybillNumber, tillAccountNumber, updatedByEmail: actor.email },
    })
    await writeSuperadminAudit(req, actor, 'PLATFORM_NCBA_CONFIG_UPDATED', 'PLATFORM_BILLING', null, 'Updated platform NCBA STK configuration.', { reason, secretRotated: Boolean(secret), source: 'ADMIN' }, tx)
    return config
  })
  setPlatformNcbaConfig({ username, secret: decryptPlatformNcbaSecret(saved.stkSecretCiphertext!), paybill: saved.paybillNumber!, tillAccount: saved.tillAccountNumber! })
  res.json({ message: 'NCBA configuration saved securely.', configured: ncbaStkConfigured(), updatedAt: saved.updatedAt })
})

app.get('/api/superadmin/stats', requireSuperadmin, async (_req, res) => {
  const [totalUsers, totalOrganisations, totalQuotes, approvedQuotes, quoteAgg, trialCount, currencyBreakdown] = await Promise.all([
    prisma.user.count(),
    prisma.organisation.count(),
    prisma.quote.count(),
    prisma.quote.count({ where: { status: 'APPROVED' } }),
    prisma.quote.aggregate({ _sum: { total: true }, _count: true }),
    prisma.subscription.count({ where: { status: 'TRIALING' } }),
    prisma.quote.groupBy({ by: ['currency'], _sum: { total: true }, _count: true, orderBy: { currency: 'asc' } }),
  ])

  const recentSignups = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, name: true, email: true, role: true, createdAt: true, organisationId: true, organisation: { select: { name: true } } },
  })

  res.json({
    totalUsers,
    totalOrganisations,
    totalQuotes,
    approvedQuotes,
    totalQuotedValue: Number(quoteAgg._sum.total ?? 0),
    totalQuoteCount: quoteAgg._count,
    activeTrials: trialCount,
    currencyBreakdown: currencyBreakdown.map((row) => ({ currency: row.currency, total: Number(row._sum.total ?? 0), count: row._count })),
    recentSignups: recentSignups.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt, organisationName: u.organisation?.name ?? null })),
  })
})

app.get('/api/superadmin/operations', requireSuperadmin, async (req, res) => {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const stalePendingBefore = new Date(now.getTime() - 10 * 60 * 1000)
  const [database, deliveryCounts24h, deliveryCounts7d, incidents, latestWebhook, webhookCount24h, webhookFailures24h, webhookFailures, emailProviderHealth] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => 'CONNECTED').catch(() => 'UNAVAILABLE'),
    prisma.quoteDelivery.groupBy({ by: ['status'], where: { createdAt: { gte: dayAgo } }, _count: { _all: true }, orderBy: { status: 'asc' } }),
    prisma.quoteDelivery.groupBy({ by: ['status'], where: { createdAt: { gte: weekAgo } }, _count: { _all: true }, orderBy: { status: 'asc' } }),
    prisma.quoteDelivery.findMany({
      where: { createdAt: { gte: weekAgo }, OR: [{ status: { in: ['FAILED', 'BOUNCED'] } }, { status: 'PENDING', createdAt: { lt: stalePendingBefore } }] },
      orderBy: { createdAt: 'desc' }, take: 40,
      select: { id: true, status: true, recipientEmail: true, errorMessage: true, createdAt: true, quote: { select: { id: true, documentNumber: true, organisation: { select: { id: true, name: true } } } } },
    }),
    prisma.webhookEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { source: true, eventType: true, processingStatus: true, processingError: true, receivedAt: true, processedAt: true } }),
    prisma.webhookEvent.count({ where: { receivedAt: { gte: dayAgo }, processingStatus: 'PROCESSED' } }),
    prisma.webhookEvent.count({ where: { receivedAt: { gte: dayAgo }, processingStatus: 'FAILED' } }),
    prisma.webhookEvent.findMany({ where: { receivedAt: { gte: weekAgo }, processingStatus: 'FAILED' }, orderBy: { receivedAt: 'desc' }, take: 20, select: { id: true, source: true, eventType: true, processingError: true, receivedAt: true } }),
    checkResendProviderHealth(),
  ])
  const actor = getRequestUser(req)
  if (actor) await writeSuperadminAudit(req, actor, 'PLATFORM_OPERATIONS_VIEWED', 'PLATFORM', null, 'Viewed platform operations and delivery signals.')
  const toCounts = (rows: Array<{ status: string; _count: { _all: number } }>) => Object.fromEntries(rows.map((row) => [row.status, row._count._all]))
  res.json({
    checkedAt: now,
    uptimeSeconds: Math.floor(process.uptime()),
    database,
    emailProvider: process.env.RESEND_API_KEY ? 'CONFIGURED' : 'NOT_CONFIGURED',
    emailProviderHealth,
    sender: platformSenderEmail() ? 'CONFIGURED' : 'NOT_CONFIGURED',
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET ? 'CONFIGURED' : 'NOT_CONFIGURED',
    deliveryCounts24h: toCounts(deliveryCounts24h),
    deliveryCounts7d: toCounts(deliveryCounts7d),
    incidents: incidents.map((event) => ({ id: event.id, status: event.status, recipientEmail: event.recipientEmail, errorMessage: event.errorMessage, createdAt: event.createdAt, quote: event.quote })),
    webhook: { latest: latestWebhook, events24h: webhookCount24h, failures24h: webhookFailures24h, failures: webhookFailures },
  })
})

app.post('/api/superadmin/operations/webhooks/:id/reprocess', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  if (!actor) return res.status(401).json({ message: 'Unauthorized.' })
  const id = String(req.params.id ?? '')
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!reason) return res.status(400).json({ message: 'Provide a reason for reprocessing this webhook.' })

  const claimed = await prisma.webhookEvent.updateMany({ where: { id, source: 'resend', processingStatus: 'FAILED' }, data: { processingStatus: 'PROCESSING', processingError: null } })
  if (!claimed.count) return res.status(409).json({ message: 'This webhook is not failed or is already being processed.' })
  const event = await prisma.webhookEvent.findUnique({ where: { id } })
  if (!event) return res.status(404).json({ message: 'Webhook event not found.' })
  const result = await applyResendWebhookEvent(event.id, event.payload as ResendWebhookPayload)
  await writeSuperadminAudit(req, actor, result.ok ? 'WEBHOOK_REPROCESSED' : 'WEBHOOK_REPROCESS_FAILED', 'WEBHOOK_EVENT', event.id, result.ok ? `Reprocessed ${event.eventType} webhook.` : `Webhook reprocessing failed for ${event.eventType}.`, { reason })
  if (!result.ok) return res.status(502).json({ message: 'Webhook reprocessing failed. Review the updated error detail.' })
  return res.json({ message: 'Webhook reprocessed.' })
})

app.get('/api/superadmin/reports', requireSuperadmin, async (req, res) => {
  const requestedRange = String(req.query?.range ?? '30d')
  const range = ['7d', '30d', '90d', '365d'].includes(requestedRange) ? requestedRange : '30d'
  const days = Number(range.slice(0, -1))
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const grain = range === '365d' ? 'month' : range === '90d' ? 'week' : 'day'
  const [quoteRows, invoiceRows, paymentRows, reconciliationCount, reconciliationRows] = await Promise.all([
    prisma.$queryRaw<Array<{ bucket: Date; currency: string; count: number; amount: string }>>`
      SELECT date_trunc(${grain}, "createdAt") AS bucket, "currency", COUNT(*)::int AS count,
        COALESCE(SUM("total"), 0)::text AS amount
      FROM "Quote" WHERE "createdAt" >= ${from}
      GROUP BY 1, 2 ORDER BY 1, 2
    `,
    prisma.$queryRaw<Array<{ bucket: Date; currency: string; count: number; invoiced: string; paid: string; due: string }>>`
      SELECT date_trunc(${grain}, "createdAt") AS bucket, "currency", COUNT(*)::int AS count,
        COALESCE(SUM("total"), 0)::text AS invoiced, COALESCE(SUM("amountPaid"), 0)::text AS paid,
        COALESCE(SUM("balanceDue"), 0)::text AS due
      FROM "Invoice" WHERE "createdAt" >= ${from}
      GROUP BY 1, 2 ORDER BY 1, 2
    `,
    prisma.$queryRaw<Array<{ bucket: Date; currency: string; count: number; amount: string }>>`
      SELECT date_trunc(${grain}, "paymentDate") AS bucket, "currency", COUNT(*)::int AS count,
        COALESCE(SUM("amount"), 0)::text AS amount
      FROM "Payment" WHERE "paymentDate" >= ${from}
      GROUP BY 1, 2 ORDER BY 1, 2
    `,
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM "Invoice" i
      LEFT JOIN (SELECT "invoiceId", SUM("amount") AS paid FROM "Payment" GROUP BY "invoiceId") p ON p."invoiceId" = i."id"
      WHERE ABS(i."amountPaid" - COALESCE(p.paid, 0)) > 0.01
         OR ABS(i."balanceDue" - (i."total" - COALESCE(p.paid, 0))) > 0.01
    `,
    prisma.$queryRaw<Array<{ id: string; organisation: string; invoiceNumber: string; currency: string; invoiceTotal: string; invoicePaid: string; paymentEvents: string; balanceDue: string; updatedAt: Date }>>`
      SELECT i."id", o."name" AS organisation, i."invoiceNumber", i."currency", i."total"::text AS "invoiceTotal",
        i."amountPaid"::text AS "invoicePaid", COALESCE(p.paid, 0)::text AS "paymentEvents", i."balanceDue"::text AS "balanceDue", i."updatedAt"
      FROM "Invoice" i
      JOIN "Organisation" o ON o."id" = i."organisationId"
      LEFT JOIN (SELECT "invoiceId", SUM("amount") AS paid FROM "Payment" GROUP BY "invoiceId") p ON p."invoiceId" = i."id"
      WHERE ABS(i."amountPaid" - COALESCE(p.paid, 0)) > 0.01
         OR ABS(i."balanceDue" - (i."total" - COALESCE(p.paid, 0))) > 0.01
      ORDER BY i."updatedAt" DESC LIMIT 50
    `,
  ])

  const currencyTotals = new Map<string, { quoted: number; invoiced: number; invoicePaid: number; receivables: number; paymentsRecorded: number }>()
  const periodTotals = new Map<string, { bucket: Date; currency: string; quoteCount: number; quoted: number; invoiceCount: number; invoiced: number; paymentCount: number; paymentsRecorded: number }>()
  const currencySummary = (currency: string) => {
    const current = currencyTotals.get(currency) ?? { quoted: 0, invoiced: 0, invoicePaid: 0, receivables: 0, paymentsRecorded: 0 }
    currencyTotals.set(currency, current)
    return current
  }
  const periodSummary = (bucket: Date, currency: string) => {
    const key = `${bucket.toISOString()}|${currency}`
    const current = periodTotals.get(key) ?? { bucket, currency, quoteCount: 0, quoted: 0, invoiceCount: 0, invoiced: 0, paymentCount: 0, paymentsRecorded: 0 }
    periodTotals.set(key, current)
    return current
  }
  for (const row of quoteRows) {
    const amount = Number(row.amount)
    currencySummary(row.currency).quoted += amount
    const period = periodSummary(row.bucket, row.currency)
    period.quoteCount += row.count
    period.quoted += amount
  }
  for (const row of invoiceRows) {
    const invoiced = Number(row.invoiced)
    const paid = Number(row.paid)
    const due = Number(row.due)
    const totals = currencySummary(row.currency)
    totals.invoiced += invoiced
    totals.invoicePaid += paid
    totals.receivables += due
    const period = periodSummary(row.bucket, row.currency)
    period.invoiceCount += row.count
    period.invoiced += invoiced
  }
  for (const row of paymentRows) {
    const amount = Number(row.amount)
    currencySummary(row.currency).paymentsRecorded += amount
    const period = periodSummary(row.bucket, row.currency)
    period.paymentCount += row.count
    period.paymentsRecorded += amount
  }
  const actor = getRequestUser(req)
  if (actor) await writeSuperadminAudit(req, actor, 'PLATFORM_REPORTS_VIEWED', 'PLATFORM', null, `Viewed platform financial report for ${range}.`, { range })
  res.json({
    range,
    from,
    to: new Date(),
    bucket: grain,
    currencyTotals: [...currencyTotals.entries()].map(([currency, totals]) => ({ currency, ...totals })),
    periods: [...periodTotals.values()].sort((a, b) => a.bucket.getTime() - b.bucket.getTime() || a.currency.localeCompare(b.currency)),
    reconciliation: {
      issueCount: reconciliationCount[0]?.count ?? 0,
      invoices: reconciliationRows.map((row) => ({ ...row, invoiceTotal: Number(row.invoiceTotal), invoicePaid: Number(row.invoicePaid), paymentEvents: Number(row.paymentEvents), balanceDue: Number(row.balanceDue) })),
    },
  })
})

app.get('/api/superadmin/workspaces', requireSuperadmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)
  const search = String(req.query?.q ?? '').trim().slice(0, 120)
  const where = search ? {
    OR: [
      { name: { contains: search, mode: 'insensitive' as const } },
      { email: { contains: search, mode: 'insensitive' as const } },
      { country: { contains: search, mode: 'insensitive' as const } },
      { businessType: { contains: search, mode: 'insensitive' as const } },
      { owner: { is: { name: { contains: search, mode: 'insensitive' as const } } } },
      { owner: { is: { email: { contains: search, mode: 'insensitive' as const } } } },
    ],
  } : {}

  const [organisations, totalCount] = await Promise.all([
    prisma.organisation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        name: true,
        email: true,
        country: true,
        businessType: true,
        currency: true,
        status: true,
        createdAt: true,
        owner: { select: { id: true, name: true, email: true, createdAt: true } },
        subscription: { select: { plan: true, status: true, trialEndsAt: true, simulated: true } },
        _count: { select: { quotes: true, customers: true } },
      },
    }),
    prisma.organisation.count({ where }),
  ])

  const orgIds = organisations.map((o) => o.id)
  const quoteStats = orgIds.length > 0
    ? await prisma.quote.groupBy({ by: ['organisationId'], where: { organisationId: { in: orgIds } }, _count: true, _sum: { total: true } })
    : []

  const statsMap = new Map(quoteStats.map((s) => [s.organisationId, { count: s._count, total: Number(s._sum.total ?? 0) }]))

  res.json({
    workspaces: organisations.map((org) => ({
      id: org.id,
      name: org.name,
      email: org.email,
      country: org.country,
      businessType: org.businessType,
      currency: org.currency,
      status: org.status,
      createdAt: org.createdAt,
      owner: org.owner,
      subscription: org.subscription,
      quoteCount: statsMap.get(org.id)?.count ?? 0,
      totalQuotedValue: statsMap.get(org.id)?.total ?? 0,
      customerCount: org._count.customers,
    })),
    totalCount,
    hasMore: offset + limit < totalCount,
  })
})

app.get('/api/superadmin/workspaces/:id', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id ?? '')
  const organisation = await prisma.organisation.findUnique({
    where: { id },
    select: {
      id: true, name: true, email: true, phone: true, country: true, businessType: true, currency: true, website: true, status: true, suspendedAt: true, suspendedByEmail: true, suspensionReason: true, restoredAt: true, restoredByEmail: true, createdAt: true,
      owner: { select: { id: true, name: true, email: true, createdAt: true, mfaEnabled: true } },
      subscription: { select: { plan: true, status: true, trialEndsAt: true, simulated: true, billingInterval: true } },
      members: { select: { id: true, name: true, email: true, role: true, teamRole: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      _count: { select: { quotes: true, customers: true, jobs: true, invoices: true } },
    },
  })
  if (!organisation) return res.status(404).json({ message: 'Workspace not found.' })

  const [quoted, latestQuotes, latestJobs, latestInvoices] = await Promise.all([
    prisma.quote.aggregate({ where: { organisationId: id }, _sum: { total: true } }),
    prisma.quote.findMany({ where: { organisationId: id }, orderBy: { updatedAt: 'desc' }, take: 8, select: { id: true, documentNumber: true, status: true, currency: true, total: true, updatedAt: true, customer: { select: { name: true } }, deliveries: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, sentAt: true, deliveredAt: true, bouncedAt: true, errorMessage: true } } } }),
    prisma.job.findMany({ where: { organisationId: id }, orderBy: { updatedAt: 'desc' }, take: 6, select: { id: true, title: true, status: true, currency: true, updatedAt: true } }),
    prisma.invoice.findMany({ where: { organisationId: id }, orderBy: { updatedAt: 'desc' }, take: 6, select: { id: true, invoiceNumber: true, status: true, currency: true, total: true, amountPaid: true, balanceDue: true, updatedAt: true } }),
  ])

  res.json({
    workspace: { ...organisation, members: organisation.members, metrics: { quoteCount: organisation._count.quotes, customerCount: organisation._count.customers, jobCount: organisation._count.jobs, invoiceCount: organisation._count.invoices, totalQuotedValue: Number(quoted._sum.total ?? 0) } },
    recentQuotes: latestQuotes.map((quote) => ({ ...quote, total: Number(quote.total), delivery: quote.deliveries[0] ?? null })),
    recentJobs: latestJobs,
    recentInvoices: latestInvoices.map((invoice) => ({ ...invoice, total: Number(invoice.total), amountPaid: Number(invoice.amountPaid), balanceDue: Number(invoice.balanceDue) })),
  })
})

app.post('/api/superadmin/workspaces/:id/suspend', requireSuperadmin, async (req, res) => {
  const user = getRequestUser(req)
  const id = String(req.params.id ?? '')
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!reason || reason.length < 5) return res.status(400).json({ message: 'Enter a suspension reason (at least 5 characters).' })
  const existing = await prisma.organisation.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!existing) return res.status(404).json({ message: 'Workspace not found.' })
  if (existing.status === 'SUSPENDED') return res.status(409).json({ message: 'This workspace is already suspended.' })
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const workspace = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.organisation.update({ where: { id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedByEmail: user.email, suspensionReason: reason, restoredAt: null, restoredByEmail: null }, select: { id: true, status: true, suspendedAt: true, suspendedByEmail: true, suspensionReason: true } })
    await writeSuperadminAudit(req, user, 'WORKSPACE_SUSPENDED', 'WORKSPACE', id, `Suspended workspace ${id}.`, { reason }, transaction)
    return updated
  })
  res.json({ workspace })
})

app.post('/api/superadmin/workspaces/:id/restore', requireSuperadmin, async (req, res) => {
  const user = getRequestUser(req)
  const id = String(req.params.id ?? '')
  const existing = await prisma.organisation.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!existing) return res.status(404).json({ message: 'Workspace not found.' })
  if (existing.status !== 'SUSPENDED') return res.status(409).json({ message: 'This workspace is not suspended.' })
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const workspace = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.organisation.update({ where: { id }, data: { status: 'ACTIVE', restoredAt: new Date(), restoredByEmail: user.email }, select: { id: true, status: true, restoredAt: true, restoredByEmail: true } })
    await writeSuperadminAudit(req, user, 'WORKSPACE_RESTORED', 'WORKSPACE', id, `Restored workspace ${id}.`, undefined, transaction)
    return updated
  })
  res.json({ workspace })
})

app.get('/api/superadmin/quotes', requireSuperadmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)

  const [quotes, totalCount] = await Promise.all([
    prisma.quote.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        documentNumber: true,
        status: true,
        currency: true,
        total: true,
        createdAt: true,
        organisation: { select: { id: true, name: true } },
        customer: { select: { name: true } },
      },
    }),
    prisma.quote.count(),
  ])

  res.json({
    quotes: quotes.map((q) => ({
      id: q.id,
      documentNumber: q.documentNumber,
      status: q.status,
      currency: q.currency,
      total: Number(q.total),
      createdAt: q.createdAt,
      organisation: q.organisation,
      customer: q.customer,
    })),
    totalCount,
    hasMore: offset + limit < totalCount,
  })
})

app.get('/api/superadmin/audit', requireSuperadmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 100)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)
  const search = String(req.query?.q ?? '').trim().slice(0, 120)
  const where = search ? {
    OR: [
      { actorEmail: { contains: search, mode: 'insensitive' as const } },
      { action: { contains: search, mode: 'insensitive' as const } },
      { targetType: { contains: search, mode: 'insensitive' as const } },
      { targetId: { contains: search, mode: 'insensitive' as const } },
      { summary: { contains: search, mode: 'insensitive' as const } },
    ],
  } : {}
  const [events, totalCount] = await Promise.all([
    prisma.superadminAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset, select: { id: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, metadata: true, ipAddress: true, userAgent: true, createdAt: true } }),
    prisma.superadminAuditEvent.count({ where }),
  ])
  res.json({ events, totalCount, hasMore: offset + limit < totalCount })
})

app.get('/api/superadmin/users', requireSuperadmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 100)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)
  const search = String(req.query?.q ?? '').trim().slice(0, 120)
  const where = search ? { OR: [
    { name: { contains: search, mode: 'insensitive' as const } },
    { email: { contains: search, mode: 'insensitive' as const } },
    { role: { contains: search, mode: 'insensitive' as const } },
    { organisation: { is: { name: { contains: search, mode: 'insensitive' as const } } } },
    { ownedOrganisation: { is: { name: { contains: search, mode: 'insensitive' as const } } } },
  ] } : {}
  const [users, totalCount] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset, select: {
      id: true, name: true, email: true, role: true, mfaEnabled: true, createdAt: true,
      organisation: { select: { id: true, name: true, status: true } },
      ownedOrganisation: { select: { id: true, name: true, status: true } },
    } }),
    prisma.user.count({ where }),
  ])
  const userIds = users.map((account) => account.id)
  const counts = userIds.length ? await prisma.session.groupBy({ by: ['userId'], where: { userId: { in: userIds }, expiresAt: { gt: new Date() } }, _count: { _all: true } }) : []
  const countByUser = new Map(counts.map((row) => [row.userId, row._count._all]))
  res.json({ users: users.map(({ organisation, ownedOrganisation, ...account }) => ({ ...account, workspace: organisation ?? ownedOrganisation, activeSessionCount: countByUser.get(account.id) ?? 0 })), totalCount, hasMore: offset + limit < totalCount })
})

app.get('/api/superadmin/users/:id/sessions', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id ?? '')
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } })
  if (!target) return res.status(404).json({ message: 'User not found.' })
  const sessions = await prisma.session.findMany({ where: { userId: id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, expiresAt: true } })
  const actor = getRequestUser(req)
  if (actor) await writeSuperadminAudit(req, actor, 'USER_SESSIONS_VIEWED', 'USER', id, `Viewed active sessions for ${target.email}.`)
  res.json({ user: target, sessions })
})

app.delete('/api/superadmin/users/:userId/sessions/:sessionId', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  const userId = String(req.params.userId ?? '')
  const sessionId = String(req.params.sessionId ?? '')
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!reason || reason.length < 5) return res.status(400).json({ message: 'Enter a reason of at least 5 characters.' })
  if (!actor) return res.status(401).json({ message: 'Unauthorized' })
  if (actor.id === userId) return res.status(409).json({ message: 'Use Sign out to end your own current admin session.' })
  const targetSession = await prisma.session.findFirst({ where: { id: sessionId, userId, expiresAt: { gt: new Date() } }, select: { id: true } })
  if (!targetSession) return res.status(404).json({ message: 'Active session not found.' })
  await prisma.$transaction(async (transaction) => {
    await transaction.session.delete({ where: { id: sessionId } })
    await writeSuperadminAudit(req, actor, 'USER_SESSION_REVOKED', 'SESSION', sessionId, `Revoked an active session for user ${userId}.`, { reason, userId }, transaction)
  })
  res.json({ revoked: true })
})

app.post('/api/superadmin/users/:id/revoke-sessions', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  const id = String(req.params.id ?? '')
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!reason || reason.length < 5) return res.status(400).json({ message: 'Enter a reason of at least 5 characters.' })
  if (!actor) return res.status(401).json({ message: 'Unauthorized' })
  if (actor.id === id) return res.status(409).json({ message: 'Use Sign out to end your own current admin session.' })
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } })
  if (!target) return res.status(404).json({ message: 'User not found.' })
  const result = await prisma.$transaction(async (transaction) => {
    const removed = await transaction.session.deleteMany({ where: { userId: id, expiresAt: { gt: new Date() } } })
    if (removed.count > 0) await writeSuperadminAudit(req, actor, 'USER_SESSIONS_REVOKED', 'USER', id, `Revoked ${removed.count} active session(s) for ${target.email}.`, { reason, count: removed.count }, transaction)
    return removed
  })
  res.json({ revokedCount: result.count })
})

// Promote a user to SUPERADMIN (only a superadmin can do this)
app.post('/api/superadmin/promote', requireSuperadmin, async (req, res) => {
  const actor = getRequestUser(req)
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!email) return res.status(400).json({ message: 'Email is required.' })

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(404).json({ message: 'User not found.' })
  if (user.role === 'SUPERADMIN') return res.status(409).json({ message: 'This user is already a super-admin.' })
  if (!actor) return res.status(401).json({ message: 'Unauthorized' })

  const updated = await prisma.$transaction(async (transaction) => {
    const promoted = await transaction.user.update({ where: { id: user.id }, data: { role: 'SUPERADMIN' }, select: { id: true, name: true, email: true, role: true } })
    await writeSuperadminAudit(req, actor, 'USER_PROMOTED_TO_SUPERADMIN', 'USER', user.id, `Promoted ${user.email} to super-admin.`, undefined, transaction)
    return promoted
  })
  res.json({ user: updated })
})

// ---- Resend webhook handler ----
// Public endpoint (no auth) — verifies Svix signature and processes delivery events.
type ResendWebhookPayload = { type?: string; data?: { email_id?: string; event_id?: string; created_at?: string } }

async function applyResendWebhookEvent(webhookEventId: string, payload: ResendWebhookPayload) {
  try {
    const emailId = payload.data?.email_id
    if (emailId) {
      const delivery = await prisma.quoteDelivery.findFirst({ where: { providerMessageId: emailId } })
      if (delivery) {
        const now = new Date()
        switch (payload.type) {
          case 'email.sent':
            if (delivery.status === 'PENDING') await prisma.quoteDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT', sentAt: delivery.sentAt ?? now } })
            break
          case 'email.delivered':
            await prisma.quoteDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED', deliveredAt: now } })
            break
          case 'email.bounced':
            await prisma.quoteDelivery.update({ where: { id: delivery.id }, data: { status: 'BOUNCED', bouncedAt: now, errorMessage: 'Email bounced.' } })
            break
          case 'email.complained':
          default:
            break
        }
      }
    }
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'PROCESSED', processingError: null, processedAt: new Date() } })
    return { ok: true as const }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed.'
    await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processingStatus: 'FAILED', processingError: message.slice(0, 1000) } }).catch(() => {})
    console.error(`[webhook] Event ${webhookEventId} processing failed.`)
    return { ok: false as const }
  }
}

app.post('/api/webhooks/resend', async (req, res) => {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[webhook] RESEND_WEBHOOK_SECRET is not configured.')
    return res.status(503).json({ message: 'Webhook verification is not configured.' })
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody
  if (!rawBody) {
    return res.status(400).json({ message: 'Missing request body.' })
  }

  // Svix signature headers (Resend uses Svix under the hood)
  const svixSignature = req.headers['svix-signature'] as string | undefined
  const svixTimestamp = req.headers['svix-timestamp'] as string | undefined
  const svixMsgId = req.headers['svix-msg-id'] as string | undefined

  if (!svixSignature || !svixTimestamp || !svixMsgId) {
    return res.status(401).json({ message: 'Missing Svix signature headers.' })
  }

  // Verify the signature
  // Format: signed_content = `${msg_id}.${timestamp}.${raw_body}`
  // Then compare each signature in the header (space-separated, prefixed with "v1,")
  const signedContent = `${svixMsgId}.${svixTimestamp}.${rawBody.toString()}`
  const expectedSignature = createHmac('sha256', webhookSecret).update(signedContent).digest('base64')

  const signatures = svixSignature.split(' ').map((sig) => {
    const parts = sig.split(',')
    return parts.length === 2 && parts[0] === 'v1' ? parts[1] : null
  }).filter((sig): sig is string => sig !== null)

  const signatureMatches = signatures.some((sig) => {
    try {
      // Use timing-safe comparison
      const a = Buffer.from(sig)
      const b = Buffer.from(expectedSignature)
      if (a.length !== b.length) return false
      return createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex')
    } catch {
      return false
    }
  })

  if (!signatureMatches) {
    return res.status(401).json({ message: 'Invalid webhook signature.' })
  }

  // Check timestamp freshness (prevent replay — 5 minute window)
  const timestampMs = Number(svixTimestamp) * 1000
  if (Number.isNaN(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return res.status(401).json({ message: 'Webhook timestamp is stale.' })
  }

  const payload = req.body as { type?: string; data?: { email_id?: string; event_id?: string; created_at?: string } }

  if (!payload || !payload.type) {
    return res.status(400).json({ message: 'Invalid webhook payload.' })
  }

  const eventType = payload.type
  const eventId = svixMsgId // Svix msg-id is the unique event identifier

  // Treat already-processed events as duplicates, but allow Resend to retry a failed event.
  let webhookEvent = await prisma.webhookEvent.findUnique({ where: { eventId } })
  if (webhookEvent?.processingStatus === 'PROCESSED') return res.status(200).json({ message: 'Event already processed.' })
  if (webhookEvent) {
    if (webhookEvent.processingStatus !== 'FAILED') return res.status(202).json({ message: 'Event processing is already in progress.' })
    const claimed = await prisma.webhookEvent.updateMany({ where: { id: webhookEvent.id, processingStatus: 'FAILED' }, data: { processingStatus: 'PROCESSING', processingError: null } })
    if (claimed.count === 0) return res.status(202).json({ message: 'Event processing is already in progress.' })
    webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: webhookEvent.id } })
  } else {
    try {
      webhookEvent = await prisma.webhookEvent.create({
        data: { source: 'resend', eventId, eventType, payload: payload as object, processingStatus: 'PROCESSING' },
      })
    } catch {
      // A concurrent request may have created the event; let the provider retry if it failed.
      const concurrent = await prisma.webhookEvent.findUnique({ where: { eventId } })
      if (!concurrent || concurrent.processingStatus === 'PROCESSED') return res.status(200).json({ message: 'Event already processed.' })
      if (concurrent.processingStatus !== 'FAILED') return res.status(202).json({ message: 'Event processing is already in progress.' })
      const claimed = await prisma.webhookEvent.updateMany({ where: { id: concurrent.id, processingStatus: 'FAILED' }, data: { processingStatus: 'PROCESSING', processingError: null } })
      if (claimed.count === 0) return res.status(202).json({ message: 'Event processing is already in progress.' })
      webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: concurrent.id } })
    }
  }
  const result = await applyResendWebhookEvent(webhookEvent.id, payload)
  if (!result.ok) return res.status(500).json({ message: 'Webhook processing failed; retry is safe.' })
  return res.status(200).json({ message: 'Event processed.' })
})

// ---- Stage 14: Jobs ----

const VALID_JOB_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'CANCELLED']
const VALID_COST_CATEGORIES = ['MATERIALS', 'LABOR', 'SUPPLIER', 'TRANSPORT', 'OTHER']
const VALID_JOB_STATUS_TRANSITIONS: Record<string, string[]> = {
  PLANNED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['PLANNED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  CANCELLED: ['PLANNED'],
}
const VALID_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CARD', 'OTHER']
const VALID_INVOICE_STATUSES = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']
const PUBLIC_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']

function serializePublicInvoice(invoice: any) {
  if (!invoice || !PUBLIC_INVOICE_STATUSES.includes(invoice.status)) return null
  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
  return {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    currency: invoice.currency,
    subtotal: Number(invoice.subtotal),
    taxTotal: Number(invoice.taxTotal),
    total: Number(invoice.total),
    amountPaid: Number(invoice.amountPaid),
    balanceDue: Number(invoice.balanceDue),
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lineItems: lines.map((line: any) => ({ description: String(line.description ?? ''), quantity: Number(line.quantity ?? 0), unit: String(line.unit ?? 'unit'), unitPrice: Number(line.unitPrice ?? 0), taxRate: line.taxRate === null || line.taxRate === undefined ? null : Number(line.taxRate) })),
  }
}

app.get('/api/public/jobs/:token', publicRateLimit, async (req, res) => {
  const token = String(req.params.token ?? '')
  if (token.length < 32 || token.length > 128) return res.status(404).json({ message: 'Progress page not found.' })
  const job = await prisma.job.findUnique({
    where: { progressTokenHash: hashToken(token) },
    select: {
      title: true, status: true, updatedAt: true,
      organisation: { select: { name: true } },
      milestones: { where: { customerVisible: true }, orderBy: { position: 'asc' }, select: { id: true, title: true, dueDate: true, completedAt: true } },
      quote: { select: { id: true, documentNumber: true, status: true, publicToken: true } },
      invoices: { where: { status: { in: PUBLIC_INVOICE_STATUSES as never[] } }, orderBy: { updatedAt: 'desc' }, take: 1, select: { invoiceNumber: true, status: true, currency: true, subtotal: true, taxTotal: true, total: true, amountPaid: true, balanceDue: true, issueDate: true, dueDate: true, lineItems: true } },
    },
  })
  if (!job) return res.status(404).json({ message: 'Progress page not found.' })
  return res.json({ job: { ...job, quote: job.quote ? { documentNumber: job.quote.documentNumber } : null, quoteStatus: job.quote?.status ?? null, conversationAvailable: Boolean(job.quote), invoice: serializePublicInvoice(job.invoices[0]) } })
})

app.get('/api/public/jobs/:token/messages', publicRateLimit, async (req, res) => {
  const token = String(req.params.token ?? '')
  if (token.length < 32 || token.length > 128) return res.status(404).json({ message: 'Conversation is not available.' })
  const job = await prisma.job.findUnique({ where: { progressTokenHash: hashToken(token) }, select: { quoteId: true } })
  if (!job?.quoteId) return res.status(404).json({ message: 'Conversation is not available.' })
  const messages = await prisma.quoteMessage.findMany({ where: { quoteId: job.quoteId }, orderBy: { createdAt: 'asc' }, take: 100 })
  return res.json({ messages })
})

app.post('/api/public/jobs/:token/messages', publicRateLimit, async (req, res) => {
  const token = String(req.params.token ?? '')
  if (token.length < 32 || token.length > 128) return res.status(404).json({ message: 'Conversation is not available.' })
  const content = String(req.body?.content ?? '').trim()
  if (!content || content.length > 4000) return res.status(400).json({ message: 'Write a message up to 4,000 characters.' })
  const job = await prisma.job.findUnique({ where: { progressTokenHash: hashToken(token) }, select: { quoteId: true, organisationId: true, customer: { select: { name: true } } } })
  if (!job?.quoteId) return res.status(404).json({ message: 'Conversation is not available.' })
  const quote = await prisma.quote.findFirst({ where: { id: job.quoteId, organisationId: job.organisationId }, select: { id: true, ownerId: true, status: true } })
  if (!quote) return res.status(404).json({ message: 'Conversation is not available.' })
  if (quote.status === 'EXPIRED') return res.status(409).json({ message: 'This conversation is read-only because the quote has expired.' })
  const created = await prisma.$transaction(async (tx) => {
    const message = await tx.quoteMessage.create({ data: { quoteId: quote.id, organisationId: job.organisationId, authorType: 'CUSTOMER', authorName: job.customer.name, content } })
    await tx.notification.create({ data: { recipientUserId: quote.ownerId, organisationId: job.organisationId, quoteId: quote.id, quoteMessageId: message.id, type: 'QUOTE_MESSAGE', title: 'New project message', body: `${job.customer.name} sent a message about the project.`, sourceKey: `quote-message:${message.id}` } })
    return message
  })
  return res.status(201).json({ message: created })
})

function serializeJob(job: any) {
  return {
    ...job,
    costs: Array.isArray(job.costs) ? job.costs.map((c: any) => ({ ...c, amount: Number(c.amount) })) : job.costs,
  }
}

async function recordJobActivity(jobId: string, actor: { id: string; name: string }, action: string, details?: Record<string, unknown>, db: PrismaTypes.TransactionClient | typeof prisma = prisma) {
  await db.jobActivity.create({
    data: {
      jobId,
      actorId: actor.id,
      actorName: actor.name,
      action,
      ...(details ? { details: details as PrismaTypes.InputJsonValue } : {}),
    },
  })
}

app.post('/api/jobs', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const title = String(req.body?.title ?? '').trim()
  const customerId = String(req.body?.customerId ?? '').trim()
  const description = String(req.body?.description ?? '').trim() || null
  const quoteId = String(req.body?.quoteId ?? '').trim() || null
  const status = String(req.body?.status ?? 'PLANNED').toUpperCase()
  const requestedOwnerId = String(req.body?.ownerId ?? user.id)
  const startDate = req.body?.startDate ? new Date(req.body.startDate) : null
  const endDate = req.body?.endDate ? new Date(req.body.endDate) : null

  if (!title) return res.status(400).json({ message: 'Job title is required.' })
  if (!VALID_JOB_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid job status.' })
  const assignedOwner = await prisma.user.findFirst({ where: { id: requestedOwnerId, organisationId }, select: { id: true, name: true } })
  if (!assignedOwner) return res.status(400).json({ message: 'Choose a job owner from your workspace team.' })
  if (requestedOwnerId !== user.id && !['OWNER', 'ADMIN'].includes(user.teamRole ?? '')) return res.status(403).json({ message: 'Only workspace owners and admins can assign jobs to another team member.' })

  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!customer) return res.status(400).json({ message: 'Choose a valid customer for this job.' })

  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { currency: true } })
  const currency = organisation?.currency ?? 'KES'

  let acceptedQuoteSnapshot: unknown = null
  let validatedQuoteId: string | null = null
  let acceptedQuoteCurrency = currency

  if (!quoteId) return res.status(400).json({ message: 'Select an approved quote to create a job.' })
  if (quoteId) {
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
      include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { id: true, name: true } } },
    })
    if (!quote) return res.status(404).json({ message: 'Quote not found.' })
    if (quote.status !== 'APPROVED') return res.status(409).json({ message: 'Only approved quotes can be converted to jobs.' })
    if (quote.customerId !== customerId) return res.status(400).json({ message: 'The job customer must match the customer on the accepted quote.' })
    const existingJob = await prisma.job.findFirst({ where: { organisationId, quoteId: quote.id }, select: { id: true, title: true } })
    if (existingJob) return res.status(409).json({ message: `Quote ${quote.documentNumber} already has a job (${existingJob.title}). Open that job to continue tracking it.` })
    const existingQuoteInvoice = await prisma.invoice.findUnique({ where: { sourceQuoteId: quote.id }, select: { jobId: true, invoiceNumber: true } })
    if (existingQuoteInvoice?.jobId) return res.status(409).json({ message: `Invoice ${existingQuoteInvoice.invoiceNumber} is already linked to a job. Open that job instead of creating another.` })

    // Build immutable snapshot
    acceptedQuoteSnapshot = {
      id: quote.id,
      documentNumber: quote.documentNumber,
      currency: quote.currency,
      subtotal: Number(quote.subtotal),
      taxTotal: Number(quote.taxTotal),
      total: Number(quote.total),
      notes: quote.notes,
      terms: quote.terms,
      lines: quote.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit,
        unitPrice: Number(l.unitPrice),
        taxRate: l.taxRate === null ? null : Number(l.taxRate),
      })),
      customerName: quote.customer.name,
      snapshotTakenAt: new Date().toISOString(),
    }
    validatedQuoteId = quoteId
    acceptedQuoteCurrency = quote.currency
  }

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        organisationId,
        quoteId: validatedQuoteId,
        ownerId: requestedOwnerId,
        customerId,
        title,
        description,
        status: status as never,
        currency: acceptedQuoteCurrency,
        startDate: startDate && !Number.isNaN(startDate.getTime()) ? startDate : null,
        endDate: endDate && !Number.isNaN(endDate.getTime()) ? endDate : null,
        acceptedQuoteSnapshot: acceptedQuoteSnapshot as never,
      },
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        owner: { select: { id: true, name: true, email: true } },
        milestones: { orderBy: { position: 'asc' } },
        quote: { select: { id: true, documentNumber: true, status: true } },
        invoices: { select: { id: true, invoiceNumber: true, status: true, sourceQuoteId: true } },
      },
    })
    await tx.invoice.updateMany({ where: { organisationId, sourceQuoteId: validatedQuoteId }, data: { jobId: created.id } })
    await recordJobActivity(created.id, user, 'JOB_CREATED', { title, status, quoteId: validatedQuoteId, ownerId: requestedOwnerId, ownerName: assignedOwner.name }, tx)
    return tx.job.findUniqueOrThrow({ where: { id: created.id }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, owner: { select: { id: true, name: true, email: true } }, milestones: { orderBy: { position: 'asc' } }, quote: { select: { id: true, documentNumber: true, status: true } }, invoices: { select: { id: true, invoiceNumber: true, status: true, sourceQuoteId: true } } } })
  })

  const activities = await prisma.jobActivity.findMany({ where: { jobId: job.id }, orderBy: { createdAt: 'desc' }, take: 100 })
  const { progressTokenHash: _progressTokenHash, ...safeJob } = job
  res.status(201).json({ job: { ...safeJob, progressEnabled: false, activities } })
})

app.get('/api/jobs', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const statusFilter = req.query?.status ? String(req.query.status).toUpperCase().split(',') : undefined
  const customerFilter = req.query?.customerId ? String(req.query.customerId) : undefined
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)

  const where: Record<string, unknown> = { organisationId }
  if (statusFilter && statusFilter.every((s) => VALID_JOB_STATUSES.includes(s))) where.status = { in: statusFilter }
  if (customerFilter) where.customerId = customerFilter

  const [jobs, totalCount] = await Promise.all([
    prisma.job.findMany({
      where: where as never,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, name: true, email: true } }, quote: { select: { id: true, documentNumber: true, status: true } }, invoices: { select: { id: true, invoiceNumber: true, status: true, sourceQuoteId: true } } },
    }),
    prisma.job.count({ where: where as never }),
  ])

  res.json({ jobs: jobs.map(({ progressTokenHash, ...job }) => ({ ...job, progressEnabled: Boolean(progressTokenHash) })), totalCount, hasMore: offset + limit < totalCount })
})

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({
    where: { id: String(req.params.id ?? ''), organisationId },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      owner: { select: { id: true, name: true, email: true } },
      milestones: { orderBy: { position: 'asc' } },
      costs: { orderBy: { incurredAt: 'desc' } },
      activities: { orderBy: { createdAt: 'desc' }, take: 100 },
      attachments: { orderBy: { createdAt: 'desc' }, select: { id: true, originalFilename: true, mimeType: true, sizeBytes: true, uploadedBy: true, uploaderName: true, createdAt: true } },
      quote: { select: { id: true, documentNumber: true, status: true, publicToken: true } },
      invoices: { select: { id: true, invoiceNumber: true, status: true, sourceQuoteId: true } },
    },
  })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const { progressTokenHash, ...safeJob } = job
  res.json({
    job: {
      ...safeJob,
      progressEnabled: Boolean(progressTokenHash),
      costs: job.costs.map((c) => ({ ...c, amount: Number(c.amount) })),
    },
  })
})

app.post('/api/jobs/:id/progress-link', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true, milestones: { where: { customerVisible: true }, select: { id: true } } } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })
  const token = randomBytes(32).toString('base64url')
  await prisma.$transaction(async (tx) => {
    await tx.job.update({ where: { id: job.id }, data: { progressTokenHash: hashToken(token), progressEnabledAt: new Date() } })
    await recordJobActivity(job.id, user, 'JOB_PROGRESS_LINK_CREATED', { visibleMilestoneCount: job.milestones.length }, tx)
  })
  const requestOrigin = req.headers.origin && isOriginAllowed(req.headers.origin) ? req.headers.origin : null
  const platformUrl = (process.env.PLATFORM_URL || requestOrigin || 'http://localhost:5174').replace(/\/$/, '')
  return res.json({ progressUrl: `${platformUrl}/job-progress/${token}` })
})

app.delete('/api/jobs/:id/progress-link', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true, progressTokenHash: true } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })
  if (job.progressTokenHash) {
    await prisma.$transaction(async (tx) => {
      await tx.job.update({ where: { id: job.id }, data: { progressTokenHash: null, progressEnabledAt: null } })
      await recordJobActivity(job.id, user, 'JOB_PROGRESS_LINK_REVOKED', undefined, tx)
    })
  }
  return res.json({ success: true })
})

const JOB_ATTACHMENT_TYPES: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
const MAX_JOB_ATTACHMENT_SIZE = 6 * 1024 * 1024

app.post('/api/jobs/:id/attachments', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const mimeType = String(req.body?.mimeType ?? '').toLowerCase()
  const extension = JOB_ATTACHMENT_TYPES[mimeType]
  const encoded = String(req.body?.contentBase64 ?? '')
  if (!extension || !encoded || encoded.length > Math.ceil(MAX_JOB_ATTACHMENT_SIZE * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return res.status(400).json({ message: 'Attach a PDF, PNG, JPEG, or WebP file no larger than 6 MB.' })
  }
  const buffer = Buffer.from(encoded, 'base64')
  if (!buffer.length || buffer.length > MAX_JOB_ATTACHMENT_SIZE) return res.status(413).json({ message: 'Job attachments are limited to 6 MB.' })
  const validContent = mimeType === 'application/pdf'
    ? buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    : detectImageType(buffer)?.mime === mimeType
  if (!validContent) return res.status(400).json({ message: 'File content does not match its supported type.' })

  const originalFilename = String(req.body?.filename ?? 'attachment').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 160) || 'attachment'
  const storageKey = `${randomBytes(24).toString('hex')}${extension}`
  const attachmentDirectory = join(uploadsDir, 'job-attachments')
  const storagePath = join(attachmentDirectory, storageKey)
  try {
    await mkdir(attachmentDirectory, { recursive: true })
    await writeFile(storagePath, buffer, { flag: 'wx' })
    const attachment = await prisma.$transaction(async (tx) => {
      const attachment = await tx.jobAttachment.create({ data: { jobId: job.id, storageKey, originalFilename, mimeType, sizeBytes: buffer.length, uploadedBy: user.id, uploaderName: user.name } })
      await recordJobActivity(job.id, user, 'JOB_ATTACHMENT_ADDED', { attachmentId: attachment.id, filename: originalFilename, mimeType, sizeBytes: buffer.length }, tx)
      return attachment
    })
    return res.status(201).json({ attachment: { id: attachment.id, originalFilename: attachment.originalFilename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, uploadedBy: attachment.uploadedBy, uploaderName: attachment.uploaderName, createdAt: attachment.createdAt } })
  } catch {
    await unlink(storagePath).catch(() => {})
    return res.status(500).json({ message: 'Could not save the job attachment.' })
  }
})

app.get('/api/jobs/:id/attachments/:attachmentId', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const attachment = await prisma.jobAttachment.findFirst({ where: { id: String(req.params.attachmentId ?? ''), jobId: String(req.params.id ?? ''), job: { organisationId } } })
  if (!attachment) return res.status(404).json({ message: 'Attachment not found.' })
  const storagePath = join(uploadsDir, 'job-attachments', attachment.storageKey)
  return res.download(storagePath, attachment.originalFilename, (error) => {
    if (error && !res.headersSent) res.status(404).json({ message: 'Attachment file is unavailable.' })
  })
})

app.get('/api/jobs/:id/activity', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })
  const activities = await prisma.jobActivity.findMany({ where: { jobId: job.id }, orderBy: { createdAt: 'desc' }, take: 100 })
  res.json({ activities })
})

app.put('/api/jobs/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined
  const description = req.body?.description !== undefined ? (String(req.body.description).trim() || null) : undefined
  const status = req.body?.status !== undefined ? String(req.body.status).toUpperCase() : undefined
  const startDate = req.body?.startDate !== undefined ? (req.body.startDate ? new Date(req.body.startDate) : null) : undefined
  const endDate = req.body?.endDate !== undefined ? (req.body.endDate ? new Date(req.body.endDate) : null) : undefined
  const requestedOwnerId = req.body?.ownerId !== undefined ? String(req.body.ownerId) : undefined
  const requestedQuoteId = req.body?.quoteId !== undefined ? String(req.body.quoteId).trim() : undefined
  let requestedOwnerName: string | undefined

  if (status && !VALID_JOB_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid job status.' })
  if (title !== undefined && !title) return res.status(400).json({ message: 'Title cannot be empty.' })
  if (status && status !== job.status && !VALID_JOB_STATUS_TRANSITIONS[job.status]?.includes(status)) {
    return res.status(409).json({ message: `A job cannot move from ${job.status.toLowerCase().replaceAll('_', ' ')} to ${status.toLowerCase().replaceAll('_', ' ')}.` })
  }
  if (status && status !== job.status && ['COMPLETED', 'CANCELLED'].includes(job.status) && !['OWNER', 'ADMIN'].includes(user.teamRole ?? '')) {
    return res.status(403).json({ message: 'Only workspace owners and admins can reopen a completed or cancelled job.' })
  }
  if (requestedOwnerId !== undefined) {
    if (!['OWNER', 'ADMIN'].includes(user.teamRole ?? '')) return res.status(403).json({ message: 'Only workspace owners and admins can reassign jobs.' })
    const assignee = await prisma.user.findFirst({ where: { id: requestedOwnerId, organisationId }, select: { id: true, name: true } })
    if (!assignee) return res.status(400).json({ message: 'Choose a job owner from your workspace team.' })
    requestedOwnerName = assignee.name
  }

  let acceptedQuoteSnapshot: Record<string, unknown> | undefined
  let linkedQuoteId: string | undefined
  let linkedQuoteCurrency: string | undefined
  if (requestedQuoteId !== undefined) {
    if (!['OWNER', 'ADMIN'].includes(user.teamRole ?? '')) return res.status(403).json({ message: 'Only workspace owners and admins can link an accepted quote to a job.' })
    if (!requestedQuoteId) return res.status(400).json({ message: 'Choose an approved quote.' })
    if (job.quoteId && job.quoteId !== requestedQuoteId) return res.status(409).json({ message: 'This job is already linked to an accepted quote.' })
    const quote = await prisma.quote.findFirst({ where: { id: requestedQuoteId, organisationId }, include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { name: true } } } })
    if (!quote) return res.status(404).json({ message: 'Quote not found.' })
    if (quote.status !== 'APPROVED') return res.status(409).json({ message: 'Only approved quotes can be linked to a job.' })
    if (quote.customerId !== job.customerId) return res.status(400).json({ message: 'The job customer must match the customer on the accepted quote.' })
    const existingJob = await prisma.job.findFirst({ where: { organisationId, quoteId: quote.id, id: { not: job.id } }, select: { id: true, title: true } })
    if (existingJob) return res.status(409).json({ message: `Quote ${quote.documentNumber} is already linked to job ${existingJob.title}.` })
    const legacyInvoice = await prisma.invoice.findFirst({ where: { organisationId, jobId: job.id, sourceQuoteId: null }, select: { invoiceNumber: true } })
    if (legacyInvoice) return res.status(409).json({ message: `Job invoice ${legacyInvoice.invoiceNumber} was created outside the quote flow. Review and reconcile it before linking a quote.` })
    const quoteInvoice = await prisma.invoice.findUnique({ where: { sourceQuoteId: quote.id }, select: { jobId: true, invoiceNumber: true } })
    if (quoteInvoice?.jobId && quoteInvoice.jobId !== job.id) return res.status(409).json({ message: `Invoice ${quoteInvoice.invoiceNumber} is already linked to another job.` })
    acceptedQuoteSnapshot = {
      id: quote.id,
      documentNumber: quote.documentNumber,
      currency: quote.currency,
      subtotal: Number(quote.subtotal),
      taxTotal: Number(quote.taxTotal),
      total: Number(quote.total),
      notes: quote.notes,
      terms: quote.terms,
      lines: quote.lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unit: line.unit, unitPrice: Number(line.unitPrice), taxRate: line.taxRate === null ? null : Number(line.taxRate) })),
      customerName: quote.customer.name,
      snapshotTakenAt: new Date().toISOString(),
    }
    linkedQuoteId = quote.id
    linkedQuoteCurrency = quote.currency
  }

  const data: Record<string, unknown> = {}
  if (title !== undefined) data.title = title
  if (description !== undefined) data.description = description
  if (requestedOwnerId !== undefined) data.ownerId = requestedOwnerId
  if (status !== undefined) data.status = status
  if (startDate !== undefined) data.startDate = startDate && !Number.isNaN(startDate.getTime()) ? startDate : null
  if (endDate !== undefined) data.endDate = endDate && !Number.isNaN(endDate.getTime()) ? endDate : null
  if (linkedQuoteId && acceptedQuoteSnapshot) {
    data.quoteId = linkedQuoteId
    data.acceptedQuoteSnapshot = acceptedQuoteSnapshot as never
    if (linkedQuoteCurrency) data.currency = linkedQuoteCurrency
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.update({
      where: { id: job.id },
      data: data as never,
      include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, name: true, email: true } }, quote: { select: { id: true, documentNumber: true, status: true, publicToken: true } }, invoices: { select: { id: true, invoiceNumber: true, status: true, sourceQuoteId: true } } },
    })
    if (linkedQuoteId) await tx.invoice.updateMany({ where: { organisationId, sourceQuoteId: linkedQuoteId }, data: { jobId: job.id } })
    await recordJobActivity(job.id, user, status && status !== job.status ? 'JOB_STATUS_CHANGED' : linkedQuoteId ? 'JOB_QUOTE_LINKED' : 'JOB_UPDATED', {
      fields: Object.keys(data),
      ...(linkedQuoteId ? { quoteId: linkedQuoteId } : {}),
      ...(requestedOwnerId && requestedOwnerId !== job.ownerId ? { fromOwnerId: job.ownerId, toOwnerId: requestedOwnerId, toOwnerName: requestedOwnerName } : {}),
      ...(status && status !== job.status ? { fromStatus: job.status, toStatus: status } : {}),
    }, tx)
    return updated
  })
  const activities = await prisma.jobActivity.findMany({ where: { jobId: job.id }, orderBy: { createdAt: 'desc' }, take: 100 })
  const { progressTokenHash: _progressTokenHash, ...safeJob } = updated
  res.json({ job: { ...safeJob, progressEnabled: Boolean(updated.progressTokenHash), activities } })
})

app.post('/api/jobs/:id/milestones', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const title = String(req.body?.title ?? '').trim()
  const description = String(req.body?.description ?? '').trim() || null
  const dueDate = req.body?.dueDate ? new Date(req.body.dueDate) : null
  const position = Number(req.body?.position ?? 0)

  if (!title) return res.status(400).json({ message: 'Milestone title is required.' })

  const milestone = await prisma.$transaction(async (tx) => {
    const milestone = await tx.jobMilestone.create({
      data: {
        jobId: job.id,
        title,
        description,
        dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
        position,
      },
    })
    await recordJobActivity(job.id, user, 'JOB_MILESTONE_ADDED', { milestoneId: milestone.id, title: milestone.title }, tx)
    return milestone
  })
  res.status(201).json({ milestone })
})

app.put('/api/jobs/:id/milestones/:milestoneId', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const milestone = await prisma.jobMilestone.findFirst({ where: { id: String(req.params.milestoneId ?? ''), jobId: job.id } })
  if (!milestone) return res.status(404).json({ message: 'Milestone not found.' })

  const data: Record<string, unknown> = {}
  if (req.body?.title !== undefined) data.title = String(req.body.title).trim()
  if (req.body?.description !== undefined) data.description = String(req.body.description).trim() || null
  if (req.body?.dueDate !== undefined) {
    const d = req.body.dueDate ? new Date(req.body.dueDate) : null
    data.dueDate = d && !Number.isNaN(d.getTime()) ? d : null
  }
  if (req.body?.completedAt !== undefined) {
    const completedAt = req.body.completedAt ? new Date(req.body.completedAt) : null
    data.completedAt = completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null
  } else if (req.body?.completed !== undefined) data.completedAt = req.body.completed ? new Date() : null
  if (req.body?.customerVisible !== undefined) data.customerVisible = Boolean(req.body.customerVisible)
  if (req.body?.position !== undefined) data.position = Number(req.body.position)

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.jobMilestone.update({ where: { id: milestone.id }, data: data as never })
    await recordJobActivity(job.id, user, 'JOB_MILESTONE_UPDATED', { milestoneId: milestone.id, title: updated.title, completedAt: updated.completedAt?.toISOString() ?? null, customerVisible: updated.customerVisible }, tx)
    return updated
  })
  res.json({ milestone: updated })
})

app.delete('/api/jobs/:id/milestones/:milestoneId', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const milestoneId = String(req.params.milestoneId ?? '')
  const milestone = await prisma.jobMilestone.findFirst({ where: { id: milestoneId, jobId: job.id } })
  if (!milestone) return res.status(404).json({ message: 'Milestone not found.' })
  const deleted = await prisma.$transaction(async (tx) => {
    const deleted = await tx.jobMilestone.deleteMany({ where: { id: milestoneId, jobId: job.id } })
    if (deleted.count) await recordJobActivity(job.id, user, 'JOB_MILESTONE_REMOVED', { milestoneId, title: milestone.title }, tx)
    return deleted
  })
  if (!deleted.count) return res.status(404).json({ message: 'Milestone not found.' })
  res.json({ success: true })
})

app.post('/api/jobs/:id/costs', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const category = String(req.body?.category ?? '').toUpperCase()
  const description = String(req.body?.description ?? '').trim()
  const amount = Number(req.body?.amount ?? 0)
  const currency = String(req.body?.currency ?? job.currency).toUpperCase()
  const incurredAt = req.body?.incurredAt ? new Date(req.body.incurredAt) : new Date()

  if (!VALID_COST_CATEGORIES.includes(category)) return res.status(400).json({ message: 'Invalid cost category.' })
  if (!description) return res.status(400).json({ message: 'Cost description is required.' })
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Amount must be a positive number.' })
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ message: 'Currency must be a 3-letter code.' })

  const cost = await prisma.$transaction(async (tx) => {
    const cost = await tx.jobCost.create({
      data: {
        jobId: job.id,
        category,
        description,
        amount,
        currency,
        incurredBy: user.id,
        incurredAt: incurredAt && !Number.isNaN(incurredAt.getTime()) ? incurredAt : new Date(),
      },
    })
    await recordJobActivity(job.id, user, 'JOB_COST_RECORDED', { costId: cost.id, category, amount, currency, description }, tx)
    return cost
  })
  res.status(201).json({ cost: { ...cost, amount: Number(cost.amount) } })
})

app.get('/api/jobs/:id/costs', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const costs = await prisma.jobCost.findMany({
    where: { jobId: job.id },
    orderBy: { incurredAt: 'desc' },
  })
  res.json({ costs: costs.map((c) => ({ ...c, amount: Number(c.amount) })) })
})

// ---- Stage 14: Invoices ----

async function generateInvoiceNumber(organisationId: string, prefix: string): Promise<string> {
  const year = new Date().getFullYear()
  // Count existing invoices for this org to build a sequential number
  const count = await prisma.invoice.count({ where: { organisationId } })
  return `${prefix || 'INV'}-${year}-${String(count + 1).padStart(4, '0')}`
}

app.post('/api/invoices', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const quoteId = String(req.body?.quoteId ?? '').trim()
  const dueDate = req.body?.dueDate ? new Date(req.body.dueDate) : null
  const depositRequired = req.body?.depositRequired !== undefined && req.body?.depositRequired !== null ? Number(req.body.depositRequired) : null
  const notesInput = String(req.body?.notes ?? '').trim()
  if (!quoteId) return res.status(400).json({ message: 'Invoices must be created from an approved quote.' })
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, organisationId }, include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { id: true } } } })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })
  if (quote.status !== 'APPROVED') return res.status(409).json({ message: 'Only customer-approved quotes can be converted to invoices.' })
  const existing = await prisma.invoice.findUnique({ where: { sourceQuoteId: quote.id }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
  if (existing) return res.json({ invoice: { ...existing, subtotal: Number(existing.subtotal), taxTotal: Number(existing.taxTotal), total: Number(existing.total), amountPaid: Number(existing.amountPaid), balanceDue: Number(existing.balanceDue), depositRequired: existing.depositRequired ? Number(existing.depositRequired) : null, depositPaid: Number(existing.depositPaid) }, alreadyConverted: true })
  const job = await prisma.job.findFirst({ where: { organisationId, quoteId: quote.id }, orderBy: { updatedAt: 'desc' }, select: { id: true } })
  if (job) {
    const legacyInvoice = await prisma.invoice.findFirst({ where: { organisationId, jobId: job.id, sourceQuoteId: null }, select: { invoiceNumber: true } })
    if (legacyInvoice) return res.status(409).json({ message: `This job already has invoice ${legacyInvoice.invoiceNumber}, which was created outside the quote conversion flow. Review it before creating another invoice.` })
  }
  const subtotal = Number(quote.subtotal)
  const taxTotal = Number(quote.taxTotal)
  const total = Number(quote.total)
  if (![subtotal, taxTotal, total].every(Number.isFinite) || subtotal < 0 || taxTotal < 0 || Math.abs(roundMoney(subtotal + taxTotal) - roundMoney(total)) > 0.01) return res.status(409).json({ message: 'The accepted quote totals need review before invoicing.' })
  if (depositRequired !== null) {
    if (!Number.isFinite(depositRequired) || depositRequired < 0) return res.status(400).json({ message: 'Deposit required must be a non-negative number.' })
    if (depositRequired > total) return res.status(400).json({ message: 'Deposit required cannot exceed the invoice total.' })
  }
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { quotePrefix: true } })
  const trialInvoiceBlock = await trialLimitReached(organisationId, 'invoices')
  if (trialInvoiceBlock) return res.status(403).json({ message: trialInvoiceBlock, code: PLAN_LIMIT_CODE })
  const invoiceNumber = await generateInvoiceNumber(organisationId, org?.quotePrefix ?? 'INV')
  try {
    const invoice = await prisma.invoice.create({
      data: {
        organisationId, jobId: job?.id ?? null, sourceQuoteId: quote.id, customerId: quote.customerId, invoiceNumber,
        status: 'DRAFT', currency: quote.currency, subtotal, taxTotal, total, balanceDue: total,
        lineItems: quote.lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unit: line.unit, unitPrice: Number(line.unitPrice), taxRate: line.taxRate === null ? null : Number(line.taxRate) })),
        depositRequired: depositRequired !== null ? depositRequired : undefined,
        dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
        notes: notesInput || [quote.notes, quote.terms].filter(Boolean).join('\n\n') || null,
      },
      include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } },
    })
    return res.status(201).json({ invoice: { ...invoice, subtotal: Number(invoice.subtotal), taxTotal: Number(invoice.taxTotal), total: Number(invoice.total), amountPaid: Number(invoice.amountPaid), balanceDue: Number(invoice.balanceDue), depositRequired: invoice.depositRequired ? Number(invoice.depositRequired) : null, depositPaid: Number(invoice.depositPaid) }, alreadyConverted: false })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.invoice.findUnique({ where: { sourceQuoteId: quote.id }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
      if (raced) return res.json({ invoice: { ...raced, subtotal: Number(raced.subtotal), taxTotal: Number(raced.taxTotal), total: Number(raced.total), amountPaid: Number(raced.amountPaid), balanceDue: Number(raced.balanceDue), depositRequired: raced.depositRequired ? Number(raced.depositRequired) : null, depositPaid: Number(raced.depositPaid) }, alreadyConverted: true })
    }
    throw error
  }
})

app.post('/api/jobs/:id/invoice-draft', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized.' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })
  if (job.status !== 'COMPLETED') return res.status(409).json({ message: 'Mark the job complete before preparing its final invoice.' })
  if (!job.quoteId || !job.acceptedQuoteSnapshot) return res.status(409).json({ message: 'This job has no accepted quote to prepare an invoice from.' })

  const existing = await prisma.invoice.findFirst({ where: { organisationId, OR: [{ sourceQuoteId: job.quoteId }, { jobId: job.id }] }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
  if (existing) {
    if (existing.jobId && existing.jobId !== job.id) return res.status(409).json({ message: `This quote is already invoiced against another job (${existing.job?.title ?? existing.invoiceNumber}). Review that job before continuing.` })
    const linked = existing.jobId ? existing : await prisma.invoice.update({ where: { id: existing.id }, data: { jobId: job.id }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
    return res.json({ invoice: { ...linked, subtotal: Number(linked.subtotal), taxTotal: Number(linked.taxTotal), total: Number(linked.total), amountPaid: Number(linked.amountPaid), balanceDue: Number(linked.balanceDue), depositRequired: linked.depositRequired ? Number(linked.depositRequired) : null, depositPaid: Number(linked.depositPaid) }, alreadyExists: true })
  }

  const snapshot = job.acceptedQuoteSnapshot as { documentNumber?: unknown; currency?: unknown; subtotal?: unknown; taxTotal?: unknown; total?: unknown; notes?: unknown; terms?: unknown; lines?: unknown }
  const subtotal = Number(snapshot.subtotal)
  const taxTotal = Number(snapshot.taxTotal)
  const total = Number(snapshot.total)
  if (![subtotal, taxTotal, total].every(Number.isFinite) || subtotal < 0 || taxTotal < 0 || Math.abs(roundMoney(subtotal + taxTotal) - roundMoney(total)) > 0.01 || !Array.isArray(snapshot.lines)) {
    return res.status(409).json({ message: 'The saved accepted quote snapshot is incomplete. Create the invoice manually after reviewing the quote.' })
  }
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { quotePrefix: true } })
  const trialInvoiceBlock = await trialLimitReached(organisationId, 'invoices')
  if (trialInvoiceBlock) return res.status(403).json({ message: trialInvoiceBlock, code: PLAN_LIMIT_CODE })
  const invoiceNumber = await generateInvoiceNumber(organisationId, org?.quotePrefix ?? 'INV')
  try {
    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          organisationId, jobId: job.id, sourceQuoteId: job.quoteId, customerId: job.customerId, invoiceNumber,
          status: 'DRAFT', currency: typeof snapshot.currency === 'string' ? snapshot.currency : job.currency, subtotal, taxTotal, total, balanceDue: total,
          lineItems: snapshot.lines as PrismaTypes.InputJsonValue,
          notes: [typeof snapshot.notes === 'string' ? snapshot.notes : '', typeof snapshot.terms === 'string' ? snapshot.terms : ''].filter(Boolean).join('\n\n') || null,
        },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } },
      })
      await recordJobActivity(job.id, user, 'INVOICE_DRAFT_PREPARED', { invoiceId: created.id, invoiceNumber: created.invoiceNumber, sourceQuoteId: job.quoteId }, tx)
      return created
    })
    return res.status(201).json({ invoice: { ...invoice, subtotal: Number(invoice.subtotal), taxTotal: Number(invoice.taxTotal), total: Number(invoice.total), amountPaid: Number(invoice.amountPaid), balanceDue: Number(invoice.balanceDue), depositRequired: invoice.depositRequired ? Number(invoice.depositRequired) : null, depositPaid: Number(invoice.depositPaid) } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.invoice.findUnique({ where: { sourceQuoteId: job.quoteId }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
      if (raced && (!raced.jobId || raced.jobId === job.id)) {
        const linked = raced.jobId ? raced : await prisma.invoice.update({ where: { id: raced.id }, data: { jobId: job.id }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
        return res.json({ invoice: { ...linked, subtotal: Number(linked.subtotal), taxTotal: Number(linked.taxTotal), total: Number(linked.total), amountPaid: Number(linked.amountPaid), balanceDue: Number(linked.balanceDue), depositRequired: linked.depositRequired ? Number(linked.depositRequired) : null, depositPaid: Number(linked.depositPaid) }, alreadyExists: true })
      }
      if (raced) return res.status(409).json({ message: `An invoice was just created against ${raced.job?.title ?? 'this quote'}. Refresh and review the existing invoice.` })
    }
    throw error
  }
})

app.get('/api/invoices', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const statusFilter = req.query?.status ? String(req.query.status).toUpperCase().split(',') : undefined
  const customerFilter = req.query?.customerId ? String(req.query.customerId) : undefined
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)

  const where: Record<string, unknown> = { organisationId }
  if (statusFilter && statusFilter.every((s) => VALID_INVOICE_STATUSES.includes(s))) where.status = { in: statusFilter }
  if (customerFilter) where.customerId = customerFilter

  const [invoices, totalCount] = await Promise.all([
    prisma.invoice.findMany({
      where: where as never,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: { customer: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } },
    }),
    prisma.invoice.count({ where: where as never }),
  ])

  res.json({
    invoices: invoices.map((inv) => ({
      ...inv,
      subtotal: Number(inv.subtotal),
      taxTotal: Number(inv.taxTotal),
      total: Number(inv.total),
      amountPaid: Number(inv.amountPaid),
      balanceDue: Number(inv.balanceDue),
      depositRequired: inv.depositRequired ? Number(inv.depositRequired) : null,
      depositPaid: Number(inv.depositPaid),
    })),
    totalCount,
    hasMore: offset + limit < totalCount,
  })
})

app.get('/api/invoices/:id', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({
    where: { id: String(req.params.id ?? ''), organisationId },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      job: { select: { id: true, title: true } },
      sourceQuote: { select: { id: true, documentNumber: true } },
      reconciliations: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  const payments = await listInvoiceAllocatedPayments(prisma, invoice.id, organisationId)
  const allocationHistory = await listInvoiceAllocationHistory(prisma, invoice.id, organisationId)

  res.json({
    invoice: {
      ...invoice,
      subtotal: Number(invoice.subtotal),
      taxTotal: Number(invoice.taxTotal),
      total: Number(invoice.total),
      amountPaid: Number(invoice.amountPaid),
      balanceDue: Number(invoice.balanceDue),
      depositRequired: invoice.depositRequired ? Number(invoice.depositRequired) : null,
      depositPaid: Number(invoice.depositPaid),
      payments,
      allocationHistory,
    },
  })
})

app.post('/api/invoices/:id/reconcile', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  if (!reason) return res.status(400).json({ message: 'Provide a reason for reconciliation.' })
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoice.id} FOR UPDATE`
    const current = await tx.invoice.findUnique({ where: { id: invoice.id } })
    if (!current || current.organisationId !== organisationId) return { error: 'Invoice not found.' as const }
    const allocationNet = await getNetInvoiceAllocations(tx, current.id, organisationId)
    const refundTotals = await tx.paymentRefund.aggregate({ where: { invoiceId: current.id, organisationId }, _sum: { amount: true } })
    const correctedAmountPaid = roundMoney(allocationNet - Number(refundTotals._sum.amount ?? 0))
    const correctedBalanceDue = roundMoney(Number(current.total) - correctedAmountPaid)
    const correctedStatus = current.status === 'CANCELLED'
      ? 'CANCELLED'
      : correctedBalanceDue <= 0.001
        ? 'PAID'
        : correctedAmountPaid > 0
          ? 'PARTIALLY_PAID'
          : current.status === 'PAID' || current.status === 'PARTIALLY_PAID' ? 'SENT' : current.status
    const isMismatch = Math.abs(Number(current.amountPaid) - correctedAmountPaid) > 0.01
      || Math.abs(Number(current.balanceDue) - correctedBalanceDue) > 0.01
      || current.status !== correctedStatus
    if (!isMismatch) return { invoice: current, reconciled: false }

    const updated = await tx.invoice.update({ where: { id: current.id }, data: { amountPaid: correctedAmountPaid, balanceDue: correctedBalanceDue, status: correctedStatus } })
    await tx.invoiceReconciliation.create({
      data: {
        invoiceId: current.id, organisationId, actorId: user.id, actorName: user.name, reason,
        previousAmountPaid: current.amountPaid, previousBalanceDue: current.balanceDue,
        correctedAmountPaid, correctedBalanceDue,
      },
    })
    return { invoice: updated, reconciled: true }
  })
  if ('error' in result) return res.status(404).json({ message: result.error })
  const fullInvoice = await prisma.invoice.findFirst({ where: { id: invoice.id, organisationId }, include: { customer: { select: { id: true, name: true } }, job: { select: { id: true, title: true } }, reconciliations: { orderBy: { createdAt: 'desc' }, take: 50 } } })
  if (!fullInvoice) return res.status(404).json({ message: 'Invoice not found.' })
  const payments = await listInvoiceAllocatedPayments(prisma, invoice.id, organisationId)
  const allocationHistory = await listInvoiceAllocationHistory(prisma, invoice.id, organisationId)
  return res.json({ reconciled: result.reconciled, invoice: { ...fullInvoice, subtotal: Number(fullInvoice.subtotal), taxTotal: Number(fullInvoice.taxTotal), total: Number(fullInvoice.total), amountPaid: Number(fullInvoice.amountPaid), balanceDue: Number(fullInvoice.balanceDue), payments, allocationHistory } })
})

app.post('/api/invoices/:id/send', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({
    where: { id: String(req.params.id ?? ''), organisationId },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      organisation: { select: { id: true, name: true } },
      sourceQuote: { select: { id: true, documentNumber: true, status: true, publicToken: true } },
    },
  })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status !== 'DRAFT') return res.status(409).json({ message: 'Only draft invoices can be sent.' })
  if (!invoice.sourceQuote || invoice.sourceQuote.status !== 'APPROVED') return res.status(409).json({ message: 'Invoices can only be sent from an approved quote.' })

  const recipientEmail = String(req.body?.recipientEmail ?? invoice.customer.email ?? '').trim().toLowerCase()
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) return res.status(400).json({ message: 'Enter a valid customer email address before sending this invoice.' })

  const publicToken = invoice.sourceQuote.publicToken ?? randomBytes(24).toString('base64url')
  if (!invoice.sourceQuote.publicToken) {
    await prisma.quote.update({ where: { id: invoice.sourceQuote.id }, data: { publicToken, tokenRevokedAt: null, tokenRevokedBy: null } })
  }
  const platformUrl = (process.env.PLATFORM_URL ?? 'http://localhost:5174').replace(/\/$/, '')
  const invoiceUrl = `${platformUrl}/quote/${encodeURIComponent(publicToken)}`
  const invoiceLines = Array.isArray(invoice.lineItems) ? invoice.lineItems as Array<Record<string, unknown>> : []
  const lineItems = invoiceLines.map((line) => {
    const quantity = Number(line.quantity ?? 0)
    const unitPrice = Number(line.unitPrice ?? 0)
    return {
      description: String(line.description ?? 'Work item'),
      quantity,
      unit: String(line.unit ?? 'unit'),
      unitPrice,
      total: roundMoney(quantity * unitPrice),
    }
  })
  const formatEmailDate = (date: Date | null) => date ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date) : null

  try {
    const result = await sendEmail(
      recipientEmail,
      emailSubjects.invoiceDelivery(invoice.organisation.name ?? 'iQuote', invoice.invoiceNumber),
      invoiceDeliveryEmailHtml({
        recipientName: invoice.customer.name,
        businessName: invoice.organisation.name ?? 'iQuote',
        invoiceNumber: invoice.invoiceNumber,
        quoteNumber: invoice.sourceQuote.documentNumber,
        total: Number(invoice.total),
        amountPaid: Number(invoice.amountPaid),
        balanceDue: Number(invoice.balanceDue),
        currency: invoice.currency,
        issueDate: formatEmailDate(invoice.issueDate) ?? '',
        dueDate: formatEmailDate(invoice.dueDate),
        lineItems,
        notes: invoice.notes,
        invoiceUrl,
      }),
      `invoice-delivery/${invoice.id}/${encodeURIComponent(recipientEmail)}`,
      organisationId,
    )
    if (!result) return res.status(503).json({ message: 'Email provider is not configured. Set RESEND_API_KEY and a verified sender address before sending invoices.' })

    const sentAt = new Date()
    const sentStatus = Number(invoice.balanceDue) <= 0.001 ? 'PAID' : Number(invoice.amountPaid) > 0 ? 'PARTIALLY_PAID' : 'SENT'
    const updatedCount = await prisma.invoice.updateMany({ where: { id: invoice.id, organisationId, status: 'DRAFT' }, data: { status: sentStatus, sentAt } })
    if (!updatedCount.count) return res.status(409).json({ message: 'The invoice was sent, but its status changed at the same time. Refresh the invoice before continuing.' })
    const updated = await prisma.invoice.findFirst({ where: { id: invoice.id, organisationId }, include: { customer: { select: { id: true, name: true, phone: true, email: true } }, job: { select: { id: true, title: true } }, sourceQuote: { select: { id: true, documentNumber: true } } } })
    if (!updated) return res.status(404).json({ message: 'The invoice was sent, but it could not be reloaded.' })
    return res.json({
      delivery: { recipientEmail, providerMessageId: result.messageId, sentAt: sentAt.toISOString() },
      invoice: { ...updated, subtotal: Number(updated.subtotal), taxTotal: Number(updated.taxTotal), total: Number(updated.total), amountPaid: Number(updated.amountPaid), balanceDue: Number(updated.balanceDue), depositRequired: updated.depositRequired ? Number(updated.depositRequired) : null, depositPaid: Number(updated.depositPaid) },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invoice email delivery failed.'
    return res.status(502).json({ message: errorMessage })
  }
})

app.put('/api/invoices/:id', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status !== 'DRAFT') return res.status(409).json({ message: 'Only draft invoices can be edited.' })

  const subtotal = req.body?.subtotal !== undefined ? Number(req.body.subtotal) : undefined
  const taxTotal = req.body?.taxTotal !== undefined ? Number(req.body.taxTotal) : undefined
  const notes = req.body?.notes !== undefined ? (String(req.body.notes).trim() || null) : undefined
  const dueDate = req.body?.dueDate !== undefined ? (req.body.dueDate ? new Date(req.body.dueDate) : null) : undefined
  const status = req.body?.status !== undefined ? String(req.body.status).toUpperCase() : undefined
  const depositRequired = req.body?.depositRequired !== undefined ? (req.body.depositRequired === null ? null : Number(req.body.depositRequired)) : undefined

  const data: Record<string, unknown> = {}
  if (subtotal !== undefined) {
    if (!Number.isFinite(subtotal) || subtotal < 0) return res.status(400).json({ message: 'Subtotal must be non-negative.' })
    data.subtotal = subtotal
  }
  if (taxTotal !== undefined) {
    if (!Number.isFinite(taxTotal) || taxTotal < 0) return res.status(400).json({ message: 'Tax total must be non-negative.' })
    data.taxTotal = taxTotal
  }
  if (subtotal !== undefined || taxTotal !== undefined) {
    const s = subtotal ?? Number(invoice.subtotal)
    const t = taxTotal ?? Number(invoice.taxTotal)
    data.total = roundMoney(s + t)
    data.balanceDue = roundMoney(s + t) - Number(invoice.amountPaid)
  }
  if (notes !== undefined) data.notes = notes
  if (dueDate !== undefined) data.dueDate = dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null
  if (depositRequired !== undefined) {
    if (depositRequired !== null) {
      if (!Number.isFinite(depositRequired) || depositRequired < 0) return res.status(400).json({ message: 'Deposit required must be non-negative.' })
      const invTotal = Number(data.total ?? invoice.total)
      if (depositRequired > invTotal) return res.status(400).json({ message: 'Deposit required cannot exceed the invoice total.' })
    }
    data.depositRequired = depositRequired
  }
  if (status && VALID_INVOICE_STATUSES.includes(status) && status !== 'DRAFT') {
    if (status === 'SENT') return res.status(400).json({ message: 'Use the invoice send action so the customer receives the invoice by email.' })
    data.status = status
  }

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: data as never,
    include: { customer: { select: { id: true, name: true } }, job: { select: { id: true, title: true } } },
  })
  res.json({
    invoice: {
      ...updated,
      subtotal: Number(updated.subtotal),
      taxTotal: Number(updated.taxTotal),
      total: Number(updated.total),
      amountPaid: Number(updated.amountPaid),
      balanceDue: Number(updated.balanceDue),
      depositRequired: updated.depositRequired ? Number(updated.depositRequired) : null,
      depositPaid: Number(updated.depositPaid),
    },
  })
})

app.post('/api/invoices/:id/payments', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status === 'CANCELLED') return res.status(409).json({ message: 'Cannot record payments on a cancelled invoice.' })
  if (invoice.status === 'DRAFT') return res.status(409).json({ message: 'Send the invoice before recording a payment.' })

  const amount = Number(req.body?.amount ?? 0)
  const method = String(req.body?.method ?? '').toUpperCase()
  const reference = req.body?.reference ? String(req.body.reference).trim() : null
  const idempotencyKey = String(req.body?.idempotencyKey ?? '').trim()
  const paymentDate = req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date()
  const isDeposit = Boolean(req.body?.isDeposit)

  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Payment amount must be a positive number.' })
  if (!VALID_PAYMENT_METHODS.includes(method)) return res.status(400).json({ message: 'Invalid payment method.' })
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid idempotency key is required.' })
  if (paymentDate && Number.isNaN(paymentDate.getTime())) return res.status(400).json({ message: 'Invalid payment date.' })

  // Deposit validation: if flagged as deposit and invoice has depositRequired, amount must not exceed deposit requirement
  if (isDeposit && invoice.depositRequired && amount > Number(invoice.depositRequired) + 0.001) {
    return res.status(400).json({ message: 'Deposit payment cannot exceed the required deposit amount.' })
  }

  // Repeated submissions return the first durable payment row for this exact user action.
  const existingPayment = await prisma.payment.findUnique({ where: { idempotencyKey } })
  if (existingPayment) {
    if (existingPayment.organisationId !== organisationId || existingPayment.invoiceId !== invoice.id || Number(existingPayment.amount) !== roundMoney(amount) || existingPayment.method !== method || existingPayment.reference !== reference) return res.status(409).json({ message: 'This idempotency key has already been used for a different payment.' })
    return res.json({ payment: { ...existingPayment, amount: Number(existingPayment.amount) }, replayed: true })
  }

  // Lock the invoice row so concurrent payment posts cannot overwrite each other's totals.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoice.id} FOR UPDATE`
    const lockedInvoice = await tx.invoice.findUnique({ where: { id: invoice.id } })
    if (!lockedInvoice || lockedInvoice.organisationId !== organisationId || lockedInvoice.status === 'CANCELLED' || lockedInvoice.status === 'DRAFT') return { conflict: 'Invoice is no longer available for payments.' as const }
    const repeated = await tx.payment.findUnique({ where: { idempotencyKey } })
    if (repeated) {
      if (repeated.organisationId !== organisationId || repeated.invoiceId !== lockedInvoice.id || Number(repeated.amount) !== roundMoney(amount) || repeated.method !== method || repeated.reference !== reference) return { conflict: 'This idempotency key has already been used for a different payment.' as const }
      return { payment: repeated, replayed: true as const }
    }
    const allocationNet = await getNetInvoiceAllocations(tx, lockedInvoice.id, organisationId)
    const refundedBefore = await tx.paymentRefund.aggregate({ where: { invoiceId: lockedInvoice.id, organisationId }, _sum: { amount: true } })
    const currentPaid = roundMoney(allocationNet - Number(refundedBefore._sum.amount ?? 0))
    const dueBefore = roundMoney(Number(lockedInvoice.total) - currentPaid)
    if (amount > dueBefore + 0.001) return { conflict: 'Payment amount exceeds the remaining invoice balance.' as const }

    const paymentId = `pay_${randomBytes(12).toString('hex')}`
    const payment = await tx.payment.create({
      data: {
        id: paymentId,
        receiptNumber: `RCP-${paymentId.toUpperCase()}`,
        invoiceId: invoice.id,
        organisationId,
        idempotencyKey,
        amount,
        currency: invoice.currency,
        method,
        reference,
        isDeposit,
        paymentDate: paymentDate && !Number.isNaN(paymentDate.getTime()) ? paymentDate : new Date(),
        receivedBy: user.id,
      },
    })
    await tx.paymentAllocation.create({ data: { organisationId, invoiceId: invoice.id, paymentId: payment.id, eventType: 'ALLOCATE', amount, currency: invoice.currency, idempotencyKey: `opening-payment:${payment.id}`, reason: isDeposit ? 'Deposit payment recorded on invoice' : 'Payment recorded on invoice', actorId: user.id, actorName: user.name } })

    const totalPaid = roundMoney(currentPaid + amount)
    const invoiceTotal = Number(lockedInvoice.total)
    const balanceDue = roundMoney(invoiceTotal - totalPaid)

    let nextStatus: string
    if (totalPaid >= invoiceTotal) {
      nextStatus = 'PAID'
    } else if (totalPaid > 0) {
      nextStatus = 'PARTIALLY_PAID'
    } else {
      nextStatus = invoice.status
    }

    // Update depositPaid if this is a deposit payment
    const depositUpdate: Record<string, unknown> = {}
    if (isDeposit && lockedInvoice.depositRequired) {
      const existingDeposits = await tx.payment.aggregate({ where: { invoiceId: lockedInvoice.id, isDeposit: true, id: { not: paymentId } }, _sum: { amount: true } })
      depositUpdate.depositPaid = roundMoney(Number(existingDeposits._sum.amount ?? 0) + amount)
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: totalPaid,
        balanceDue,
        status: nextStatus as never,
        ...depositUpdate,
      },
    })

    return { payment, replayed: false as const }
  })

  if ('conflict' in result) return res.status(409).json({ message: result.conflict })
  const { idempotencyKey: _idempotencyKey, ...safePayment } = result.payment
  res.status(result.replayed ? 200 : 201).json({ payment: { ...safePayment, receiptNumber: `RCP-${result.payment.id.toUpperCase()}`, amount: Number(result.payment.amount) }, replayed: result.replayed })
})

app.post('/api/payments/:paymentId/reallocate', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const paymentId = String(req.params.paymentId ?? '')
  const fromInvoiceId = String(req.body?.fromInvoiceId ?? '')
  const toInvoiceId = String(req.body?.toInvoiceId ?? '')
  const amount = roundMoney(Number(req.body?.amount))
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  const requestKey = String(req.body?.idempotencyKey ?? '').trim()
  if (!fromInvoiceId || !toInvoiceId || fromInvoiceId === toInvoiceId) return res.status(400).json({ message: 'Choose two different invoices.' })
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Reallocation amount must be positive.' })
  if (!reason) return res.status(400).json({ message: 'Provide a reason for the reallocation.' })
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) return res.status(400).json({ message: 'A valid idempotency key is required.' })

  const replay = await prisma.paymentAllocation.findUnique({ where: { idempotencyKey: `${requestKey}:allocate` } })
  if (replay) {
    const reversal = await prisma.paymentAllocation.findUnique({ where: { idempotencyKey: `${requestKey}:reverse` } })
    if (replay.organisationId !== organisationId || replay.paymentId !== paymentId || replay.invoiceId !== toInvoiceId || Number(replay.amount) !== roundMoney(amount) || replay.reason !== reason || !reversal || reversal.invoiceId !== fromInvoiceId || Number(reversal.amount) !== roundMoney(amount)) return res.status(409).json({ message: 'This request key has already been used for a different reallocation.' })
    return res.json({ reallocated: true, replayed: true })
  }
  const result = await prisma.$transaction(async (tx) => {
    const ids = [fromInvoiceId, toInvoiceId].sort()
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${ids[0]} OR "id" = ${ids[1]} ORDER BY "id" FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`
    const [payment, source, target] = await Promise.all([
      tx.payment.findFirst({ where: { id: paymentId, organisationId } }),
      tx.invoice.findFirst({ where: { id: fromInvoiceId, organisationId } }),
      tx.invoice.findFirst({ where: { id: toInvoiceId, organisationId } }),
    ])
    if (!payment || !source || !target) return { error: 'Payment or invoice not found.' as const }
    const existing = await tx.paymentAllocation.findUnique({ where: { idempotencyKey: `${requestKey}:allocate` } })
    if (existing) {
      const reversal = await tx.paymentAllocation.findUnique({ where: { idempotencyKey: `${requestKey}:reverse` } })
      if (existing.organisationId !== organisationId || existing.paymentId !== paymentId || existing.invoiceId !== toInvoiceId || Number(existing.amount) !== roundMoney(amount) || existing.reason !== reason || !reversal || reversal.invoiceId !== fromInvoiceId || Number(reversal.amount) !== roundMoney(amount)) return { error: 'This request key has already been used for a different reallocation.' as const }
      return { replayed: true as const }
    }
    if (source.status === 'CANCELLED' || source.status === 'DRAFT' || target.status === 'CANCELLED' || target.status === 'DRAFT') return { error: 'Both invoices must be active sent invoices.' as const }
    if (source.customerId !== target.customerId || source.currency !== target.currency || source.currency !== payment.currency) return { error: 'Payments can only move between invoices for the same customer and currency.' as const }
    const [refunds, sourceAllocated, sourceReversed, targetPaid, targetReversed, targetRefunds] = await Promise.all([
      tx.paymentRefund.aggregate({ where: { organisationId, paymentId }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, invoiceId: source.id, paymentId, eventType: 'ALLOCATE' }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, invoiceId: source.id, paymentId, eventType: 'REVERSE' }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, invoiceId: target.id, eventType: 'ALLOCATE' }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, invoiceId: target.id, eventType: 'REVERSE' }, _sum: { amount: true } }),
      tx.paymentRefund.aggregate({ where: { organisationId, invoiceId: target.id }, _sum: { amount: true } }),
    ])
    if (Number(refunds._sum.amount ?? 0) > 0) return { error: 'A payment with a recorded refund cannot be reallocated.' as const }
    const sourceAmount = roundMoney(Number(sourceAllocated._sum.amount ?? 0) - Number(sourceReversed._sum.amount ?? 0))
    if (amount > sourceAmount + 0.001) return { error: 'Reallocation exceeds the amount currently assigned to the source invoice.' as const }
    const targetNet = roundMoney(Number(targetPaid._sum.amount ?? 0) - Number(targetReversed._sum.amount ?? 0) - Number(targetRefunds._sum.amount ?? 0))
    if (amount > Number(target.total) - targetNet + 0.001) return { error: 'Reallocation exceeds the target invoice balance.' as const }
    await tx.paymentAllocation.create({ data: { organisationId, invoiceId: source.id, paymentId, eventType: 'REVERSE', amount, currency: payment.currency, idempotencyKey: `${requestKey}:reverse`, reason, actorId: user.id, actorName: user.name } })
    await tx.paymentAllocation.create({ data: { organisationId, invoiceId: target.id, paymentId, eventType: 'ALLOCATE', amount, currency: payment.currency, idempotencyKey: `${requestKey}:allocate`, reason, actorId: user.id, actorName: user.name } })
    await Promise.all([updateInvoiceFromLedger(tx, source, organisationId), updateInvoiceFromLedger(tx, target, organisationId)])
    return { replayed: false as const }
  })
  if ('error' in result) return res.status(409).json({ message: result.error })
  return res.status(result.replayed ? 200 : 201).json({ reallocated: true, replayed: result.replayed })
})

app.post('/api/invoices/:id/refunds', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status === 'CANCELLED') return res.status(409).json({ message: 'A cancelled invoice cannot be refunded.' })
  if (invoice.status === 'DRAFT') return res.status(409).json({ message: 'A draft invoice cannot have recorded refunds.' })
  if (req.body?.confirmedExternally !== true) return res.status(400).json({ message: 'Complete the refund outside iQuote first, then confirm it here.' })

  const paymentId = String(req.body?.paymentId ?? '').trim()
  const idempotencyKey = String(req.body?.idempotencyKey ?? '').trim()
  const amount = roundMoney(Number(req.body?.amount))
  const method = String(req.body?.method ?? '').toUpperCase()
  const reference = String(req.body?.reference ?? '').trim() || null
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
  const refundedAt = req.body?.refundedAt ? new Date(req.body.refundedAt) : new Date()
  if (!paymentId) return res.status(400).json({ message: 'Choose the payment being refunded.' })
  if (!/^[\w:-]{12,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Refresh the refund form and try again.' })
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Refund amount must be greater than zero.' })
  if (!['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'OTHER'].includes(method)) return res.status(400).json({ message: 'Choose how the refund was sent.' })
  if (!reason) return res.status(400).json({ message: 'Enter a reason for the refund.' })
  if (Number.isNaN(refundedAt.getTime())) return res.status(400).json({ message: 'Enter a valid refund date.' })

  const repeated = await prisma.paymentRefund.findUnique({ where: { idempotencyKey } })
  if (repeated) {
    if (repeated.organisationId !== organisationId || repeated.invoiceId !== invoice.id || repeated.paymentId !== paymentId || Number(repeated.amount) !== amount || repeated.method !== method || repeated.reference !== reference || repeated.reason !== reason) return res.status(409).json({ message: 'This refund request key has already been used for a different refund.' })
    return res.json({ refund: { ...repeated, amount: Number(repeated.amount) }, replayed: true })
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoice.id} FOR UPDATE`
    const current = await tx.invoice.findUnique({ where: { id: invoice.id } })
    if (!current || current.organisationId !== organisationId || current.status === 'CANCELLED' || current.status === 'DRAFT') return { conflict: 'Invoice is no longer available for refunds.' as const }
    const priorRequest = await tx.paymentRefund.findUnique({ where: { idempotencyKey } })
    if (priorRequest) {
      if (priorRequest.organisationId !== organisationId || priorRequest.invoiceId !== current.id || priorRequest.paymentId !== paymentId || Number(priorRequest.amount) !== amount || priorRequest.method !== method || priorRequest.reference !== reference || priorRequest.reason !== reason) return { conflict: 'This refund request key has already been used for a different refund.' as const }
      return { refund: priorRequest, replayed: true as const }
    }
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organisationId } })
    if (!payment) return { conflict: 'Choose a payment recorded in this workspace.' as const }
    const [existingRefund, allocated, reversed] = await Promise.all([
      tx.paymentRefund.aggregate({ where: { organisationId, paymentId: payment.id }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, paymentId: payment.id, invoiceId: current.id, eventType: 'ALLOCATE' }, _sum: { amount: true } }),
      tx.paymentAllocation.aggregate({ where: { organisationId, paymentId: payment.id, invoiceId: current.id, eventType: 'REVERSE' }, _sum: { amount: true } }),
    ])
    const refundable = roundMoney(Math.min(Number(payment.amount) - Number(existingRefund._sum.amount ?? 0), Number(allocated._sum.amount ?? 0) - Number(reversed._sum.amount ?? 0)))
    if (amount > refundable + 0.001) return { conflict: 'Refund amount exceeds the unrefunded part of this payment.' as const }
    const refund = await tx.paymentRefund.create({ data: { organisationId, invoiceId: current.id, paymentId: payment.id, idempotencyKey, amount, currency: payment.currency, method, reference, reason, refundedAt, recordedBy: user.id, recordedByName: user.name } })
    await updateInvoiceFromLedger(tx, current, organisationId)
    return { refund, replayed: false as const }
  })
  if ('conflict' in result) return res.status(409).json({ message: result.conflict })
  return res.status(result.replayed ? 200 : 201).json({ refund: { ...result.refund, amount: Number(result.refund.amount) }, replayed: result.replayed })
})

async function applyCustomerMpesaPayment(attemptId: string, providerReference: string | null) {
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.invoicePaymentAttempt.findUnique({ where: { id: attemptId } })
    if (!attempt) return { ok: false as const, message: 'Payment request was not found.' }
    if (attempt.status === 'PAID') return { ok: true as const, replayed: true }
    if (!['PENDING', 'UNKNOWN'].includes(attempt.status)) return { ok: false as const, message: 'Payment request is no longer pending.' }
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`
    const invoice = await tx.invoice.findUnique({ where: { id: attempt.invoiceId } })
    if (!invoice || invoice.organisationId !== attempt.organisationId || invoice.status === 'CANCELLED' || invoice.status === 'DRAFT') {
      await tx.invoicePaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', statusDescription: 'Invoice is no longer available.', completedAt: new Date() } })
      return { ok: false as const, message: 'Invoice is no longer available.' }
    }
    const currentAttempt = await tx.invoicePaymentAttempt.findUnique({ where: { id: attempt.id } })
    if (!currentAttempt || !['PENDING', 'UNKNOWN'].includes(currentAttempt.status)) return { ok: currentAttempt?.status === 'PAID', replayed: true as const }
    const allocationNet = await getNetInvoiceAllocations(tx, invoice.id, attempt.organisationId)
    const refundedBefore = await tx.paymentRefund.aggregate({ where: { invoiceId: invoice.id, organisationId: attempt.organisationId }, _sum: { amount: true } })
    const amount = Number(attempt.amount)
    const currentPaid = roundMoney(allocationNet - Number(refundedBefore._sum.amount ?? 0))
    const totalPaid = roundMoney(currentPaid + amount)
    const invoiceTotal = Number(invoice.total)
    if (amount <= 0 || totalPaid > invoiceTotal + 0.001) {
      await tx.invoicePaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'REVIEW', statusDescription: 'Confirmed amount is above the remaining invoice balance. Review this transaction before reconciling.', completedAt: new Date() } })
      return { ok: false as const, message: 'Payment needs manual review because the invoice balance changed.' }
    }
    const paymentId = `pay_${randomBytes(12).toString('hex')}`
    await tx.payment.create({ data: {
      id: paymentId, receiptNumber: `RCP-${paymentId.toUpperCase()}`,
      invoiceId: invoice.id, organisationId: attempt.organisationId, idempotencyKey: `ncba-stk:${attempt.id}`,
      amount, currency: attempt.currency, method: 'MOBILE_MONEY', reference: providerReference || attempt.transactionId,
      paymentDate: new Date(), receivedBy: attempt.requestedBy,
    } })
    await tx.paymentAllocation.create({ data: { organisationId: attempt.organisationId, invoiceId: invoice.id, paymentId, eventType: 'ALLOCATE', amount, currency: attempt.currency, idempotencyKey: `opening-mpesa:${attempt.id}`, reason: 'NCBA M-Pesa payment applied to invoice', actorId: attempt.requestedBy, actorName: 'M-Pesa settlement' } })
    const balanceDue = roundMoney(invoiceTotal - totalPaid)
    await tx.invoice.update({ where: { id: invoice.id }, data: { amountPaid: totalPaid, balanceDue, status: balanceDue <= 0 ? 'PAID' : 'PARTIALLY_PAID' } })
    await tx.invoicePaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'PAID', statusDescription: 'Payment confirmed by NCBA.', providerReference: providerReference || attempt.providerReference, completedAt: new Date() } })
    return { ok: true as const, replayed: false }
  })
}

async function refreshCustomerMpesaAttempt(attempt: Awaited<ReturnType<typeof prisma.invoicePaymentAttempt.findFirst>>) {
  if (!attempt || !['PENDING', 'UNKNOWN'].includes(attempt.status) || !attempt.transactionId || Date.now() - attempt.updatedAt.getTime() < 5_000) return attempt
  try {
    const credentials = { username: decryptEmailSecret(attempt.gatewayUsernameCiphertext), secretKey: decryptEmailSecret(attempt.gatewaySecretCiphertext) }
    const result = await queryMerchantStkPush(attempt.transactionId, credentials)
    const status = String(result.status ?? result.Status ?? result.TransactionStatus ?? 'PENDING').toUpperCase()
    if (status === 'SUCCESS') {
      await applyCustomerMpesaPayment(attempt.id, attempt.providerReference)
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      await prisma.invoicePaymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['PENDING', 'UNKNOWN'] } }, data: { status: 'FAILED', statusDescription: result.description ?? result.StatusDescription ?? 'Customer did not complete the M-Pesa payment.', completedAt: new Date() } })
    } else if (result.description || result.StatusDescription) {
      await prisma.invoicePaymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['PENDING', 'UNKNOWN'] } }, data: { statusDescription: result.description ?? result.StatusDescription } })
    }
    return prisma.invoicePaymentAttempt.findUnique({ where: { id: attempt.id } })
  } catch {
    return attempt
  }
}

app.post('/api/invoices/:id/mpesa/stk', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, include: { customer: { select: { phone: true } } } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED' || invoice.status === 'PAID') return res.status(409).json({ message: 'Send the invoice first and make sure it has a balance due.' })
  if (invoice.currency !== 'KES') return res.status(409).json({ message: 'NCBA M-Pesa collection currently supports KES invoices only.' })
  const settings = await prisma.tenantPaymentSettings.findUnique({ where: { organisationId } })
  if (!settings?.enabled || !settings.stkUsernameCiphertext || !settings.stkSecretCiphertext) return res.status(409).json({ message: 'Set up and enable your business M-Pesa collection in Settings first.' })
  const phone = normalizeCustomerPhone(req.body?.phone ?? invoice.customer.phone)
  const amount = Number(req.body?.amount ?? invoice.balanceDue)
  const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim()
  const balanceDue = Number(invoice.balanceDue)
  if (!phone) return res.status(400).json({ message: 'Enter a valid Kenyan M-Pesa number.' })
  if (!Number.isFinite(amount) || amount <= 0 || amount > balanceDue + 0.001) return res.status(400).json({ message: 'Enter an amount up to the remaining invoice balance.' })
  if (!/^[\w:-]{12,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Refresh the payment form and try again.' })
  const repeated = await prisma.invoicePaymentAttempt.findUnique({ where: { idempotencyKey } })
  if (repeated) {
    if (repeated.organisationId !== organisationId || repeated.invoiceId !== invoice.id || Number(repeated.amount) !== roundMoney(amount) || repeated.phone !== phone) return res.status(409).json({ message: 'This payment request key has already been used for a different customer payment.' })
    return res.json({ payment: { id: repeated.id, amount: Number(repeated.amount), currency: repeated.currency, status: repeated.status, statusDescription: repeated.statusDescription, queryable: Boolean(repeated.transactionId), phone: `${repeated.phone.slice(0, 5)}••••${repeated.phone.slice(-2)}` }, replayed: true })
  }
  const openedAttempt = await prisma.invoicePaymentAttempt.findFirst({ where: { invoiceId: invoice.id, status: { in: ['PENDING', 'UNKNOWN', 'REVIEW'] } } })
  if (openedAttempt) return res.status(409).json({ message: 'An M-Pesa request still needs a confirmed result for this invoice. Check its status before sending another.' })
  const merchantCode = settings.merchantType === 'TILL' ? settings.tillNumber : settings.paybillNumber
  if (!merchantCode) return res.status(409).json({ message: 'The configured Till or Paybill number is missing.' })
  const credentials = { username: decryptEmailSecret(settings.stkUsernameCiphertext), secretKey: decryptEmailSecret(settings.stkSecretCiphertext) }
  let attempt: Awaited<ReturnType<typeof prisma.invoicePaymentAttempt.create>>
  try {
    attempt = await prisma.invoicePaymentAttempt.create({ data: {
      organisationId, invoiceId: invoice.id, requestedBy: user.id, idempotencyKey, merchantType: settings.merchantType,
      merchantCode, invoiceNumber: invoice.invoiceNumber, phone, amount, currency: invoice.currency,
      gatewayUsernameCiphertext: settings.stkUsernameCiphertext, gatewaySecretCiphertext: settings.stkSecretCiphertext,
      statusDescription: 'Starting the secure M-Pesa prompt.',
    } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'An M-Pesa request is already being started for this invoice. Refresh its payment history before retrying.' })
    throw error
  }
  try {
    // NCBA Till merchants route through bank Paybill 880100, with their Till as AccountNo.
    // A Paybill merchant routes to its shortcode and uses the invoice number as BillRef.
    const provider = await initiateMerchantStkPush({ credentials, telephone: phone, amount,
      paybillNumber: settings.merchantType === 'TILL' ? '880100' : merchantCode,
      accountNo: settings.merchantType === 'TILL' ? merchantCode : invoice.invoiceNumber,
    })
    const updated = await prisma.invoicePaymentAttempt.update({ where: { id: attempt.id }, data: { transactionId: provider.TransactionID, providerReference: provider.ReferenceID, statusDescription: provider.StatusDescription || 'Approve the M-Pesa prompt on the customer’s phone.' } })
    return res.status(201).json({ payment: { id: updated.id, amount: Number(updated.amount), currency: updated.currency, status: updated.status, statusDescription: updated.statusDescription, queryable: Boolean(updated.transactionId), phone: `${updated.phone.slice(0, 5)}••••${updated.phone.slice(-2)}` } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'NCBA could not start this payment.'
    const ambiguous = error instanceof NcbaMerchantRequestError && error.ambiguous
    await prisma.invoicePaymentAttempt.update({ where: { id: attempt.id }, data: { status: ambiguous ? 'UNKNOWN' : 'FAILED', statusDescription: message, completedAt: ambiguous ? null : new Date() } })
    return res.status(ambiguous ? 202 : 502).json({ message, ...(ambiguous ? { payment: { id: attempt.id, amount: Number(attempt.amount), currency: attempt.currency, status: 'UNKNOWN', statusDescription: message, queryable: false, phone: `${attempt.phone.slice(0, 5)}••••${attempt.phone.slice(-2)}` } } : {}) })
  }
})

app.get('/api/invoices/:id/mpesa/attempts', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId }, select: { id: true } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  let attempts = await prisma.invoicePaymentAttempt.findMany({
    where: { invoiceId: invoice.id, organisationId }, orderBy: { createdAt: 'desc' }, take: 20,
    select: { id: true, merchantType: true, phone: true, amount: true, currency: true, status: true, statusDescription: true, transactionId: true, providerReference: true, createdAt: true, completedAt: true },
  })
  const unresolved = attempts.find((attempt) => ['PENDING', 'UNKNOWN'].includes(attempt.status))
  if (unresolved) {
    await refreshCustomerMpesaAttempt(await prisma.invoicePaymentAttempt.findUnique({ where: { id: unresolved.id } }))
    attempts = await prisma.invoicePaymentAttempt.findMany({
      where: { invoiceId: invoice.id, organisationId }, orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, merchantType: true, phone: true, amount: true, currency: true, status: true, statusDescription: true, transactionId: true, providerReference: true, createdAt: true, completedAt: true },
    })
  }
  return res.json({ attempts: attempts.map((attempt) => ({ ...attempt, phone: `${attempt.phone.slice(0, 5)}••••${attempt.phone.slice(-2)}`, amount: Number(attempt.amount) })) })
})

app.get('/api/invoices/:id/mpesa/attempts/:attemptId', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(404).json({ message: 'Payment request was not found.' })
  const attempt = await prisma.invoicePaymentAttempt.findFirst({ where: { id: String(req.params.attemptId), invoiceId: String(req.params.id), organisationId } })
  if (!attempt) return res.status(404).json({ message: 'Payment request was not found.' })
  const updated = await refreshCustomerMpesaAttempt(attempt)
  return res.json({ payment: { id: updated?.id, status: updated?.status, statusDescription: updated?.statusDescription, amount: Number(updated?.amount ?? 0), currency: updated?.currency ?? 'KES', paidAt: updated?.completedAt, queryable: Boolean(updated?.transactionId), phone: `${attempt.phone.slice(0, 5)}••••${attempt.phone.slice(-2)}` } })
})

app.get('/api/invoices/:id/payments', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })

  const payments = await listInvoiceAllocatedPayments(prisma, invoice.id, organisationId)
  res.json({ payments })
})

// ---- Receipt delivery: email a payment receipt to the customer ----

app.post('/api/payments/:paymentId/send-receipt', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const paymentId = String(req.params.paymentId ?? '')
  const recipientEmail = String(req.body?.recipientEmail ?? '').trim().toLowerCase()
  const recipientName = String(req.body?.recipientName ?? '').trim() || null
  const customMessage = req.body?.message ? String(req.body.message).trim() : null

  if (!recipientEmail) return res.status(400).json({ message: 'Recipient email is required.' })
  if (!isValidEmail(recipientEmail)) return res.status(400).json({ message: 'Enter a valid email address.' })

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, organisationId },
    include: {
      invoice: { select: { invoiceNumber: true, customer: { select: { id: true, name: true, email: true, phone: true } } } },
      organisation: { select: { id: true, name: true, currency: true } },
    },
  })
  if (!payment) return res.status(404).json({ message: 'Payment not found.' })

  // Create delivery record
  const delivery = await prisma.receiptDelivery.create({
    data: {
      paymentId: payment.id,
      organisationId,
      recipientEmail,
      recipientName,
      status: 'PENDING',
    },
  })

  try {
    const result = await sendEmail(
      recipientEmail,
      emailSubjects.receiptDelivery(payment.organisation.name ?? 'iQuote', payment.receiptNumber),
      receiptDeliveryEmailHtml({
        recipientName: recipientName ?? payment.invoice.customer.name,
        businessName: payment.organisation.name ?? 'iQuote',
        receiptNumber: payment.receiptNumber,
        invoiceNumber: payment.invoice.invoiceNumber,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        paymentDate: payment.paymentDate.toISOString(),
        customMessage,
      }),
      `receipt-delivery/${delivery.id}`,
      payment.organisationId,
    )

    const now = new Date()
    await prisma.receiptDelivery.update({
      where: { id: delivery.id },
      data: {
        status: result !== false ? 'SENT' : 'FAILED',
        providerMessageId: result !== false ? (result.messageId ?? null) : null,
        sentAt: result !== false ? now : null,
        errorMessage: result === false ? 'Email provider is not configured. Set RESEND_API_KEY and a verified sender address.' : null,
      },
    })

    if (result === false) {
      return res.status(502).json({ message: 'Email provider is not configured. Set RESEND_API_KEY and a verified sender address to send receipts by email.', deliveryId: delivery.id })
    }

    res.json({
      delivery: {
        id: delivery.id,
        recipientEmail,
        recipientName,
        status: 'SENT',
        providerMessageId: result.messageId ?? null,
        sentAt: now.toISOString(),
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Receipt delivery failed.'
    await prisma.receiptDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', errorMessage },
    })
    res.status(502).json({ message: errorMessage, deliveryId: delivery.id })
  }
})

app.get('/api/payments/:paymentId/deliveries', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const paymentId = String(req.params.paymentId ?? '')
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, organisationId }, select: { id: true } })
  if (!payment) return res.status(404).json({ message: 'Payment not found.' })

  const deliveries = await prisma.receiptDelivery.findMany({
    where: { paymentId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, recipientEmail: true, recipientName: true, status: true, providerMessageId: true, errorMessage: true, sentAt: true, createdAt: true },
  })
  res.json({ deliveries })
})

app.get('/api/export/workspace.json', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const [organisation, members, customers, quotes, jobs, invoices, paymentAttempts, serviceItems, quoteTemplates, subscription, emailSettings] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: organisationId }, select: { id: true, name: true, email: true, phone: true, country: true, businessType: true, currency: true, defaultTaxRate: true, quotePrefix: true, logoUrl: true, logoWidth: true, logoHeight: true, website: true, paymentInstructions: true, terms: true, createdAt: true, updatedAt: true } }),
    prisma.user.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, role: true, teamRole: true, emailVerifiedAt: true, createdAt: true } }),
    prisma.customer.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, phone: true, email: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    prisma.quote.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, documentNumber: true, status: true, currency: true, validUntil: true, notes: true, terms: true, subtotal: true, taxTotal: true, total: true, viewedAt: true, decisionComment: true, decidedAt: true, tokenRevokedAt: true, version: true, parentQuoteId: true, createdAt: true, updatedAt: true, customerId: true, lines: { orderBy: { position: 'asc' }, select: { id: true, description: true, quantity: true, unit: true, unitPrice: true, taxRate: true, position: true } } } }),
    prisma.job.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, quoteId: true, ownerId: true, owner: { select: { id: true, name: true, email: true } }, customerId: true, title: true, description: true, status: true, currency: true, startDate: true, endDate: true, acceptedQuoteSnapshot: true, createdAt: true, updatedAt: true, milestones: { orderBy: { position: 'asc' }, select: { id: true, title: true, description: true, dueDate: true, completedAt: true, position: true, customerVisible: true, createdAt: true } }, costs: { orderBy: { incurredAt: 'asc' }, select: { id: true, category: true, description: true, amount: true, currency: true, incurredBy: true, incurredAt: true, createdAt: true } }, activities: { orderBy: { createdAt: 'asc' }, select: { id: true, actorId: true, actorName: true, action: true, details: true, createdAt: true } }, attachments: { orderBy: { createdAt: 'asc' }, select: { id: true, originalFilename: true, mimeType: true, sizeBytes: true, uploadedBy: true, uploaderName: true, createdAt: true } } } }),
    prisma.invoice.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, jobId: true, sourceQuoteId: true, lineItems: true, customerId: true, invoiceNumber: true, status: true, currency: true, subtotal: true, taxTotal: true, total: true, amountPaid: true, balanceDue: true, depositRequired: true, depositPaid: true, sentAt: true, issueDate: true, dueDate: true, notes: true, createdAt: true, updatedAt: true, payments: { orderBy: { paymentDate: 'asc' }, select: { id: true, amount: true, currency: true, method: true, reference: true, isDeposit: true, paymentDate: true, receivedBy: true, createdAt: true, refunds: { select: { id: true, amount: true, currency: true, method: true, reference: true, reason: true, refundedAt: true, recordedByName: true, createdAt: true } }, receiptDeliveries: { orderBy: { createdAt: 'asc' }, select: { id: true, recipientEmail: true, recipientName: true, status: true, providerMessageId: true, errorMessage: true, sentAt: true, createdAt: true } } } }, paymentAllocations: { orderBy: { createdAt: 'asc' }, select: { id: true, paymentId: true, eventType: true, amount: true, currency: true, idempotencyKey: true, reason: true, actorId: true, actorName: true, createdAt: true } }, reconciliations: { orderBy: { createdAt: 'asc' }, select: { id: true, actorId: true, actorName: true, reason: true, previousAmountPaid: true, previousBalanceDue: true, correctedAmountPaid: true, correctedBalanceDue: true, createdAt: true } } } }),
    prisma.invoicePaymentAttempt.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, invoiceId: true, requestedBy: true, provider: true, merchantType: true, merchantCode: true, invoiceNumber: true, transactionId: true, providerReference: true, phone: true, amount: true, currency: true, status: true, statusDescription: true, createdAt: true, updatedAt: true, completedAt: true } }),
    prisma.serviceItem.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, category: true, kind: true, description: true, unit: true, defaultPrice: true, defaultTaxRate: true, active: true, isStarter: true, createdAt: true, updatedAt: true } }),
    prisma.quoteTemplate.findMany({ where: { organisationId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, description: true, workflow: true, lineItems: true, defaultNotes: true, defaultTerms: true, isStarter: true, version: true, createdAt: true, updatedAt: true } }),
    prisma.subscription.findUnique({ where: { organisationId }, select: { plan: true, status: true, billingInterval: true, trialStartedAt: true, trialEndsAt: true, simulated: true, createdAt: true, updatedAt: true } }),
    prisma.tenantEmailSettings.findUnique({ where: { organisationId }, select: { provider: true, senderName: true, senderEmail: true, customDomain: true, domainStatus: true, domainRecords: true, verifiedAt: true, createdAt: true, updatedAt: true } }),
  ])

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="iquote-workspace-export-${new Date().toISOString().slice(0, 10)}.json"`)
  return res.json({ exportedAt: new Date().toISOString(), formatVersion: 2, organisation, members, customers, quotes, jobs, invoices: invoices.map((invoice) => ({ ...invoice, depositRequired: invoice.depositRequired ? Number(invoice.depositRequired) : null, depositPaid: Number(invoice.depositPaid), subtotal: Number(invoice.subtotal), taxTotal: Number(invoice.taxTotal), total: Number(invoice.total), amountPaid: Number(invoice.amountPaid), balanceDue: Number(invoice.balanceDue), payments: invoice.payments.map((payment) => ({ ...payment, receiptNumber: `RCP-${payment.id.toUpperCase()}`, amount: Number(payment.amount), isDeposit: payment.isDeposit ?? false, refunds: payment.refunds.map((refund) => ({ ...refund, amount: Number(refund.amount) })), receiptDeliveries: payment.receiptDeliveries ?? [] })), paymentAllocations: invoice.paymentAllocations.map((allocation) => ({ ...allocation, amount: Number(allocation.amount) })) })), paymentAttempts: paymentAttempts.map((attempt) => ({ ...attempt, amount: Number(attempt.amount) })), serviceItems, quoteTemplates, subscription, emailSettings })
})

// ---- Retention policy: workspace data deletion (owner-only, irreversible) ----
// Retention policy: workspace data is retained for the lifetime of the workspace.
// An owner may export all data (GET /api/export/workspace.json) before requesting deletion.
// Deletion is irreversible and removes all customers, quotes, jobs, invoices, payments,
// and financial records. The workspace itself and user accounts are preserved so the
// owner can reconfigure. This endpoint requires a typed confirmation string.

app.delete('/api/export/workspace.json', requireTeamRole('OWNER'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const confirmation = String(req.body?.confirmation ?? '').trim()
  if (confirmation !== 'DELETE ALL DATA') {
    return res.status(400).json({ message: 'Type "DELETE ALL DATA" to confirm. This action is irreversible.' })
  }

  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { name: true } })
  if (!org) return res.status(404).json({ message: 'Workspace not found.' })

  // Delete in dependency order to respect FK constraints
  // Payment allocations, refunds, receipt deliveries, reconciliation records first,
  // then payments, invoice payment attempts, invoices, job costs/activities/attachments/milestones,
  // jobs, quote deliveries/messages, quote lines, quotes, customers, service items, templates
  await prisma.$transaction(async (tx) => {
    // Financial records
    await tx.paymentAllocation.deleteMany({ where: { organisationId } })
    await tx.paymentRefund.deleteMany({ where: { organisationId } })
    await tx.receiptDelivery.deleteMany({ where: { organisationId } })
    await tx.invoiceReconciliation.deleteMany({ where: { organisationId } })
    await tx.invoicePaymentAttempt.deleteMany({ where: { organisationId } })
    // Payments reference invoices, invoices reference jobs/customers
    const invoiceIds = await tx.invoice.findMany({ where: { organisationId }, select: { id: true } })
    if (invoiceIds.length) {
      await tx.payment.deleteMany({ where: { invoiceId: { in: invoiceIds.map((i) => i.id) } } })
    }
    await tx.invoice.deleteMany({ where: { organisationId } })
    // Job-related records
    const jobIds = await tx.job.findMany({ where: { organisationId }, select: { id: true } })
    if (jobIds.length) {
      const jobIdList = jobIds.map((j) => j.id)
      await tx.jobCost.deleteMany({ where: { jobId: { in: jobIdList } } })
      await tx.jobActivity.deleteMany({ where: { jobId: { in: jobIdList } } })
      await tx.jobAttachment.deleteMany({ where: { jobId: { in: jobIdList } } })
      await tx.jobMilestone.deleteMany({ where: { jobId: { in: jobIdList } } })
    }
    await tx.job.deleteMany({ where: { organisationId } })
    // Quote-related records
    const quoteIds = await tx.quote.findMany({ where: { organisationId }, select: { id: true } })
    if (quoteIds.length) {
      const quoteIdList = quoteIds.map((q) => q.id)
      await tx.quoteDelivery.deleteMany({ where: { quoteId: { in: quoteIdList } } })
      await tx.quoteMessage.deleteMany({ where: { quoteId: { in: quoteIdList } } })
      await tx.quoteLine.deleteMany({ where: { quoteId: { in: quoteIdList } } })
      await tx.notification.deleteMany({ where: { quoteId: { in: quoteIdList } } })
    }
    await tx.notification.deleteMany({ where: { organisationId } })
    await tx.quoteMessage.deleteMany({ where: { organisationId } })
    await tx.quote.deleteMany({ where: { organisationId } })
    await tx.customer.deleteMany({ where: { organisationId } })
    await tx.serviceItem.deleteMany({ where: { organisationId } })
    await tx.quoteTemplate.deleteMany({ where: { organisationId } })
    await tx.teamInvitation.deleteMany({ where: { organisationId } })
    // Reset subscription to trial state
    await tx.subscription.updateMany({ where: { organisationId }, data: { status: 'TRIALING', simulated: true, currentPeriodEndsAt: null } })
  })

  // Record audit event
  await prisma.superadminAuditEvent.create({
    data: {
      actorEmail: user.email,
      action: 'WORKSPACE_DATA_DELETED',
      targetType: 'Organisation',
      targetId: organisationId,
      summary: `Owner ${user.email} deleted all business data for workspace "${org.name}".`,
      metadata: { confirmation } as never,
    },
  }).catch(() => {})

  res.json({ deleted: true, message: 'All workspace business data has been deleted. User accounts and workspace settings are preserved.' })
})

// ---- Retention policy info ----
app.get('/api/settings/retention', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const [customerCount, quoteCount, jobCount, invoiceCount, paymentCount] = await Promise.all([
    prisma.customer.count({ where: { organisationId } }),
    prisma.quote.count({ where: { organisationId } }),
    prisma.job.count({ where: { organisationId } }),
    prisma.invoice.count({ where: { organisationId } }),
    prisma.payment.count({ where: { organisationId } }),
  ])

  res.json({
    policy: {
      retentionPeriod: 'Lifetime of workspace',
      description: 'Business data is retained for as long as the workspace is active. Owners can export all data at any time via the export endpoint and request complete deletion of business records. User accounts and workspace configuration are preserved after deletion.',
      exportAvailable: true,
      deletionAvailable: true,
      deletionRequiresConfirmation: 'DELETE ALL DATA',
    },
    recordCounts: { customers: customerCount, quotes: quoteCount, jobs: jobCount, invoices: invoiceCount, payments: paymentCount },
  })
})

// ---- Stage 15: Team membership and invitations ----

app.get('/api/team', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const members = await prisma.user.findMany({
    where: { organisationId },
    select: { id: true, name: true, email: true, teamRole: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const invitations = await prisma.teamInvitation.findMany({
    where: { organisationId, revokedAt: null, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ members, invitations })
})

app.post('/api/team/invitations', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const role = String(req.body?.role ?? 'MEMBER').toUpperCase()
  if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' })
  if (!['ADMIN', 'MEMBER'].includes(role)) return res.status(400).json({ message: 'Invite role must be ADMIN or MEMBER.' })

  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser?.organisationId === organisationId) {
    return res.status(409).json({ message: 'This user is already a member of your workspace.' })
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  try {
    const invitation = await prisma.teamInvitation.create({
      data: { organisationId, email, role: role as never, token, invitedBy: user.id, expiresAt },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    })
    res.status(201).json({ invitation })
  } catch {
    res.status(409).json({ message: 'An active invitation already exists for this email.' })
  }
})

app.post('/api/team/invitations/:id/revoke', requireTeamRole('OWNER', 'ADMIN'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invitation = await prisma.teamInvitation.findFirst({
    where: { id: String(req.params.id ?? ''), organisationId, revokedAt: null, acceptedAt: null },
  })
  if (!invitation) return res.status(404).json({ message: 'Invitation not found.' })

  const revoked = await prisma.teamInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
    select: { id: true, email: true, role: true, revokedAt: true },
  })
  res.json({ invitation: revoked })
})

app.post('/api/team/members/:id/role', requireTeamRole('OWNER'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const memberId = String(req.params.id ?? '')
  const role = String(req.body?.role ?? '').toUpperCase()
  if (!['OWNER', 'ADMIN', 'MEMBER'].includes(role)) return res.status(400).json({ message: 'Invalid team role.' })

  const member = await prisma.user.findFirst({ where: { id: memberId, organisationId } })
  if (!member) return res.status(404).json({ message: 'Team member not found.' })
  if (member.id === user.id) return res.status(409).json({ message: 'You cannot change your own role.' })

  const updated = await prisma.user.update({
    where: { id: member.id },
    data: { teamRole: role as never },
    select: { id: true, name: true, email: true, teamRole: true },
  })
  res.json({ member: updated })
})

app.delete('/api/team/members/:id', requireTeamRole('OWNER'), async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const memberId = String(req.params.id ?? '')
  const member = await prisma.user.findFirst({ where: { id: memberId, organisationId } })
  if (!member) return res.status(404).json({ message: 'Team member not found.' })
  if (member.id === user.id) return res.status(409).json({ message: 'You cannot remove yourself.' })

  await prisma.user.update({ where: { id: member.id }, data: { organisationId: null } })
  res.json({ success: true })
})

// ---- Stage 15: Superadmin MFA ----

app.get('/api/superadmin/mfa/setup', async (req, res) => {
  const token = readTokenFromRequest(req)
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const user = await loadUserFromToken(token)
  if (!user || user.role !== 'SUPERADMIN') return res.status(403).json({ message: 'Superadmin access required.' })

  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!existing) return res.status(404).json({ message: 'User not found.' })
  if (existing.mfaEnabled) return res.status(409).json({ message: 'MFA is already enabled.' })

  const secret = existing.mfaSecret ? decryptMfaSecret(existing.mfaSecret) : generateSecret()
  const otpauth = generateURI({ label: user.email, issuer: 'iQuote', secret })
  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mfaSecret: encryptMfaSecret(secret) } })
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_SETUP_STARTED', 'USER', user.id, 'Authenticator setup was started.', undefined, transaction)
  })
  res.json({ secret, otpauth })
})

app.post('/api/superadmin/mfa/verify', async (req, res) => {
  const token = readTokenFromRequest(req)
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const user = await loadUserFromToken(token)
  if (!user || user.role !== 'SUPERADMIN') return res.status(403).json({ message: 'Superadmin access required.' })

  const code = String(req.body?.code ?? '').trim()
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!existing?.mfaSecret) return res.status(409).json({ message: 'Set up MFA first.' })
  if (existing.mfaEnabled) return res.status(409).json({ message: 'MFA is already enabled. Use the login verification step.' })

  const secret = decryptMfaSecret(existing.mfaSecret)
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const rateLimitKey = `admin-mfa-setup:${user.email}:${ip}`
  const rateCheck = await checkLoginRateLimit(rateLimitKey)
  if (!rateCheck.allowed) return res.status(429).json({ message: 'Too many incorrect setup codes. Try again later.' })
  const valid = verifySync({ token: code, secret })
  if (!valid) {
    await recordFailedLogin(rateLimitKey)
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_ENROLLMENT_FAILED', 'USER', user.id, 'A super-admin authenticator enrollment code was rejected.')
    return res.status(400).json({ message: 'Invalid verification code.' })
  }
  await clearLoginAttempts(rateLimitKey)
  const currentSession = await prisma.session.findFirst({ where: { token: hashToken(token), userId: user.id, expiresAt: { gt: new Date() } }, select: { id: true } })
  if (!currentSession) return res.status(401).json({ message: 'Session expired. Sign in again.' })

  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mfaSecret: encryptMfaSecret(secret), mfaEnabled: true, mfaEnabledAt: new Date() } })
    await transaction.session.deleteMany({ where: { userId: user.id, id: { not: currentSession.id } } })
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_ENABLED', 'USER', user.id, 'Authenticator protection was enabled.', undefined, transaction)
  })
  await markSessionMfaVerified(token)
  res.json({ success: true })
})

app.post('/api/superadmin/mfa/disable', requireSuperadmin, async (req, res) => {
  return res.status(409).json({ message: 'MFA is required for super-admin accounts. Use the recovery process if you have lost your authenticator.' })
})

// ---- Stage 15: Tenant reports ----

app.get('/api/reports', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const [allQuotes, allCustomers, allJobs, allInvoices] = await Promise.all([
    prisma.quote.findMany({ where: { organisationId }, include: { customer: { select: { id: true, name: true } }, deliveries: { select: { status: true } } } }),
    prisma.customer.findMany({ where: { organisationId, archivedAt: null }, select: { id: true, name: true, createdAt: true } }),
    prisma.job.findMany({ where: { organisationId }, include: { costs: true, quote: { select: { total: true, currency: true } }, invoices: { select: { total: true, amountPaid: true, currency: true } } } }),
    prisma.invoice.findMany({ where: { organisationId }, select: { status: true, total: true, amountPaid: true, balanceDue: true, currency: true } }),
  ])

  // Quote funnel
  const funnel = {
    sent: allQuotes.filter((q) => q.status === 'SENT' || q.status === 'VIEWED' || q.status === 'APPROVED' || q.status === 'DECLINED').length,
    viewed: allQuotes.filter((q) => q.status === 'VIEWED' || q.status === 'APPROVED' || q.status === 'DECLINED').length,
    approved: allQuotes.filter((q) => q.status === 'APPROVED').length,
    declined: allQuotes.filter((q) => q.status === 'DECLINED').length,
  }

  // Repeat customers (customers with more than one approved quote)
  const customerQuoteCounts = new Map<string, number>()
  for (const quote of allQuotes.filter((q) => q.status === 'APPROVED')) {
    customerQuoteCounts.set(quote.customerId, (customerQuoteCounts.get(quote.customerId) ?? 0) + 1)
  }
  const repeatCustomers = allCustomers.filter((c) => (customerQuoteCounts.get(c.id) ?? 0) > 1).map((c) => ({
    id: c.id,
    name: c.name,
    approvedQuotes: customerQuoteCounts.get(c.id) ?? 0,
  }))

  // Revenue by currency
  const revenueByCurrency = new Map<string, { totalInvoiced: number; totalPaid: number; totalDue: number }>()
  for (const invoice of allInvoices) {
    const currency = invoice.currency
    const entry = revenueByCurrency.get(currency) ?? { totalInvoiced: 0, totalPaid: 0, totalDue: 0 }
    entry.totalInvoiced += Number(invoice.total)
    entry.totalPaid += Number(invoice.amountPaid)
    entry.totalDue += Number(invoice.balanceDue)
    revenueByCurrency.set(currency, entry)
  }

  // Job profitability
  const jobProfitability = allJobs.flatMap((job) => {
    const quoteCurrency = job.quote?.currency ?? job.currency
    const currencies = new Set([job.currency, quoteCurrency, ...job.costs.map((cost) => cost.currency), ...job.invoices.map((invoice) => invoice.currency)])
    const costsUseQuoteCurrency = job.costs.every((cost) => cost.currency === quoteCurrency)
    return [...currencies].map((currency) => {
      const estimated = currency === quoteCurrency && job.quote?.total ? Number(job.quote.total) : 0
      const actualCosts = job.costs.filter((cost) => cost.currency === currency).reduce((sum, cost) => sum + Number(cost.amount), 0)
      const invoiced = job.invoices.filter((invoice) => invoice.currency === currency).reduce((sum, invoice) => sum + Number(invoice.total), 0)
      const collected = job.invoices.filter((invoice) => invoice.currency === currency).reduce((sum, invoice) => sum + Number(invoice.amountPaid), 0)
      const margin = currency === quoteCurrency && Boolean(job.quote) && costsUseQuoteCurrency ? roundMoney(estimated - actualCosts) : null
      return { id: `${job.id}:${currency}`, title: job.title, currency, estimated, actualCosts, invoiced, collected, margin }
    })
  })

  res.json({
    funnel,
    repeatCustomers,
    revenueByCurrency: Object.fromEntries(revenueByCurrency),
    jobProfitability,
  })
})

// ---- 404 handler (catches all unmatched routes) ----
app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: 'This endpoint does not exist.' })
})

// ---- Global error handler ----
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Don't leak internal error details in production
  const isDev = process.env.NODE_ENV !== 'production'
  console.error(`[error] ${err.message}`)
  if (isDev) console.error(err.stack)

  // Prisma known errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'A record with that value already exists.' })
    if (err.code === 'P2025') return res.status(404).json({ message: 'Record not found.' })
  }

  res.status(500).json({
    message: isDev ? err.message : 'Something went wrong on our end. Please try again.',
  })
})

export { app, prisma, issueSession, hashToken, checkLoginRateLimit, recordFailedLogin, clearLoginAttempts }

// Start the server only when this file is the entry point (not when imported by tests)
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.includes('src/index') || process.argv[1]?.includes('dist/index')
if (isMainModule) {
  void hydratePlatformNcbaConfig().catch((error: unknown) => console.error('[billing] Could not load saved NCBA configuration:', error instanceof Error ? error.message : 'unknown error')).finally(() => {
    app.listen(port, () => {
      console.log(`iQuote API listening on http://localhost:${port}`)
    })
  })
}
