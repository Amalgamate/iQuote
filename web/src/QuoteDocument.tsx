import { assetUrl, formatMoney } from './api'

export type QuoteLine = {
  id?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  taxRate: number | null
}

export type QuoteDocumentData = {
  documentNumber: string
  createdAt?: string
  status?: string
  currency: string
  validUntil?: string | null
  notes?: string | null
  terms?: string | null
  subtotal: number
  taxTotal: number
  total: number
  lines: QuoteLine[]
  customer: { id?: string; name: string; email?: string | null; phone?: string | null }
  organisation: {
    name: string
    email?: string | null
    phone?: string | null
    country?: string | null
    website?: string | null
    logoUrl?: string | null
    logoWidth?: number | null
    logoHeight?: number | null
    paymentInstructions?: string | null
    brandColor?: string | null
    kraPin?: string | null
    vatNumber?: string | null
    address?: string | null
    documentTemplate?: string | null
  }
}

function dateLabel(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}

function cleanUrl(url?: string | null) {
  if (!url) return null
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export default function QuoteDocument({ quote }: { quote: QuoteDocumentData }) {
  const hasFooterDetails = quote.organisation.email || quote.organisation.phone || quote.organisation.country || quote.organisation.website || quote.organisation.paymentInstructions

  // Detect logo aspect ratio
  const logoAspect = (quote.organisation.logoWidth && quote.organisation.logoHeight) 
    ? quote.organisation.logoWidth / quote.organisation.logoHeight 
    : 1
  const logoType = logoAspect > 1.3 ? 'landscape' : 'square'

  return (
    <article className="quote-paper" aria-label={`Quotation ${quote.documentNumber}`}>
      <header className="document-header">
        <div className="document-brand">
          {quote.organisation.logoUrl ? (
            <img src={assetUrl(quote.organisation.logoUrl) ?? undefined} alt={`${quote.organisation.name} logo`} data-logo-type={logoType} />
          ) : (
            <div className="document-logo-placeholder" aria-hidden="true">{quote.organisation.name.slice(0, 1).toUpperCase()}</div>
          )}
          <div className="document-business-details">
            <strong>{quote.organisation.name}</strong>
            <div className="document-business-meta">
              {quote.organisation.email && <span>{quote.organisation.email}</span>}
              {quote.organisation.phone && <span>{quote.organisation.phone}</span>}
              {quote.organisation.country && <span>{quote.organisation.country}</span>}
              {quote.organisation.website && <span>{cleanUrl(quote.organisation.website)}</span>}
            </div>
          </div>
        </div>
        <div className="document-title">
          <p>Quotation</p>
          <strong>{quote.documentNumber}</strong>
          <span>Prepared {dateLabel(quote.createdAt ?? new Date().toISOString())}</span>
          {quote.validUntil && <span>Valid until {dateLabel(quote.validUntil)}</span>}
        </div>
      </header>

      <section className="document-recipient">
        <span>Prepared for</span>
        <strong>{quote.customer.name || 'Customer'}</strong>
        {quote.customer.email && <span>{quote.customer.email}</span>}
        {quote.customer.phone && <span>{quote.customer.phone}</span>}
      </section>

      <table className="document-lines">
        <thead>
          <tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {quote.lines.length ? quote.lines.map((line, index) => (
            <tr key={line.id ?? index}>
              <td>{line.description}<small>{line.unit}</small></td>
              <td>{line.quantity}</td>
              <td>{formatMoney(line.unitPrice, quote.currency)}</td>
              <td>{line.taxRate == null ? '—' : `${line.taxRate}%`}</td>
              <td>{formatMoney(line.quantity * line.unitPrice, quote.currency)}</td>
            </tr>
          )) : <tr><td colSpan={5} className="document-empty-line">Line items will appear here.</td></tr>}
        </tbody>
      </table>

      <div className="document-totals">
        <div><span>Subtotal</span><strong>{formatMoney(quote.subtotal, quote.currency)}</strong></div>
        <div><span>Tax</span><strong>{formatMoney(quote.taxTotal, quote.currency)}</strong></div>
        <div className="document-total"><span>Total</span><strong>{formatMoney(quote.total, quote.currency)}</strong></div>
      </div>

      {(quote.notes || quote.terms || quote.organisation.paymentInstructions) && (
        <section className="document-notes">
          {quote.notes && <div className="document-note"><strong>Notes</strong><p>{quote.notes}</p></div>}
          {quote.terms && <div className="document-note"><strong>Terms</strong><p>{quote.terms}</p></div>}
          {quote.organisation.paymentInstructions && <div className="document-note"><strong>Payment instructions</strong><p>{quote.organisation.paymentInstructions}</p></div>}
        </section>
      )}

      <footer className="document-footer">
        <div className="document-footer-main">
          <span>Thank you for your consideration.</span>
          {hasFooterDetails && (
            <div className="document-footer-contacts">
              {quote.organisation.email && <span>{quote.organisation.email}</span>}
              {quote.organisation.phone && <span>{quote.organisation.phone}</span>}
              {quote.organisation.country && <span>{quote.organisation.country}</span>}
              {quote.organisation.website && <span>{cleanUrl(quote.organisation.website)}</span>}
            </div>
          )}
        </div>
        {quote.organisation.paymentInstructions && (
          <div className="document-footer-payment">
            <strong>Payment details</strong>
            <p>{quote.organisation.paymentInstructions}</p>
          </div>
        )}
      </footer>
    </article>
  )
}
