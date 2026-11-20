import { useEffect, useState } from 'react'
import { apiRequest } from './api'

type PublicJob = {
  title: string
  status: string
  updatedAt: string
  organisation: { name: string | null }
  milestones: Array<{ id: string; title: string; dueDate: string | null; completedAt: string | null }>
}

export default function PublicJobProgress({ token }: { token: string }) {
  const [job, setJob] = useState<PublicJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    apiRequest<{ job: PublicJob }>(`/api/public/jobs/${encodeURIComponent(token)}`)
      .then((response) => setJob(response.job))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'This progress link is unavailable.'))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) return <main className="public-quote-page"><p className="loading-state">Loading project progress…</p></main>
  if (!job) return <main className="public-quote-page"><section className="public-message"><div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div><h1>Progress link unavailable</h1><p>{error || 'This link may have been revoked.'}</p></section></main>

  return <main className="public-quote-page">
    <div className="public-quote-topbar"><div className="brand"><span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span></span></div><span className="workspace-eyebrow">Project progress</span></div>
    <div className="public-quote-layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <section className="workspace-panel" style={{ maxWidth: 900, width: '100%', margin: '32px auto', padding: 'clamp(22px, 5vw, 44px)' }}>
        <p className="workspace-eyebrow">{job.organisation.name || 'Your service provider'}</p>
        <h1>{job.title}</h1>
        <p>Current status: <strong>{job.status.replaceAll('_', ' ').toLowerCase()}</strong></p>
        <h2>Project milestones</h2>
        <div className="milestone-list">
          {job.milestones.map((milestone) => <div className="milestone-item" key={milestone.id}>
            <span aria-hidden="true">{milestone.completedAt ? '✓' : '○'}</span>
            <div className="milestone-content"><strong>{milestone.title}</strong><small>{milestone.completedAt ? `Completed ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(milestone.completedAt))}` : milestone.dueDate ? `Expected ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(milestone.dueDate))}` : 'In progress'}</small></div>
          </div>)}
        </div>
        <p className="workspace-eyebrow">Updated {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(job.updatedAt))}</p>
      </section>
    </div>
  </main>
}
