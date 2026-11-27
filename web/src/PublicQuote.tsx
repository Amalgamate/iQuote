import { useCallback, useEffect, useState } from 'react'
import { apiRequest, formatMoney } from './api'
import QuoteDocument, { type QuoteDocumentData } from './QuoteDocument'
import { QuotePdfDownloadLink } from './QuotePdf'
import QuoteChatter from './QuoteChatter'
import PublicProjectDetails, { type PublicInvoice, type PublicProject } from './PublicProjectDetails'

type PublicQuoteRecord = QuoteDocumentData & {
  status: string
  version?: number
  updatedFrom?: string | null
  viewedAt: string | null
  decisionComment: string | null
  decidedAt: string | null
  project: PublicProject | null
  invoice: PublicInvoice | null
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

  const loadQuote = useCallback(async () => {
    try {
      const response = await apiRequest<{ quote: PublicQuoteRecord }>(`/api/public/quotes/${encodeURIComponent(token)}`)
      setQuote(response.quote)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'This quote link is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void loadQuote() }, [loadQuote])
  useEffect(() => {
    if (quote && ['DECLINED', 'EXPIRED'].includes(quote.status)) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadQuote() }, 30000)
    return () => window.clearInterval(timer)
  }, [quote?.status, loadQuote])

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
  if (!quote) return <main className="public-quote-page"><section className="public-message"><div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div><h1>Quote unavailable</h1><p>{error || 'This quote link may have expired or been removed.'}</p></section></main>

  const canDecide = ['SENT', 'VIEWED'].includes(quote.status)

  return (
    <main className="public-quote-page">
      <div className="public-quote-topbar no-print">
        <div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div>
        <div className="public-quote-actions">
          <span className={`quote-status status-${quote.status.toLowerCase()}`}>{decisionLabel[quote.status] ?? quote.status}</span>
          <QuotePdfDownloadLink className="secondary-button" quote={quote} publicToken={token} />
          <button type="button" className="secondary-button" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {quote.version && quote.version > 1 && <div className="public-update-notice"><strong>Updated quotation</strong><span>This is version {quote.version}, replacing {quote.updatedFrom ?? 'the previous quotation'}.</span></div>}
      <div className="public-quote-layout">
        <aside className="decision-panel no-print">
          <section className="public-quote-rail-summary">
            <p className="workspace-eyebrow">Quotation total</p>
            <strong>{formatMoney(quote.total, quote.currency)}</strong>
            <span>{quote.documentNumber}</span>
          </section>
          <nav className="public-quote-rail-nav" aria-label="Quotation sections">
            <a href="#quote-document">Quotation details</a>
            {quote.project || quote.invoice ? <a href="#project-details">Project &amp; invoice</a> : null}
            <a href="#quote-conversation">Conversation</a>
          </nav>
          <section className="public-quote-decision">
          <p className="workspace-eyebrow">Your decision</p>
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
              <button type="button" className="button button-primary full-width" disabled={submitting} onClick={() => void decide('APPROVED')}>
                {submitting ? 'Sending…' : 'Approve quotation'}
              </button>
              <button type="button" className="button button-secondary full-width" disabled={submitting} onClick={() => void decide('DECLINED')}>
                Decline quotation
              </button>
            </form>
          )}
          <p className="decision-caption">Questions? Message the business below or contact {quote.organisation.email || quote.organisation.phone || quote.organisation.name}.</p>
          </section>
        </aside>
        <div className="public-quote-document" id="quote-document"><QuoteDocument quote={quote} /></div>
      </div>
      <div className="public-quote-followup">
        <div className="public-project-details-wrap" id="project-details"><PublicProjectDetails project={quote.project} invoice={quote.invoice} quoteNumber={quote.documentNumber} /></div>
        <div className="public-conversation no-print" id="quote-conversation"><QuoteChatter token={token} mode="customer" readOnly={quote.status === 'EXPIRED'} /></div>
      </div>
    </main>
  )
}
