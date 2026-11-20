import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from './api'
import QuoteChatter from './QuoteChatter'
import PublicProjectDetails, { type PublicInvoice, type PublicProject } from './PublicProjectDetails'

type PublicJob = PublicProject & {
  organisation: { name: string | null }
  quote: { documentNumber: string } | null
  quoteStatus: string | null
  conversationAvailable: boolean
  invoice: PublicInvoice | null
}

export default function PublicJobProgress({ token }: { token: string }) {
  const [job, setJob] = useState<PublicJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadJob = useCallback(async () => {
    try {
      const response = await apiRequest<{ job: PublicJob }>(`/api/public/jobs/${encodeURIComponent(token)}`)
      setJob(response.job)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'This progress link is unavailable.')
    } finally { setLoading(false) }
  }, [token])

  useEffect(() => {
    void loadJob()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadJob() }, 30000)
    return () => window.clearInterval(timer)
  }, [loadJob])

  if (loading) return <main className="public-quote-page"><p className="loading-state">Loading project progress…</p></main>
  if (!job) return <main className="public-quote-page"><section className="public-message"><div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div><h1>Progress link unavailable</h1><p>{error || 'This link may have been revoked.'}</p></section></main>

  return <main className="public-quote-page public-project-page">
    <div className="public-quote-topbar"><div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div><span className="workspace-eyebrow">{job.organisation.name || 'Your service provider'}</span></div>
    <PublicProjectDetails project={job} invoice={job.invoice} quoteNumber={job.quote?.documentNumber} />
    {job.conversationAvailable && <div className="public-conversation no-print"><QuoteChatter jobToken={token} mode="customer" readOnly={job.quoteStatus === 'EXPIRED'} /></div>}
  </main>
}
