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
    logoUrl?: string | null
    paymentInstructions?: string | null
  }
}

function dateLabel(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(date)
}

export default function QuoteDocument({ quote }: { quote: QuoteDocumentData }) {
  return (
    <article className="quote-paper" aria-label={`Quotation ${quote.documentNumber}`}>
      <header className="document-header">
        <div className="document-business">
          {quote.organisation.logoUrl ? (
            <img src={assetUrl(quote.organisation.logoUrl) ?? undefined} alt={`${quote.organisation.name} logo`} />
          ) : (
            <div className="document-logo-placeholder" aria-hidden="true">{quote.organisation.name.slice(0, 1).toUpperCase()}</div>
          )}
          <div className="document-business-details">
            <strong>{quote.organisation.name}</strong>
            {quote.organisation.email && <span>{quote.organisation.email}</span>}
            {quote.organisation.phone && <span>{quote.organisation.phone}</span>}
            {quote.organisation.country && <span>{quote.organisation.country}</span>}
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

      {quote.notes && <section className="document-note"><strong>Notes</strong><p>{quote.notes}</p></section>}
      {quote.terms && <section className="document-note"><strong>Terms</strong><p>{quote.terms}</p></section>}
      {quote.organisation.paymentInstructions && <section className="document-note"><strong>Payment instructions</strong><p>{quote.organisation.paymentInstructions}</p></section>}

      <footer className="document-footer">Thank you for considering this quotation.</footer>
    </article>
  )
}
