// In production, the frontend is served by Nginx which proxies /api to the backend.
// VITE_API_URL is set at build time; when empty or unset, requests go to same-origin.
const API_BASE = import.meta.env.VITE_API_URL ?? ''

// Session expiry handler — allows the app to react to 401s globally
let onSessionExpired: (() => void) | null = null
let onSubscriptionPaymentRequired: (() => void) | null = null

/** Register a callback that fires when the API returns 401 (session expired/invalid) */
export function setSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler
}

export function setSubscriptionPaymentRequiredHandler(handler: (() => void) | null) {
  onSubscriptionPaymentRequired = handler
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    credentials: 'include',
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    // On 401 from non-public endpoints, trigger session expiry handler
    if (response.status === 401 && !path.startsWith('/api/public/') && onSessionExpired) {
      onSessionExpired()
    }
    if (response.status === 402 && data?.code === 'SUBSCRIPTION_PAYMENT_REQUIRED' && onSubscriptionPaymentRequired) {
      onSubscriptionPaymentRequired()
    }
    throw new Error(data?.message ?? 'Something went wrong.')
  }

  return data as T
}

export async function downloadAuthenticatedFile(path: string, filename: string) {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data?.message ?? 'Could not download the file.')
  }
  const blob = await response.blob()
  downloadBlobFile(blob, filename)
}

export async function downloadPublicFile(path: string, filename: string) {
  const response = await fetch(`${API_BASE}${path}`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data?.message ?? 'Could not download the file.')
  }
  downloadBlobFile(await response.blob(), filename)
}

export function downloadBlobFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Resolve a server-relative URL (e.g. /uploads/logo.png) to a full API URL */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${API_BASE}${path}`
}

export function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-KE', { style: 'currency', currency }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}
