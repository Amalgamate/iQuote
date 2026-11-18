// In production, the frontend is served by Nginx which proxies /api to the backend.
// VITE_API_URL is set at build time; when empty or unset, requests go to same-origin.
const API_BASE = import.meta.env.VITE_API_URL ?? ''

// Session expiry handler — allows the app to react to 401s globally
let onSessionExpired: (() => void) | null = null

/** Register a callback that fires when the API returns 401 (session expired/invalid) */
export function setSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler
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
    throw new Error(data?.message ?? 'Something went wrong.')
  }

  return data as T
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
