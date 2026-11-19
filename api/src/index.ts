import 'dotenv/config'
import pkg from '@prisma/client'
import type { Prisma as PrismaTypes } from '@prisma/client'
const { PrismaClient, Prisma } = pkg
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { generateSecret, generateURI, verifySync } from 'otplib'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { getIndustryPack } from './industry-packs.js'
import { verificationEmailHtml, welcomeEmailHtml, quoteDecisionEmailHtml, quoteDeliveryEmailHtml, emailSubjects } from './email-templates.js'

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

function toPublicUser(user: { id: string; name: string; email: string; role?: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role ?? 'USER',
  }
}

function getRequestUser(req: Request) {
  return (req as Request & { user?: { id: string; name: string; email: string; role?: string } }).user
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

type SendEmailResult = { success: true; messageId: string | null }

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  idempotencyKey: string,
  organisationId?: string,
  attachments?: Array<{ filename: string; content: string }>,
  cc?: string[] | string,
): Promise<SendEmailResult | false> {
  const tenantSettings = organisationId ? await prisma.tenantEmailSettings.findUnique({ where: { organisationId } }) : null
  const tenantKey = tenantSettings?.provider === 'CUSTOM' && tenantSettings.resendApiKeyCiphertext ? decryptEmailSecret(tenantSettings.resendApiKeyCiphertext) : null
  const apiKey = tenantKey ?? process.env.RESEND_API_KEY
  const senderEmail = platformSenderEmail()
  const from = tenantKey && tenantSettings?.senderEmail
    ? `${tenantSettings.senderName || 'iQuote'} <${tenantSettings.senderEmail}>`
    : senderEmail ? `${platformSenderName()} <${senderEmail}>` : ''
  if (!apiKey || !from) return false

  const replyTo = process.env.SUPPORT_EMAIL ?? undefined

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
      select: { id: true, name: true, email: true, role: true },
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
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } })
  if (!account?.mfaEnabled) return true
  const session = await prisma.session.findFirst({ where: { token: hashToken(token), expiresAt: { gt: new Date() } }, select: { mfaVerifiedAt: true } })
  return Boolean(session?.mfaVerifiedAt)
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
    select: { name: true, subdomain: true, logoUrl: true, country: true, currency: true },
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
        currency: ({ Kenya: 'KES', Uganda: 'UGX', Tanzania: 'TZS', Rwanda: 'RWF', 'United Kingdom': 'GBP', 'United States': 'USD' } as Record<string, string>)[country] ?? 'USD',
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
  const token = await issueSession(user.id, user.role !== 'SUPERADMIN' || !user.mfaEnabled)
  sendSessionCookie(res, token)

  res.json({ user: toPublicUser(user), mfaRequired: user.role === 'SUPERADMIN' && user.mfaEnabled })
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
  if (!verifySync({ token: code, secret: account.mfaSecret })) {
    await recordFailedLogin(rateLimitKey)
    return res.status(401).json({ message: 'That authenticator code is invalid. Try again.' })
  }
  await clearLoginAttempts(rateLimitKey)
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
      include: { customer: { select: { id: true, name: true, phone: true, email: true } }, lines: { orderBy: { position: 'asc' } } },
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
      organisation: { select: { id: true, name: true, currency: true, logoUrl: true } },
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
      organisation: { select: { id: true, name: true, currency: true } },
      lines: { orderBy: { position: 'asc' } },
    },
  })
  if (!quote) return res.status(404).json({ message: 'Quote not found.' })

  const recipientEmail = String(req.body?.recipientEmail ?? '').trim().toLowerCase()
  const recipientName = String(req.body?.recipientName ?? '').trim() || null
  const message = String(req.body?.message ?? '').trim() || null

  if (!recipientEmail) return res.status(400).json({ message: 'Recipient email is required.' })
  if (!isValidEmail(recipientEmail)) return res.status(400).json({ message: 'Enter a valid email address.' })

  // Regenerate token for resend
  const publicToken = randomBytes(24).toString('base64url')
  const now = new Date()

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
      organisation: { select: { name: true, email: true, phone: true, country: true, currency: true, logoUrl: true, website: true, paymentInstructions: true } },
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
    data: { status: nextStatus, decisionComment: String(req.body?.comment ?? '').trim() || null, decidedAt },
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
  const rawLogoUrl = String(req.body?.logoUrl ?? '').trim()
  const logoUrl = rawLogoUrl.startsWith('/uploads/') ? rawLogoUrl.slice(0, 200) : null
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
      await prisma.organisation.update({ where: { id: organisationId }, data: { logoUrl } })

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

  await prisma.organisation.update({ where: { id: organisationId }, data: { logoUrl: null } })
  res.json({ success: true })
})

// ---- Superadmin routes ----
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
    (prisma as any).superadminAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset, select: { id: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, metadata: true, ipAddress: true, userAgent: true, createdAt: true } }),
    (prisma as any).superadminAuditEvent.count({ where }),
  ])
  res.json({ events, totalCount, hasMore: offset + limit < totalCount })
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

  // Replay protection: check if we already processed this event
  try {
    await prisma.webhookEvent.create({
      data: {
        source: 'resend',
        eventId,
        eventType,
        payload: payload as object,
      },
    })
  } catch {
    // Unique constraint violation — already processed
    return res.status(200).json({ message: 'Event already processed.' })
  }

  // Find the email_id from the payload to match a delivery
  const emailId = payload.data?.email_id
  if (!emailId) {
    // No email_id to match — acknowledge but don't fail
    return res.status(200).json({ message: 'Event received (no email_id).' })
  }

  // Find the delivery by providerMessageId
  const delivery = await prisma.quoteDelivery.findFirst({
    where: { providerMessageId: emailId },
  })

  if (!delivery) {
    return res.status(200).json({ message: 'Event received (no matching delivery).' })
  }

  const now = new Date()

  // Map event types to delivery status updates
  switch (eventType) {
    case 'email.sent':
      if (delivery.status === 'PENDING') {
        await prisma.quoteDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SENT', sentAt: delivery.sentAt ?? now },
        })
      }
      break
    case 'email.delivered':
      await prisma.quoteDelivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', deliveredAt: now },
      })
      break
    case 'email.bounced':
      await prisma.quoteDelivery.update({
        where: { id: delivery.id },
        data: { status: 'BOUNCED', bouncedAt: now, errorMessage: 'Email bounced.' },
      })
      break
    case 'email.complained':
      // Complaint doesn't change delivery status but we could log it
      break
    default:
      // Unknown event type — acknowledge
      break
  }

  res.status(200).json({ message: 'Event processed.' })
})

// ---- Stage 14: Jobs ----

const VALID_JOB_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'CANCELLED']
const VALID_COST_CATEGORIES = ['MATERIALS', 'LABOR', 'SUPPLIER', 'TRANSPORT', 'OTHER']
const VALID_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CARD', 'OTHER']
const VALID_INVOICE_STATUSES = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']

function serializeJob(job: any) {
  return {
    ...job,
    costs: Array.isArray(job.costs) ? job.costs.map((c: any) => ({ ...c, amount: Number(c.amount) })) : job.costs,
  }
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
  const startDate = req.body?.startDate ? new Date(req.body.startDate) : null
  const endDate = req.body?.endDate ? new Date(req.body.endDate) : null

  if (!title) return res.status(400).json({ message: 'Job title is required.' })
  if (!VALID_JOB_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid job status.' })

  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!customer) return res.status(400).json({ message: 'Choose a valid customer for this job.' })

  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { currency: true } })
  const currency = organisation?.currency ?? 'KES'

  let acceptedQuoteSnapshot: unknown = null
  let validatedQuoteId: string | null = null

  if (quoteId) {
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
      include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { id: true, name: true } } },
    })
    if (!quote) return res.status(404).json({ message: 'Quote not found.' })
    if (quote.status !== 'APPROVED') return res.status(409).json({ message: 'Only approved quotes can be converted to jobs.' })

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
  }

  const job = await prisma.job.create({
    data: {
      organisationId,
      quoteId: validatedQuoteId,
      ownerId: user.id,
      customerId,
      title,
      description,
      status: status as never,
      currency,
      startDate: startDate && !Number.isNaN(startDate.getTime()) ? startDate : null,
      endDate: endDate && !Number.isNaN(endDate.getTime()) ? endDate : null,
      acceptedQuoteSnapshot: acceptedQuoteSnapshot as never,
    },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      milestones: { orderBy: { position: 'asc' } },
    },
  })

  res.status(201).json({ job })
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
      include: { customer: { select: { id: true, name: true } } },
    }),
    prisma.job.count({ where: where as never }),
  ])

  res.json({ jobs, totalCount, hasMore: offset + limit < totalCount })
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
      milestones: { orderBy: { position: 'asc' } },
      costs: { orderBy: { incurredAt: 'desc' } },
      quote: { select: { id: true, documentNumber: true, status: true } },
    },
  })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  res.json({
    job: {
      ...job,
      costs: job.costs.map((c) => ({ ...c, amount: Number(c.amount) })),
    },
  })
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

  if (status && !VALID_JOB_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid job status.' })
  if (title !== undefined && !title) return res.status(400).json({ message: 'Title cannot be empty.' })

  const data: Record<string, unknown> = {}
  if (title !== undefined) data.title = title
  if (description !== undefined) data.description = description
  if (status !== undefined) data.status = status
  if (startDate !== undefined) data.startDate = startDate && !Number.isNaN(startDate.getTime()) ? startDate : null
  if (endDate !== undefined) data.endDate = endDate && !Number.isNaN(endDate.getTime()) ? endDate : null

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: data as never,
    include: { customer: { select: { id: true, name: true } } },
  })
  res.json({ job: updated })
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

  const milestone = await prisma.jobMilestone.create({
    data: {
      jobId: job.id,
      title,
      description,
      dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
      position,
    },
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
  if (req.body?.completed !== undefined) {
    data.completedAt = req.body.completed ? new Date() : null
  }
  if (req.body?.position !== undefined) data.position = Number(req.body.position)

  const updated = await prisma.jobMilestone.update({ where: { id: milestone.id }, data: data as never })
  res.json({ milestone: updated })
})

app.delete('/api/jobs/:id/milestones/:milestoneId', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const job = await prisma.job.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!job) return res.status(404).json({ message: 'Job not found.' })

  const deleted = await prisma.jobMilestone.deleteMany({ where: { id: String(req.params.milestoneId ?? ''), jobId: job.id } })
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

  const cost = await prisma.jobCost.create({
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

app.post('/api/invoices', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const customerId = String(req.body?.customerId ?? '').trim()
  const jobId = req.body?.jobId ? String(req.body.jobId).trim() : null
  const subtotal = Number(req.body?.subtotal ?? 0)
  const taxTotal = Number(req.body?.taxTotal ?? 0)
  const notes = String(req.body?.notes ?? '').trim() || null
  const dueDate = req.body?.dueDate ? new Date(req.body.dueDate) : null

  const customer = await prisma.customer.findFirst({ where: { id: customerId, organisationId } })
  if (!customer) return res.status(400).json({ message: 'Choose a valid customer for this invoice.' })

  let currency = 'KES'
  if (jobId) {
    const job = await prisma.job.findFirst({ where: { id: jobId, organisationId } })
    if (!job) return res.status(404).json({ message: 'Job not found.' })
    currency = job.currency
  } else {
    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { currency: true, quotePrefix: true } })
    currency = org?.currency ?? 'KES'
  }

  if (!Number.isFinite(subtotal) || subtotal < 0) return res.status(400).json({ message: 'Subtotal must be a non-negative number.' })
  if (!Number.isFinite(taxTotal) || taxTotal < 0) return res.status(400).json({ message: 'Tax total must be a non-negative number.' })

  const total = roundMoney(subtotal + taxTotal)
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { quotePrefix: true } })
  const invoiceNumber = await generateInvoiceNumber(organisationId, org?.quotePrefix ?? 'INV')

  const invoice = await prisma.invoice.create({
    data: {
      organisationId,
      jobId,
      customerId,
      invoiceNumber,
      status: 'DRAFT',
      currency,
      subtotal,
      taxTotal,
      total,
      balanceDue: total,
      dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
      notes,
    },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      job: { select: { id: true, title: true } },
    },
  })

  res.status(201).json({ invoice: { ...invoice, subtotal: Number(invoice.subtotal), taxTotal: Number(invoice.taxTotal), total: Number(invoice.total), amountPaid: Number(invoice.amountPaid), balanceDue: Number(invoice.balanceDue) } })
})

app.get('/api/invoices', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const statusFilter = req.query?.status ? String(req.query.status).toUpperCase().split(',') : undefined
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 50), 1), 200)
  const offset = Math.max(Number(req.query?.offset ?? 0), 0)

  const where: Record<string, unknown> = { organisationId }
  if (statusFilter && statusFilter.every((s) => VALID_INVOICE_STATUSES.includes(s))) where.status = { in: statusFilter }

  const [invoices, totalCount] = await Promise.all([
    prisma.invoice.findMany({
      where: where as never,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: { customer: { select: { id: true, name: true } }, job: { select: { id: true, title: true } } },
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
      payments: { orderBy: { paymentDate: 'desc' } },
    },
  })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })

  res.json({
    invoice: {
      ...invoice,
      subtotal: Number(invoice.subtotal),
      taxTotal: Number(invoice.taxTotal),
      total: Number(invoice.total),
      amountPaid: Number(invoice.amountPaid),
      balanceDue: Number(invoice.balanceDue),
      payments: invoice.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    },
  })
})

app.put('/api/invoices/:id', requireAuth, async (req, res) => {
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
  if (status && VALID_INVOICE_STATUSES.includes(status) && status !== 'DRAFT') {
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
    },
  })
})

app.post('/api/invoices/:id/payments', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })
  if (invoice.status === 'CANCELLED') return res.status(409).json({ message: 'Cannot record payments on a cancelled invoice.' })

  const amount = Number(req.body?.amount ?? 0)
  const method = String(req.body?.method ?? '').toUpperCase()
  const reference = req.body?.reference ? String(req.body.reference).trim() : null
  const paymentDate = req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date()

  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Payment amount must be a positive number.' })
  if (!VALID_PAYMENT_METHODS.includes(method)) return res.status(400).json({ message: 'Invalid payment method.' })
  if (paymentDate && Number.isNaN(paymentDate.getTime())) return res.status(400).json({ message: 'Invalid payment date.' })

  // Idempotency: check for duplicate payment within 5-minute window
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
  const existingPayment = await prisma.payment.findFirst({
    where: {
      invoiceId: invoice.id,
      amount,
      method,
      reference: reference ?? undefined,
      paymentDate: { gte: fiveMinutesAgo },
    },
  })
  if (existingPayment) {
    return res.status(409).json({ message: 'A similar payment was already recorded recently. Duplicate payments are not allowed.' })
  }

  // Create payment and update invoice in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        organisationId,
        amount,
        currency: invoice.currency,
        method,
        reference,
        paymentDate: paymentDate && !Number.isNaN(paymentDate.getTime()) ? paymentDate : new Date(),
        receivedBy: user.id,
      },
    })

    const allPayments = await tx.payment.findMany({ where: { invoiceId: invoice.id } })
    const totalPaid = allPayments.reduce((sum, p) => sum + Number(p.amount), 0)
    const invoiceTotal = Number(invoice.total)
    const balanceDue = roundMoney(invoiceTotal - totalPaid)

    let nextStatus: string
    if (totalPaid >= invoiceTotal) {
      nextStatus = 'PAID'
    } else if (totalPaid > 0) {
      nextStatus = 'PARTIALLY_PAID'
    } else {
      nextStatus = invoice.status
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: totalPaid,
        balanceDue,
        status: nextStatus as never,
      },
    })

    return payment
  })

  res.status(201).json({ payment: { ...result, amount: Number(result.amount) } })
})

app.get('/api/invoices/:id/payments', requireAuth, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  const organisationId = await getOrganisationId(user.id)
  if (!organisationId) return res.status(409).json({ message: 'Set up a business workspace first.' })

  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id ?? ''), organisationId } })
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' })

  const payments = await prisma.payment.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { paymentDate: 'desc' },
  })
  res.json({ payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })) })
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

app.get('/api/superadmin/mfa/setup', requireSuperadmin, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!existing) return res.status(404).json({ message: 'User not found.' })
  if (existing.mfaEnabled) return res.status(409).json({ message: 'MFA is already enabled.' })

  const secret = existing.mfaSecret ?? generateSecret()
  const otpauth = generateURI({ label: user.email, issuer: 'iQuote', secret })
  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mfaSecret: secret } })
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_SETUP_STARTED', 'USER', user.id, 'Authenticator setup was started.', undefined, transaction)
  })
  res.json({ secret, otpauth })
})

app.post('/api/superadmin/mfa/verify', requireSuperadmin, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const code = String(req.body?.code ?? '').trim()
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!existing?.mfaSecret) return res.status(409).json({ message: 'Set up MFA first.' })
  if (existing.mfaEnabled) return res.status(409).json({ message: 'MFA is already enabled.' })

  const valid = verifySync({ token: code, secret: existing.mfaSecret })
  if (!valid) return res.status(400).json({ message: 'Invalid verification code.' })

  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mfaEnabled: true } })
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_ENABLED', 'USER', user.id, 'Authenticator protection was enabled.', undefined, transaction)
  })
  const token = readTokenFromRequest(req)
  if (token) await markSessionMfaVerified(token)
  res.json({ success: true })
})

app.post('/api/superadmin/mfa/disable', requireSuperadmin, async (req, res) => {
  const user = getRequestUser(req)
  if (!user) return res.status(401).json({ message: 'Unauthorized' })

  const code = String(req.body?.code ?? '').trim()
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabled: true } })
  if (!existing?.mfaEnabled) return res.status(409).json({ message: 'MFA is not enabled.' })

  const valid = verifySync({ token: code, secret: existing.mfaSecret ?? '' })
  if (!valid) return res.status(400).json({ message: 'Invalid verification code.' })

  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecret: null } })
    await writeSuperadminAudit(req, user, 'SUPERADMIN_MFA_DISABLED', 'USER', user.id, 'Authenticator protection was disabled.', undefined, transaction)
  })
  res.json({ success: true })
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
    prisma.job.findMany({ where: { organisationId }, include: { costs: true, quote: { select: { total: true } }, invoices: { select: { total: true, amountPaid: true } } } }),
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
  const jobProfitability = allJobs.map((job) => {
    const estimated = job.quote?.total ? Number(job.quote.total) : 0
    const actualCosts = job.costs.reduce((sum, cost) => sum + Number(cost.amount), 0)
    const invoiced = job.invoices.reduce((sum, inv) => sum + Number(inv.total), 0)
    const collected = job.invoices.reduce((sum, inv) => sum + Number(inv.amountPaid), 0)
    return {
      id: job.id,
      title: job.title,
      estimated,
      actualCosts,
      invoiced,
      collected,
      margin: roundMoney(estimated - actualCosts),
    }
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
  app.listen(port, () => {
    console.log(`iQuote API listening on http://localhost:${port}`)
  })
}
