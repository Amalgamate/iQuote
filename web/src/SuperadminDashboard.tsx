import { useEffect, useState } from 'react'
import { apiRequest, formatMoney } from './api'
import './Workspace.css'

type SuperadminStats = {
  totalUsers: number
  totalOrganisations: number
  totalQuotes: number
  approvedQuotes: number
  totalQuotedValue: number
  approvedQuoteCount: number
  activeTrials: number
  recentSignups: Array<{ id: string; name: string; email: string; role: string; createdAt: string; organisationName: string | null }>
}

type WorkspaceRow = {
  id: string
  name: string
  email: string | null
  country: string | null
  businessType: string | null
  currency: string
  createdAt: string
  owner: { id: string; name: string; email: string; createdAt: string }
  subscription: { plan: string; status: string; trialEndsAt: string; simulated: boolean } | null
  quoteCount: number
  totalQuotedValue: number
  customerCount: number
}

type RecentQuote = {
  id: string
  documentNumber: string
  status: string
  currency: string
  total: number
  createdAt: string
  organisation: { id: string; name: string }
  customer: { name: string }
}

type User = { id: string; name: string; email: string; role: string }

type SuperadminPage = 'overview' | 'workspaces' | 'quotes' | 'signups'

type PaginatedWorkspaces = { workspaces: WorkspaceRow[]; totalCount: number; hasMore: boolean }
type PaginatedQuotes = { quotes: RecentQuote[]; totalCount: number; hasMore: boolean }

function planBadgeClass(status: string) {
  if (status === 'TRIALING') return 'plan-badge plan-trial'
  if (status === 'ACTIVE') return 'plan-badge plan-active'
  if (status === 'PAST_DUE') return 'plan-badge plan-pastdue'
  if (status === 'CANCELLED') return 'plan-badge plan-cancelled'
  return 'plan-badge'
}

function trialStatus(org: WorkspaceRow): string {
  if (!org.subscription) return 'No plan'
  const sub = org.subscription
  if (sub.status === 'TRIALING') {
    const ends = new Date(sub.trialEndsAt)
    const now = new Date()
    const daysLeft = Math.max(0, Math.ceil((ends.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    return `Trial · ${daysLeft}d left`
  }
  return sub.status.charAt(0) + sub.status.slice(1).toLowerCase()
}

export default function SuperadminDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<SuperadminPage>('overview')
  const [stats, setStats] = useState<SuperadminStats | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [workspacesHasMore, setWorkspacesHasMore] = useState(false)
  const [workspacesTotal, setWorkspacesTotal] = useState(0)
  const [recentQuotes, setRecentQuotes] = useState<RecentQuote[]>([])
  const [quotesHasMore, setQuotesHasMore] = useState(false)
  const [quotesTotal, setQuotesTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const WORKSPACE_PAGE_SIZE = 50
  const QUOTE_PAGE_SIZE = 50

  const loadAll = async () => {
    const [statsRes, wsRes, quotesRes] = await Promise.all([
      apiRequest<SuperadminStats>('/api/superadmin/stats'),
      apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?limit=${WORKSPACE_PAGE_SIZE}`),
      apiRequest<PaginatedQuotes>(`/api/superadmin/quotes?limit=${QUOTE_PAGE_SIZE}`),
    ])
    setStats(statsRes)
    setWorkspaces(wsRes.workspaces)
    setWorkspacesHasMore(wsRes.hasMore)
    setWorkspacesTotal(wsRes.totalCount)
    setRecentQuotes(quotesRes.quotes)
    setQuotesHasMore(quotesRes.hasMore)
    setQuotesTotal(quotesRes.totalCount)
  }

  useEffect(() => {
    loadAll()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard data.'))
      .finally(() => setLoading(false))
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    setError('')
    try {
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh data.')
    } finally {
      setRefreshing(false)
    }
  }

  const handleRetry = async () => {
    setLoading(true)
    setError('')
    try {
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.')
    } finally {
      setLoading(false)
    }
  }

  const loadMoreWorkspaces = async () => {
    setLoadingMore(true)
    try {
      const res = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?limit=${WORKSPACE_PAGE_SIZE}&offset=${workspaces.length}`)
      setWorkspaces((current) => [...current, ...res.workspaces])
      setWorkspacesHasMore(res.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more workspaces.')
    } finally {
      setLoadingMore(false)
    }
  }

  const loadMoreQuotes = async () => {
    setLoadingMore(true)
    try {
      const res = await apiRequest<PaginatedQuotes>(`/api/superadmin/quotes?limit=${QUOTE_PAGE_SIZE}&offset=${recentQuotes.length}`)
      setRecentQuotes((current) => [...current, ...res.quotes])
      setQuotesHasMore(res.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more quotes.')
    } finally {
      setLoadingMore(false)
    }
  }

  const filteredWorkspaces = search.trim().toLowerCase()
    ? workspaces.filter((ws) => [ws.name, ws.email ?? '', ws.country ?? '', ws.owner.email, ws.businessType ?? ''].some((v) => v.toLowerCase().includes(search.trim().toLowerCase())))
    : workspaces

  const heading = page === 'overview' ? 'Platform Overview' : page === 'workspaces' ? 'Client Workspaces' : page === 'quotes' ? 'Platform Quotes' : 'Recent Signups'

  if (loading) return <main className="workspace-loading">Loading superadmin dashboard…</main>

  return (
    <div className="workspace-root superadmin-root">
      <aside className="app-sidebar">
        <a className="brand brand-workspace" href="#overview" onClick={(e) => { e.preventDefault(); setPage('overview') }}>
          <span className="brand-mark">iQ</span><span>iQuote<span className="brand-period">.</span> Admin</span>
        </a>
        <div className="sidebar-caption">Superadmin</div>
        <nav className="app-navigation" aria-label="Superadmin navigation">
          {([['overview', 'Overview', '⌂'], ['workspaces', 'Workspaces', '▦'], ['quotes', 'Quotes', '▤'], ['signups', 'Signups', '✦']] as const).map(([key, label, glyph]) => (
            <button key={key} type="button" className={`app-nav-item ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}>
              <span className="nav-glyph" aria-hidden="true">{glyph}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-business"><span className="business-avatar">A</span><span>{user.email}</span></div>
        <button type="button" className="app-nav-item logout-item" onClick={onLogout}><span className="nav-glyph">↪</span><span>Sign out</span></button>
      </aside>

      <main className="workspace-main">
        <header className="workspace-topbar">
          <div><p className="workspace-eyebrow">Superadmin</p><h1>{heading}</h1></div>
          <div className="topbar-right">
            <button type="button" className="quiet-button" onClick={() => void handleRefresh()} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : '↻ Refresh'}
            </button>
            <span className="topbar-user">{user.name}</span>
          </div>
        </header>

        {error && (
          <div className="workspace-alert" role="alert">
            <span>{error}</span>
            <div className="alert-actions">
              <button type="button" className="quiet-button" onClick={() => void handleRetry()}>Retry</button>
              <button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button>
            </div>
          </div>
        )}

        {page === 'overview' && stats && (
          <section className="workspace-content">
            <div className="admin-overview-intro">
              <div><p className="workspace-eyebrow">Platform health</p><h2>Everything at a glance</h2><p>Live activity across the businesses using iQuote.</p></div>
              <span className="admin-live-indicator"><i /> Data refreshed from platform</span>
            </div>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Total businesses</span>
                <strong>{stats.totalOrganisations}</strong>
                <small>Registered workspaces</small>
              </article>
              <article className="metric-card">
                <span>Total signups</span>
                <strong>{stats.totalUsers}</strong>
                <small>All registered users</small>
              </article>
              <article className="metric-card">
                <span>Total quotes</span>
                <strong>{stats.totalQuotes}</strong>
                <small>{stats.approvedQuotes} approved</small>
              </article>
              <article className="metric-card">
                <span>Total value quoted</span>
                <strong>{formatMoney(stats.totalQuotedValue, 'USD')}</strong>
                <small>Across all workspaces</small>
              </article>
              <article className="metric-card">
                <span>Active trials</span>
                <strong>{stats.activeTrials}</strong>
                <small>On 14-day trial</small>
              </article>
              <article className="metric-card">
                <span>Approved value</span>
                <strong>{formatMoney(recentQuotes.filter((q) => q.status === 'APPROVED').reduce((s, q) => s + q.total, 0), 'USD')}</strong>
                <small>From recent approved quotes</small>
              </article>
            </div>

            <section className="workspace-panel">
              <div className="panel-heading"><div><h2>Recent signups</h2><p>Latest users to join the platform</p></div></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Name</th><th>Email</th><th>Workspace</th><th>Role</th><th>Joined</th></tr></thead>
                  <tbody>
                    {stats.recentSignups.map((u) => (
                      <tr key={u.id}>
                        <td><strong>{u.name}</strong></td>
                        <td>{u.email}</td>
                        <td>{u.organisationName ?? '—'}</td>
                        <td>{u.role === 'SUPERADMIN' ? <span className="plan-badge plan-active">Superadmin</span> : 'User'}</td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(u.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="workspace-panel">
              <div className="panel-heading"><div><h2>Recent quotes</h2><p>Latest quoting activity across all workspaces</p></div></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Quote</th><th>Workspace</th><th>Customer</th><th>Total</th><th>Status</th><th>Created</th></tr></thead>
                  <tbody>
                    {recentQuotes.slice(0, 15).map((q) => (
                      <tr key={q.id}>
                        <td><strong>{q.documentNumber}</strong></td>
                        <td>{q.organisation.name}</td>
                        <td>{q.customer.name}</td>
                        <td>{formatMoney(q.total, q.currency)}</td>
                        <td><span className={`quote-status status-${q.status.toLowerCase()}`}>{q.status.charAt(0) + q.status.slice(1).toLowerCase()}</span></td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(q.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        )}

        {page === 'workspaces' && (
          <section className="workspace-content">
            <div className="list-toolbar">
              <div><p className="workspace-eyebrow">Platform</p><h2>All client workspaces</h2></div>
            </div>
            <div className="filter-row">
              <input className="input-control search-control" type="search" placeholder="Search by name, email, or country" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Business</th><th>Owner</th><th>Country</th><th>Plan</th><th>Quotes</th><th>Value quoted</th><th>Customers</th><th>Joined</th></tr></thead>
                  <tbody>
                    {filteredWorkspaces.map((ws) => (
                      <tr key={ws.id}>
                        <td><strong>{ws.name}</strong><small>{ws.businessType ?? 'General'}</small></td>
                        <td>{ws.owner.name}<small>{ws.owner.email}</small></td>
                        <td>{ws.country ?? '—'}</td>
                        <td><span className={planBadgeClass(ws.subscription?.status ?? '')}>{ws.subscription?.plan ?? 'FREE'}<small>{trialStatus(ws)}</small></span></td>
                        <td>{ws.quoteCount}</td>
                        <td>{formatMoney(ws.totalQuotedValue, ws.currency)}</td>
                        <td>{ws.customerCount}</td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(ws.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredWorkspaces.length === 0 && <div className="panel-empty"><h3>No workspaces found</h3><p>Try a different search term.</p></div>}
              {workspacesHasMore && !search && (
                <div className="load-more-row">
                  <button type="button" className="quiet-button" onClick={() => void loadMoreWorkspaces()} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Load more (${workspaces.length} of ${workspacesTotal})`}
                  </button>
                </div>
              )}
            </section>
          </section>
        )}

        {page === 'quotes' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Platform</p><h2>All quotes</h2></div></div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Quote</th><th>Workspace</th><th>Customer</th><th>Total</th><th>Status</th><th>Created</th></tr></thead>
                  <tbody>
                    {recentQuotes.map((q) => (
                      <tr key={q.id}>
                        <td><strong>{q.documentNumber}</strong></td>
                        <td>{q.organisation.name}</td>
                        <td>{q.customer.name}</td>
                        <td>{formatMoney(q.total, q.currency)}</td>
                        <td><span className={`quote-status status-${q.status.toLowerCase()}`}>{q.status.charAt(0) + q.status.slice(1).toLowerCase()}</span></td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(q.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            {quotesHasMore && (
              <div className="load-more-row">
                <button type="button" className="quiet-button" onClick={() => void loadMoreQuotes()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load more (${recentQuotes.length} of ${quotesTotal})`}
                </button>
              </div>
            )}
          </section>
        )}

        {page === 'signups' && stats && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Platform</p><h2>Recent signups</h2></div></div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Name</th><th>Email</th><th>Workspace</th><th>Role</th><th>Joined</th></tr></thead>
                  <tbody>
                    {stats.recentSignups.map((u) => (
                      <tr key={u.id}>
                        <td><strong>{u.name}</strong></td>
                        <td>{u.email}</td>
                        <td>{u.organisationName ?? '—'}</td>
                        <td>{u.role === 'SUPERADMIN' ? <span className="plan-badge plan-active">Superadmin</span> : 'User'}</td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(u.createdAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  )
}
