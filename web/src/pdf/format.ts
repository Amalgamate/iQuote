// Helpers shared by every quotation template.

const smallNumbers = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const tensWords = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const currencyNames: Record<string, string> = {
  KES: 'Kenya Shillings',
  USD: 'US Dollars',
  EUR: 'Euros',
  GBP: 'Pounds Sterling',
  UGX: 'Uganda Shillings',
  TZS: 'Tanzania Shillings',
}

function wordsUnder1000(n: number): string {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) parts.push(`${smallNumbers[hundreds]} Hundred`)
  if (rest) {
    const tail = rest < 20
      ? smallNumbers[rest]
      : `${tensWords[Math.floor(rest / 10)]}${rest % 10 ? `-${smallNumbers[rest % 10]}` : ''}`
    parts.push(hundreds ? `and ${tail}` : tail)
  }
  return parts.join(' ')
}

function integerToWords(n: number): string {
  if (n === 0) return 'Zero'
  const scales: [number, string][] = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]
  const parts: string[] = []
  let remaining = n
  for (const [size, label] of scales) {
    const chunk = Math.floor(remaining / size)
    if (chunk) {
      parts.push(`${wordsUnder1000(chunk)} ${label}`)
      remaining %= size
    }
  }
  if (remaining) {
    parts.push(parts.length && remaining < 100 ? `and ${wordsUnder1000(remaining)}` : wordsUnder1000(remaining))
  }
  return parts.join(' ')
}

export function amountInWords(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount < 0 || amount >= 1e12) return ''
  const cents = Math.round(amount * 100)
  const major = Math.floor(cents / 100)
  const minor = cents % 100
  const name = currencyNames[currency] ?? currency
  return `${name} ${integerToWords(major)}${minor ? ` and ${integerToWords(minor)} Cents` : ''} Only`
}

export function dateLabel(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}

export function cleanUrl(url?: string | null) {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

// ---- colour maths (6-digit hex only; no alpha, which react-pdf handles unevenly) ----

const HEX = /^#[0-9a-f]{6}$/i
export const isHex = (value?: string | null): value is string => !!value && HEX.test(value)

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Text colour (white or near-black) that reads best on the given background. */
export function readableOn(background: string): '#ffffff' | '#1c1c1e' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#1c1c1e') ? '#ffffff' : '#1c1c1e'
}

/** Mix a colour with white. amount 0 = white, 1 = the colour itself. */
export function tint(hex: string, amount: number) {
  const mixed = channels(hex).map((v) => Math.round(255 - (255 - v) * amount))
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Brand colour if valid and dark enough to print as text on white; otherwise the fallback. */
export function safeAccent(raw: string | null | undefined, fallback: string) {
  if (!isHex(raw)) return fallback
  return contrastRatio(raw, '#ffffff') >= 3 ? raw.toLowerCase() : fallback
}
