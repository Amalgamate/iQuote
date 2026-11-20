const BASE_URL = (process.env.NCBA_API_BASE_URL || 'https://c2bapis.ncbagroup.com').replace(/\/$/, '')
let accessToken: string | null = null
let accessTokenExpiresAt = 0

export type NcbaStkReply = {
  TransactionID: string | null
  StatusCode: string
  StatusDescription: string
  ReferenceID: string | null
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`NCBA configuration is missing ${name}.`)
  return value
}

export function ncbaStkConfigured() {
  return Boolean(
    process.env.NCBA_STK_USERNAME?.trim()
    && process.env.NCBA_STK_SECRET_KEY?.trim()
    && process.env.NCBA_PAYBILL_NO?.trim()
    && process.env.NCBA_TILL_ACCOUNT_NO?.trim(),
  )
}

export function ncbaPlanPrice(plan: string) {
  const name = plan.toUpperCase()
  if (!['STARTER', 'GROWTH', 'TEAM'].includes(name)) return null
  const value = Number(process.env[`IQUOTE_PRICE_${name}`])
  return Number.isFinite(value) && value > 0 ? Math.round((value + Number.EPSILON) * 100) / 100 : null
}

export function normalizeKenyanPhone(input: unknown) {
  let phone = String(input ?? '').replace(/[^\d]/g, '')
  if (phone.startsWith('0')) phone = `254${phone.slice(1)}`
  if (phone.startsWith('7') || phone.startsWith('1')) phone = `254${phone}`
  if (!/^254[17]\d{8}$/.test(phone)) return null
  return phone
}

async function ncbaToken() {
  if (accessToken && accessTokenExpiresAt > Date.now() + 60_000) return accessToken
  const username = required('NCBA_STK_USERNAME')
  const secret = required('NCBA_STK_SECRET_KEY')
  const response = await fetch(`${BASE_URL}/payments/api/v1/auth/token`, {
    method: 'GET',
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number }
  if (!response.ok || !payload.access_token) throw new Error('NCBA could not authorize this payment request.')
  accessToken = payload.access_token
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in ?? 18_000)) * 1000
  return accessToken
}

async function ncbaRequest<T>(path: string, body?: Record<string, string>) {
  const token = await ncbaToken()
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401) {
    accessToken = null
    accessTokenExpiresAt = 0
    throw new Error('NCBA authorization expired. Please retry the payment request.')
  }
  const payload = await response.json().catch(() => ({})) as T
  if (!response.ok) throw new Error('NCBA did not accept the payment request.')
  return payload
}

export async function initiateNcbaStkPush(input: { telephone: string; amount: number; accountNo?: string }) {
  if (!ncbaStkConfigured()) throw new Error('NCBA STK payment is not configured yet.')
  const result = await ncbaRequest<NcbaStkReply>('/payments/api/v1/stk-push/initiate', {
    TelephoneNo: input.telephone,
    Amount: input.amount.toFixed(2),
    PayBillNo: required('NCBA_PAYBILL_NO'),
    AccountNo: input.accountNo || required('NCBA_TILL_ACCOUNT_NO'),
    Network: 'Safaricom',
    TransactionType: 'CustomerPayBillOnline',
  })
  if (!result.TransactionID || result.StatusCode !== '0') {
    throw new Error(result.StatusDescription || 'NCBA did not initiate the STK request.')
  }
  return result
}

export async function queryNcbaStkPush(transactionId: string) {
  return ncbaRequest<{ status?: string; description?: string }>('/payments/api/v1/stk-push/query', { TransactionID: transactionId })
}

