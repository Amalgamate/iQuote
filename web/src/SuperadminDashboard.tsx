import { useEffect, useState } from 'react'
import { apiRequest, formatMoney } from './api'
import './Workspace.css'

type SuperadminStats = {
  totalUsers: number
  totalOrganisations: number
  totalQuotes: number
  approvedQuotes: number
  totalQuotedValue: number
  totalQuoteCount: number
  activeTrials: number
  currencyBreakdown: Array<{ currency: string; total: number; count: number }>
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

        {page === 'overview' && stats && <AdminOverview user={user} stats={stats} workspaces={workspaces} quotes={recentQuotes} onWorkspaces={() => setPage('workspaces')} onQuotes={() => setPage('quotes')} onSignups={() => setPage('signups')} />}

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

function AdminOverview({ user, stats, workspaces, quotes, onWorkspaces, onQuotes, onSignups }: {
  user: User
  stats: SuperadminStats
  workspaces: WorkspaceRow[]
  quotes: RecentQuote[]
  onWorkspaces: () => void
  onQuotes: () => void
  onSignups: () => void
}) {
  const monthNames = Array.from({ length: 6 }, (_, index) => {
    const date = new Date()
    date.setDate(1)
    date.setMonth(date.getMonth() - (5 - index))
    return { key: `${date.getFullYear()}-${date.getMonth()}`, label: date.toLocaleDateString('en', { month: 'short' }), year: date.getFullYear(), month: date.getMonth() }
  })
  const growthValues = monthNames.map((month) => ({
    ...month,
    businesses: workspaces.filter((item) => { const date = new Date(item.createdAt); return date.getFullYear() === month.year && date.getMonth() === month.month }).length,
    users: stats.recentSignups.filter((item) => { const date = new Date(item.createdAt); return date.getFullYear() === month.year && date.getMonth() === month.month }).length,
  }))
  const maxGrowth = Math.max(1, ...growthValues.flatMap((item) => [item.businesses, item.users]))
  const counts = {
    approved: quotes.filter((item) => item.status === 'APPROVED').length,
    awaiting: quotes.filter((item) => ['SENT', 'VIEWED'].includes(item.status)).length,
    draft: quotes.filter((item) => item.status === 'DRAFT').length,
    other: quotes.filter((item) => ['DECLINED', 'EXPIRED'].includes(item.status)).length,
  }
  const totalStatus = Math.max(1, quotes.length)
  const recentBusinesses = [...workspaces].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)
  const activity = [
    ...quotes.slice(0, 5).map((item) => ({ id: `quote-${item.id}`, date: item.createdAt, title: item.documentNumber, detail: `${item.organisation.name} · ${item.status.toLowerCase()} · ${formatMoney(item.total, item.currency)}`, kind: 'Quote activity' })),
    ...stats.recentSignups.slice(0, 5).map((item) => ({ id: `user-${item.id}`, date: item.createdAt, title: item.name, detail: item.organisationName ?? item.email, kind: 'New signup' })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 5)
  const donutStyle = { background: `conic-gradient(#237b56 0 ${counts.approved / totalStatus * 100}%, #e2b75d ${counts.approved / totalStatus * 100}% ${(counts.approved + counts.awaiting) / totalStatus * 100}%, #7897ba ${(counts.approved + counts.awaiting) / totalStatus * 100}% ${(counts.approved + counts.awaiting + counts.draft) / totalStatus * 100}%, #e7ece8 ${(counts.approved + counts.awaiting + counts.draft) / totalStatus * 100}% 100%)` }

  return (
    <section className="workspace-content admin-dashboard-page">
      <div className="admin-dashboard-heading"><div><p className="dashboard-date-label">PLATFORM ADMINISTRATION</p><h2>Good morning, <em>{user.name.split(/\s+/)[0] || 'Admin'}</em>.</h2><p>Here’s what’s happening across the iQuote platform.</p></div><span className="admin-live-indicator"><i/>Platform data is live</span></div>

      <div className="admin-dashboard-metrics">
        <article><small>Businesses</small><strong>{stats.totalOrganisations.toLocaleString()}</strong><span>Registered workspaces</span></article>
        <article><small>Users</small><strong>{stats.totalUsers.toLocaleString()}</strong><span>Across all workspaces</span></article>
        <article><small>Quotes created</small><strong>{stats.totalQuotes.toLocaleString()}</strong><span>{stats.approvedQuotes.toLocaleString()} approved</span></article>
        <article className="admin-currency-breakdown"><small>Value quoted</small>{stats.currencyBreakdown.length > 0 ? stats.currencyBreakdown.map((row) => <strong key={row.currency}>{formatMoney(row.total, row.currency)}</strong>) : <strong>{formatMoney(0, 'KES')}</strong>}<span>{stats.totalQuoteCount ?? stats.totalQuotes} quotes across currencies</span></article>
        <article><small>Active trials</small><strong>{stats.activeTrials.toLocaleString()}</strong><span>On a 14-day trial</span></article>
      </div>

      <div className="admin-dashboard-grid">
        <section className="admin-dashboard-panel admin-growth-panel">
          <div className="admin-panel-heading"><div><h3>Workspace growth</h3><p>Businesses and user accounts in recent records</p></div><button className="dashboard-text-link" type="button" onClick={onSignups}>View signups →</button></div>
          <div className="admin-growth-legend"><span><i className="admin-growth-business"/>Businesses</span><span><i className="admin-growth-user"/>Users</span></div>
          <div className="admin-growth-chart">{growthValues.map((item) => <div className="admin-growth-month" key={item.key}><div className="admin-growth-bars"><i title={`${item.businesses} businesses`} style={{ height: `${Math.max(5, item.businesses / maxGrowth * 100)}%` }}/><i title={`${item.users} users`} style={{ height: `${Math.max(5, item.users / maxGrowth * 100)}%` }}/></div><small>{item.label}</small></div>)}</div>
          <div className="admin-growth-caption">Based on the workspace page and latest signup records currently loaded.</div>
        </section>

        <section className="admin-dashboard-panel admin-status-panel">
          <div className="admin-panel-heading"><div><h3>Quote activity</h3><p>Current lifecycle in recent quotes</p></div><button className="dashboard-text-link" type="button" onClick={onQuotes}>View quotes →</button></div>
          <div className="admin-status-layout"><div className="dashboard-donut" style={donutStyle}><div><strong>{stats.totalQuotes.toLocaleString()}</strong><small>all quotes</small></div></div><div className="dashboard-pipeline-legend"><span><i className="pipeline-approved"/>Approved<b>{counts.approved}</b></span><span><i className="pipeline-awaiting"/>Awaiting reply<b>{counts.awaiting}</b></span><span><i className="pipeline-draft"/>Draft<b>{counts.draft}</b></span><span><i className="pipeline-other"/>Other<b>{counts.other}</b></span></div></div>
          <small className="admin-growth-caption">Lifecycle counts reflect the latest {quotes.length} loaded quotes.</small>
        </section>
      </div>

      <div className="admin-dashboard-lower">
        <section className="admin-dashboard-panel admin-business-panel">
          <div className="admin-panel-heading"><div><h3>Recently active businesses</h3><p>Workspace onboarding and trial state</p></div><button className="dashboard-text-link" type="button" onClick={onWorkspaces}>All businesses →</button></div>
          <div className="table-scroll"><table className="data-table admin-dashboard-table"><thead><tr><th>Business</th><th>Owner</th><th>Plan</th><th>Quotes</th><th>Trial status</th></tr></thead><tbody>{recentBusinesses.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.country ?? 'Location not set'}</small></td><td>{item.owner.name}<small>{item.owner.email}</small></td><td>{item.subscription?.plan ?? '—'}</td><td>{item.quoteCount}</td><td><span className={planBadgeClass(item.subscription?.status ?? '')}>{trialStatus(item)}</span></td></tr>)}</tbody></table></div>
          {!recentBusinesses.length && <div className="customer-dashboard-empty compact">New workspaces will appear here.</div>}
        </section>
        <section className="admin-dashboard-panel admin-platform-activity">
          <div className="admin-panel-heading"><div><h3>Platform activity</h3><p>Recent account and quote events</p></div></div>
          {activity.length ? <div className="dashboard-activity-list">{activity.map((item) => <div className="dashboard-activity-item admin-activity-row" key={item.id}><span className="dashboard-activity-icon">{item.kind === 'New signup' ? '＋' : '↗'}</span><span><strong>{item.title}</strong><small>{item.kind} · {item.detail}</small></span></div>)}</div> : <div className="customer-dashboard-empty compact">Platform events will appear here.</div>}
        </section>
      </div>
    </section>
  )
}
