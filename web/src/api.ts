const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    credentials: 'include',
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.message ?? 'Something went wrong.')
  return data as T
}

export function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-KE', { style: 'currency', currency }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}
