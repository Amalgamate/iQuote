import { useEffect, useState } from 'react'
import { apiRequest } from './api'
import QuoteDocument, { type QuoteDocumentData } from './QuoteDocument'
import { QuotePdfDownloadLink } from './QuotePdf'

type PublicQuoteRecord = QuoteDocumentData & {
  status: string
  viewedAt: string | null
  decisionComment: string | null
  decidedAt: string | null
}

const decisionLabel: Record<string, string> = {
  SENT: 'Awaiting your decision',
  VIEWED: 'Awaiting your decision',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
}

export default function PublicQuote({ token }: { token: string }) {
  const [quote, setQuote] = useState<PublicQuoteRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadQuote = async () => {
    try {
      const response = await apiRequest<{ quote: PublicQuoteRecord }>(`/api/public/quotes/${encodeURIComponent(token)}`)
      setQuote(response.quote)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'This quote link is unavailable.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadQuote() }, [token])

  const decide = async (decision: 'APPROVED' | 'DECLINED') => {
    setSubmitting(true)
    setError('')
    try {
      await apiRequest(`/api/public/quotes/${encodeURIComponent(token)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      })
      await loadQuote()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to record your decision.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <main className="public-quote-page"><p className="loading-state">Loading quotation…</p></main>
  if (!quote) return <main className="public-quote-page"><section className="public-message"><div className="brand"><span className="brand-mark">iQ</span><span>iQuote</span></div><h1>Quote unavailable</h1><p>{error || 'This quote link may have expired or been removed.'}</p></section></main>

  const canDecide = ['SENT', 'VIEWED'].includes(quote.status)

  return (
    <main className="public-quote-page">
      <div className="public-quote-topbar no-print">
        <div className="brand"><span className="brand-mark">iQ</span><span>iQuote</span></div>
        <div className="public-quote-actions">
          <span className={`quote-status status-${quote.status.toLowerCase()}`}>{decisionLabel[quote.status] ?? quote.status}</span>
          <QuotePdfDownloadLink className="secondary-button" quote={quote} />
          <button type="button" className="secondary-button" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      <div className="public-quote-layout">
        <QuoteDocument quote={quote} />
        <aside className="decision-panel no-print">
          <p className="eyebrow">Your decision</p>
          <h1>{canDecide ? 'Review this quotation' : decisionLabel[quote.status]}</h1>
          {quote.status === 'APPROVED' && <p>You approved this quotation. The business has been notified.</p>}
          {quote.status === 'DECLINED' && <p>You declined this quotation. The business has been notified.</p>}
          {quote.status === 'EXPIRED' && <p>This quotation is no longer available for approval.</p>}
          {quote.decisionComment && <blockquote>{quote.decisionComment}</blockquote>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {canDecide && (
            <form className="decision-form">
              <label htmlFor="decision-comment">Comment <span className="muted-text">(optional)</span></label>
              <textarea id="decision-comment" value={comment} onChange={(event) => setComment(event.target.value)} rows={4} placeholder="Add a note for the business" />
              <button type="button" className="primary-button full-width" disabled={submitting} onClick={() => void decide('APPROVED')}>
                {submitting ? 'Sending…' : 'Approve quotation'}
              </button>
              <button type="button" className="secondary-button full-width" disabled={submitting} onClick={() => void decide('DECLINED')}>
                Decline quotation
              </button>
            </form>
          )}
          <p className="decision-caption">Questions? Contact {quote.organisation.email || quote.organisation.phone || quote.organisation.name}.</p>
        </aside>
      </div>
    </main>
  )
}
