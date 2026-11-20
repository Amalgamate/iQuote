import { createHash, timingSafeEqual } from 'node:crypto'

const BASE_URL = (process.env.NCBA_API_BASE_URL || 'https://c2bapis.ncbagroup.com').replace(/\/$/, '')
const accessTokens = new Map<string, { value: string; expiresAt: number }>()

export function normalizeCustomerPhone(input: unknown) {
  let phone = String(input ?? '').replace(/[^\d]/g, '')
  if (phone.startsWith('0')) phone = `254${phone.slice(1)}`
  if (phone.startsWith('7') || phone.startsWith('1')) phone = `254${phone}`
  return /^254[17]\d{8}$/.test(phone) ? phone : null
}

export function normalizeMerchantCode(input: unknown) {
  const value = String(input ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{5,12}$/.test(value) ? value : null
}

export type NcbaMerchantCredentials = { username: string; secretKey: string }

export class NcbaMerchantRequestError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message)
    this.name = 'NcbaMerchantRequestError'
  }
}

async function ncbaToken(credentials: NcbaMerchantCredentials) {
  const cacheKey = `${credentials.username}:${credentials.secretKey}`
  const cached = accessTokens.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/payments/api/v1/auth/token`, {
      method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.secretKey}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new NcbaMerchantRequestError('NCBA authorization could not be reached. Please retry.', false)
  }
  const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number }
  if (!response.ok || !payload.access_token) throw new Error('NCBA could not authorize this merchant payment request.')
  accessTokens.set(cacheKey, { value: payload.access_token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 18_000)) * 1000 })
  return payload.access_token
}

async function ncbaRequest<T>(path: string, credentials: NcbaMerchantCredentials, body?: Record<string, string>) {
  const token = await ncbaToken(credentials)
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new NcbaMerchantRequestError(path.endsWith('/stk-push/initiate')
      ? 'NCBA may have received this request but did not return a result. Check its status before trying again.'
      : 'NCBA status could not be reached. Please retry.', path.endsWith('/stk-push/initiate'))
  }
  if (response.status === 401) { accessTokens.delete(`${credentials.username}:${credentials.secretKey}`); throw new Error('NCBA merchant authorization expired. Please retry.') }
  const payload = await response.json().catch(() => ({})) as T
  if (!response.ok) throw new Error('NCBA did not accept this merchant payment request.')
  return payload
}

export async function initiateMerchantStkPush(input: { credentials: NcbaMerchantCredentials; telephone: string; amount: number; paybillNumber: string; accountNo: string }) {
  const result = await ncbaRequest<{ TransactionID: string | null; StatusCode: string; StatusDescription: string; ReferenceID: string | null }>('/payments/api/v1/stk-push/initiate', input.credentials, {
    TelephoneNo: input.telephone, Amount: input.amount.toFixed(2), PayBillNo: input.paybillNumber,
    AccountNo: input.accountNo, Network: 'Safaricom', TransactionType: 'CustomerPayBillOnline',
  })
  if (result.StatusCode && result.StatusCode !== '0') throw new NcbaMerchantRequestError(result.StatusDescription || 'NCBA rejected the STK prompt.', false)
  if (!result.TransactionID) throw new NcbaMerchantRequestError('NCBA may have received this request but returned no transaction reference. Check its status before trying again.', true)
  return result
}

export async function queryMerchantStkPush(transactionId: string, credentials: NcbaMerchantCredentials) {
  return ncbaRequest<{ status?: string; Status?: string; TransactionStatus?: string; StatusCode?: string; description?: string; StatusDescription?: string }>('/payments/api/v1/stk-push/query', credentials, { TransactionID: transactionId })
}

export function verifyNotificationHash(payload: Record<string, unknown>, secret: string) {
  const value = (...keys: string[]) => {
    for (const key of keys) if (payload[key] !== null && payload[key] !== undefined) return String(payload[key])
    return ''
  }
  const source = secret
    + value('TransType')
    + value('TransID', 'TransactionID')
    + value('TransactionTime', 'TransTime')
    + value('TransAmount', 'amount')
    + value('CreditAccount', 'AccountNr', 'BusinessShortCode')
    + value('BillRefNumber', 'Narrative')
    + value('Mobile', 'PhoneNr')
    + value('Name', 'name', 'CustomerName')
    + '1'
  const digestHex = createHash('sha256').update(source, 'utf8').digest('hex')
  const expected = Buffer.from(Buffer.from(digestHex, 'utf8').toString('base64'))
  const received = Buffer.from(value('Hash', 'HashVal'))
  return expected.length === received.length && timingSafeEqual(expected, received)
}
