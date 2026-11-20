import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'
import PwaControls from './PwaControls'
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
  status: string
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

type WorkspaceDetailData = {
  workspace: WorkspaceRow & {
    phone: string | null
    website: string | null
    owner: WorkspaceRow['owner'] & { mfaEnabled: boolean }
    suspendedAt: string | null
    suspendedByEmail: string | null
    suspensionReason: string | null
    restoredAt: string | null
    restoredByEmail: string | null
    subscription: (NonNullable<WorkspaceRow['subscription']> & { billingInterval: string }) | null
    members: Array<{ id: string; name: string; email: string; role: string; teamRole: string; createdAt: string }>
    metrics: { quoteCount: number; customerCount: number; jobCount: number; invoiceCount: number; totalQuotedValue: number }
  }
  recentQuotes: Array<{ id: string; documentNumber: string; status: string; currency: string; total: number; updatedAt: string; customer: { name: string }; delivery: { status: string; sentAt: string | null; deliveredAt: string | null; bouncedAt: string | null; errorMessage: string | null } | null }>
  recentJobs: Array<{ id: string; title: string; status: string; currency: string; updatedAt: string }>
  recentInvoices: Array<{ id: string; invoiceNumber: string; status: string; currency: string; total: number; amountPaid: number; balanceDue: number; updatedAt: string }>
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

type AuditEvent = {
  id: string
  actorEmail: string
  action: string
  targetType: string
  targetId: string | null
  summary: string
  metadata: { reason?: string } | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}
type PaginatedAudit = { events: AuditEvent[]; totalCount: number; hasMore: boolean }
type AdminAccount = { id: string; name: string; email: string; role: string; mfaEnabled: boolean; createdAt: string; workspace: { id: string; name: string | null; status: string } | null; activeSessionCount: number }
type AdminSession = { id: string; createdAt: string; expiresAt: string }
type PaginatedUsers = { users: AdminAccount[]; totalCount: number; hasMore: boolean }
type OperationsSnapshot = {
  checkedAt: string
  uptimeSeconds: number
  database: string
  emailProvider: string
  emailProviderHealth: string
  sender: string
  webhookSecret: string
  deliveryCounts24h: Record<string, number>
  deliveryCounts7d: Record<string, number>
  incidents: Array<{ id: string; status: string; recipientEmail: string; errorMessage: string | null; createdAt: string; quote: { id: string; documentNumber: string; organisation: { id: string; name: string } } }>
  webhook: { latest: { source: string; eventType: string; processingStatus: string; processingError: string | null; receivedAt: string; processedAt: string | null } | null; events24h: number; failures24h: number; failures: Array<{ id: string; source: string; eventType: string; processingError: string | null; receivedAt: string }> }
}
type PlatformNcbaConfig = { configured: boolean; source: 'ADMIN' | 'ENVIRONMENT' | 'UNSET'; username: string; paybillNumber: string; tillAccountNumber: string; secretConfigured: boolean; encryptionReady: boolean; updatedAt: string | null }
type PlatformReport = {
  range: string
  from: string
  to: string
  bucket: string
  currencyTotals: Array<{ currency: string; quoted: number; invoiced: number; invoicePaid: number; receivables: number; paymentsRecorded: number }>
  periods: Array<{ bucket: string; currency: string; quoteCount: number; quoted: number; invoiceCount: number; invoiced: number; paymentCount: number; paymentsRecorded: number }>
  reconciliation: { issueCount: number; invoices: Array<{ id: string; organisation: string; invoiceNumber: string; currency: string; invoiceTotal: number; invoicePaid: number; paymentEvents: number; balanceDue: number; updatedAt: string }> }
}

type PlatformPlanPrice = { plan: string; amount: number | null; currency: string; source: 'ADMIN' | 'ENVIRONMENT' | 'UNSET' }

type User = { id: string; name: string; email: string; role: string }

type SuperadminPage = 'overview' | 'workspaces' | 'quotes' | 'signups' | 'security' | 'activity' | 'accounts' | 'operations' | 'reports' | 'pricing'

type PaginatedWorkspaces = { workspaces: WorkspaceRow[]; totalCount: number; hasMore: boolean }
type PaginatedQuotes = { quotes: RecentQuote[]; totalCount: number; hasMore: boolean }

const BILLING_PLAN_NAMES = ['STARTER', 'GROWTH', 'TEAM'] as const

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
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetailData | null>(null)
  const [workspaceDetailLoading, setWorkspaceDetailLoading] = useState(false)
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false)
  const [workspaceActionBusy, setWorkspaceActionBusy] = useState(false)
  const [recentQuotes, setRecentQuotes] = useState<RecentQuote[]>([])
  const [quotesHasMore, setQuotesHasMore] = useState(false)
  const [quotesTotal, setQuotesTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaSecret, setMfaSecret] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMessage, setMfaMessage] = useState('')
  const [mfaBusy, setMfaBusy] = useState(false)
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditHasMore, setAuditHasMore] = useState(false)
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoading, setAuditLoading] = useState(false)
  const [adminUsers, setAdminUsers] = useState<AdminAccount[]>([])
  const [accountsTotal, setAccountsTotal] = useState(0)
  const [accountsHasMore, setAccountsHasMore] = useState(false)
  const [accountSearch, setAccountSearch] = useState('')
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<AdminAccount | null>(null)
  const [accountSessions, setAccountSessions] = useState<AdminSession[]>([])
  const [operations, setOperations] = useState<OperationsSnapshot | null>(null)
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [ncbaConfig, setNcbaConfig] = useState<PlatformNcbaConfig | null>(null)
  const [ncbaInputs, setNcbaInputs] = useState({ username: '', secret: '', paybillNumber: '', tillAccountNumber: '', reason: '' })
  const [ncbaBusy, setNcbaBusy] = useState(false)
  const [ncbaMessage, setNcbaMessage] = useState('')
  const [platformReport, setPlatformReport] = useState<PlatformReport | null>(null)
  const [platformReportRange, setPlatformReportRange] = useState('30d')
  const [platformReportLoading, setPlatformReportLoading] = useState(false)
  const [planPrices, setPlanPrices] = useState<PlatformPlanPrice[]>([])
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({ STARTER: '', GROWTH: '', TEAM: '' })
  const [priceReason, setPriceReason] = useState('')
  const [priceMessage, setPriceMessage] = useState('')
  const [priceBusy, setPriceBusy] = useState(false)

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

  const loadOperations = async () => {
    setOperationsLoading(true)
    try {
      setOperations(await apiRequest<OperationsSnapshot>('/api/superadmin/operations'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load platform operations.')
    } finally { setOperationsLoading(false) }
  }

  const loadNcbaConfig = async () => {
    try {
      const result = await apiRequest<PlatformNcbaConfig>('/api/superadmin/billing/ncba')
      setNcbaConfig(result)
      setNcbaInputs((current) => ({ ...current, username: result.username, paybillNumber: result.paybillNumber, tillAccountNumber: result.tillAccountNumber }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load NCBA billing configuration.')
    }
  }

  const saveNcbaConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNcbaBusy(true)
    setNcbaMessage('')
    setError('')
    try {
      await apiRequest<{ message: string }>('/api/superadmin/billing/ncba', { method: 'PUT', body: JSON.stringify(ncbaInputs) })
      setNcbaInputs((current) => ({ ...current, secret: '', reason: '' }))
      setNcbaMessage('NCBA billing credentials saved securely.')
      await loadNcbaConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save NCBA billing configuration.')
    } finally { setNcbaBusy(false) }
  }

  const reprocessWebhook = async (id: string) => {
    const reason = window.prompt('Why are you reprocessing this webhook?')?.trim()
    if (!reason) return
    try {
      await apiRequest(`/api/superadmin/operations/webhooks/${encodeURIComponent(id)}/reprocess`, { method: 'POST', body: JSON.stringify({ reason }) })
      await loadOperations()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reprocess webhook.')
    }
  }

  const loadPlatformReport = async (range = platformReportRange) => {
    setPlatformReportLoading(true)
    try {
      setPlatformReport(await apiRequest<PlatformReport>(`/api/superadmin/reports?range=${encodeURIComponent(range)}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load platform financial reporting.')
    } finally { setPlatformReportLoading(false) }
  }

  const loadPlanPrices = async () => {
    try {
      const result = await apiRequest<{ prices: PlatformPlanPrice[] }>('/api/superadmin/billing/prices')
      setPlanPrices(result.prices)
      setPriceInputs(Object.fromEntries(result.prices.map((item) => [item.plan, item.amount === null ? '' : String(item.amount)])))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load plan prices.')
    }
  }

  const savePlanPrices = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPriceBusy(true)
    setPriceMessage('')
    setError('')
    try {
      const result = await apiRequest<{ prices: PlatformPlanPrice[]; message: string }>('/api/superadmin/billing/prices', {
        method: 'PUT',
        body: JSON.stringify({
          reason: priceReason,
          prices: BILLING_PLAN_NAMES.map((plan) => ({ plan, amount: priceInputs[plan].trim() === '' ? null : Number(priceInputs[plan]) })),
        }),
      })
      setPlanPrices(result.prices)
      setPriceInputs(Object.fromEntries(result.prices.map((item) => [item.plan, item.amount === null ? '' : String(item.amount)])))
      setPriceReason('')
      setPriceMessage(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save plan prices.')
    } finally { setPriceBusy(false) }
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
      if (page === 'operations') await loadOperations()
      if (page === 'reports') await loadPlatformReport()
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
      const query = new URLSearchParams({ limit: String(WORKSPACE_PAGE_SIZE), offset: String(workspaces.length), ...(search.trim() ? { q: search.trim() } : {}) })
      const res = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?${query}`)
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

  const openWorkspace = async (id: string) => {
    setWorkspaceDetailLoading(true)
    setWorkspaceDetail(null)
    setError('')
    try {
      setWorkspaceDetail(await apiRequest<WorkspaceDetailData>(`/api/superadmin/workspaces/${encodeURIComponent(id)}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace details.')
    } finally { setWorkspaceDetailLoading(false) }
  }

  const updateWorkspaceLifecycle = async (id: string, action: 'suspend' | 'restore', reason = '') => {
    setWorkspaceActionBusy(true)
    setError('')
    try {
      await apiRequest(`/api/superadmin/workspaces/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'suspend' ? { reason } : {}) })
      await loadAll()
      await openWorkspace(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} workspace.`)
    } finally { setWorkspaceActionBusy(false) }
  }

  useEffect(() => {
    if (page !== 'workspaces' || workspaceDetail) return
    const timer = window.setTimeout(async () => {
      setWorkspaceSearchLoading(true)
      try {
        const query = new URLSearchParams({ limit: String(WORKSPACE_PAGE_SIZE), ...(search.trim() ? { q: search.trim() } : {}) })
        const result = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?${query}`)
        setWorkspaces(result.workspaces)
        setWorkspacesHasMore(result.hasMore)
        setWorkspacesTotal(result.totalCount)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Workspace search failed.')
      } finally { setWorkspaceSearchLoading(false) }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [page, search, workspaceDetail])

  useEffect(() => {
    if (page !== 'activity') return
    const timer = window.setTimeout(async () => {
      setAuditLoading(true)
      try {
        const query = new URLSearchParams({ limit: '50', ...(auditSearch.trim() ? { q: auditSearch.trim() } : {}) })
        const result = await apiRequest<PaginatedAudit>(`/api/superadmin/audit?${query}`)
        setAuditEvents(result.events)
        setAuditTotal(result.totalCount)
        setAuditHasMore(result.hasMore)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load admin activity.')
      } finally { setAuditLoading(false) }
    }, 200)
    return () => window.clearTimeout(timer)
  }, [page, auditSearch])

  const loadMoreAudit = async () => {
    setAuditLoading(true)
    try {
      const query = new URLSearchParams({ limit: '50', offset: String(auditEvents.length), ...(auditSearch.trim() ? { q: auditSearch.trim() } : {}) })
      const result = await apiRequest<PaginatedAudit>(`/api/superadmin/audit?${query}`)
      setAuditEvents((current) => [...current, ...result.events])
      setAuditHasMore(result.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load older admin activity.')
    } finally { setAuditLoading(false) }
  }

  const fetchAdminUsers = async (offset = 0, append = false) => {
    setAccountsLoading(true)
    try {
      const query = new URLSearchParams({ limit: '50', offset: String(offset), ...(accountSearch.trim() ? { q: accountSearch.trim() } : {}) })
      const result = await apiRequest<PaginatedUsers>(`/api/superadmin/users?${query}`)
      setAdminUsers((current) => append ? [...current, ...result.users] : result.users)
      setAccountsTotal(result.totalCount)
      setAccountsHasMore(result.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load user accounts.')
    } finally { setAccountsLoading(false) }
  }

  const openAccountSessions = async (account: AdminAccount) => {
    setSelectedAccount(account)
    setAccountSessions([])
    setAccountsLoading(true)
    try {
      const result = await apiRequest<{ sessions: AdminSession[] }>(`/api/superadmin/users/${encodeURIComponent(account.id)}/sessions`)
      setAccountSessions(result.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load account sessions.')
    } finally { setAccountsLoading(false) }
  }

  const revokeAccountSession = async (account: AdminAccount, sessionId?: string) => {
    if (account.id === user.id) return setError('Your own current admin session cannot be revoked here.')
    const reason = window.prompt('Enter a reason for revoking access (required):')?.trim() ?? ''
    if (reason.length < 5) return
    if (!window.confirm(`Revoke ${sessionId ? 'this session' : 'all active sessions'} for ${account.email}?`)) return
    try {
      if (sessionId) await apiRequest(`/api/superadmin/users/${encodeURIComponent(account.id)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', body: JSON.stringify({ reason }) })
      else await apiRequest(`/api/superadmin/users/${encodeURIComponent(account.id)}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) })
      await Promise.all([openAccountSessions(account), fetchAdminUsers()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke sessions.')
    }
  }

  useEffect(() => {
    if (page !== 'accounts' || selectedAccount) return
    const timer = window.setTimeout(() => void fetchAdminUsers(), 200)
    return () => window.clearTimeout(timer)
  }, [page, accountSearch, selectedAccount])

  useEffect(() => {
    if (page === 'operations') { void loadOperations(); void loadNcbaConfig() }
  }, [page])

  useEffect(() => {
    if (page === 'reports') void loadPlatformReport(platformReportRange)
  }, [page, platformReportRange])

  useEffect(() => {
    if (page === 'pricing') void loadPlanPrices()
  }, [page])

  const filteredWorkspaces = workspaces

  const heading = page === 'overview' ? 'Platform Overview' : page === 'workspaces' ? 'Client Workspaces' : page === 'quotes' ? 'Platform Quotes' : page === 'security' ? 'Security' : page === 'activity' ? 'Admin Activity' : page === 'accounts' ? 'User Accounts' : page === 'operations' ? 'Operations' : page === 'reports' ? 'Platform Reports' : page === 'pricing' ? 'Plan Pricing' : 'Recent Signups'

  const openSecurity = async () => {
    setPage('security')
    setMfaMessage('')
    try {
      const result = await apiRequest<{ secret?: string; mfaEnabled?: boolean }>('/api/superadmin/mfa/setup')
      setMfaEnabled(false)
      setMfaSecret(result.secret ?? '')
    } catch (error) {
      if (error instanceof Error && error.message.includes('already enabled')) {
        setMfaEnabled(true)
        setMfaSecret('')
      } else setMfaMessage(error instanceof Error ? error.message : 'Could not load security settings.')
    }
  }

  const submitMfa = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMfaBusy(true)
    setMfaMessage('')
    try {
      await apiRequest('/api/superadmin/mfa/verify', { method: 'POST', body: JSON.stringify({ code: mfaCode }) })
      setMfaEnabled(true)
      setMfaSecret('')
      setMfaCode('')
      setMfaMessage('Authenticator protection is enabled for this super-admin account.')
    } catch (error) {
      setMfaMessage(error instanceof Error ? error.message : 'Could not update MFA settings.')
    } finally { setMfaBusy(false) }
  }

  if (loading) return <main className="workspace-loading">Loading superadmin dashboard…</main>

  return (
    <div className="workspace-root superadmin-root">
      <aside className="app-sidebar">
        <a className="brand brand-workspace" href="#overview" onClick={(e) => { e.preventDefault(); setPage('overview') }}>
          <span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span> Admin</span>
        </a>
        <div className="sidebar-caption">Superadmin</div>
        <nav className="app-navigation" aria-label="Superadmin navigation">
          {([['overview', 'Overview', '⌂'], ['workspaces', 'Workspaces', '▦'], ['accounts', 'Users & sessions', '♙'], ['operations', 'Operations', '◉'], ['reports', 'Reports', '▥'], ['pricing', 'Plan pricing', '₭'], ['quotes', 'Quotes', '▤'], ['signups', 'Signups', '✦'], ['activity', 'Activity log', '≋'], ['security', 'Security', '⚙']] as const).map(([key, label, glyph]) => (
            <button key={key} type="button" className={`app-nav-item ${page === key ? 'active' : ''}`} onClick={() => { setWorkspaceDetail(null); if (key === 'security') void openSecurity(); else { setPage(key); if (key !== 'accounts') setSelectedAccount(null) } }}>
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
            <PwaControls />
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

        {page === 'pricing' && <section className="workspace-content">
          <div className="list-toolbar"><div><p className="workspace-eyebrow">Commercial settings</p><h2>Subscription plan prices</h2><p>Set the monthly KES price for each package. Saved prices appear in the customer renewal screen.</p></div></div>
          <form className="admin-pricing-form" onSubmit={(event) => void savePlanPrices(event)}>
            <div className="admin-price-grid">
              {BILLING_PLAN_NAMES.map((plan) => {
                const saved = planPrices.find((item) => item.plan === plan)
                return <label className="admin-price-card" key={plan}>
                  <span className="admin-price-name">{plan.charAt(0) + plan.slice(1).toLowerCase()}</span>
                  <span className="admin-price-period">Per workspace · monthly</span>
                  <span className="admin-price-input"><b>KES</b><input className="input-control" type="number" min="0.01" max="100000000" step="0.01" inputMode="decimal" placeholder="Leave blank to disable" value={priceInputs[plan] ?? ''} onChange={(event) => setPriceInputs((current) => ({ ...current, [plan]: event.target.value }))} aria-label={`${plan} monthly price in Kenyan shillings`} /></span>
                  <small className="admin-price-source">{saved?.source === 'ADMIN' ? 'Saved in platform settings' : saved?.source === 'ENVIRONMENT' ? 'Using server environment value' : 'Price not set'}</small>
                </label>
              })}
            </div>
            <div className="admin-pricing-note"><strong>Price changes affect future payment requests.</strong><span>Requests already sent to a customer keep their original amount. Clear a price and save to disable checkout for that package.</span></div>
            <label className="admin-price-reason">Reason for this change<input className="input-control" minLength={5} maxLength={300} required value={priceReason} onChange={(event) => setPriceReason(event.target.value)} placeholder="For example: approved launch pricing" /></label>
            <div className="admin-pricing-actions"><span role="status">{priceMessage}</span><button type="submit" className="button button-primary" disabled={priceBusy || priceReason.trim().length < 5}>{priceBusy ? 'Saving prices…' : 'Save plan prices'}</button></div>
          </form>
        </section>}

        {page === 'workspaces' && (
          workspaceDetailLoading ? <main className="workspace-loading">Loading workspace details…</main> : workspaceDetail ? <WorkspaceDetailView data={workspaceDetail} actionBusy={workspaceActionBusy} onSuspend={(reason) => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'suspend', reason)} onRestore={() => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'restore')} onBack={() => setWorkspaceDetail(null)} /> : <section className="workspace-content">
            <div className="list-toolbar">
              <div><p className="workspace-eyebrow">Platform</p><h2>All client workspaces</h2></div>
            </div>
            <div className="filter-row">
              <input className="input-control search-control" type="search" placeholder="Search business, owner, email, country, or type" value={search} onChange={(e) => setSearch(e.target.value)} />
              <span className="workspace-eyebrow" aria-live="polite">{workspaceSearchLoading ? 'Searching…' : `${workspacesTotal} workspaces`}</span>
            </div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Business</th><th>Owner</th><th>Country</th><th>Workspace</th><th>Plan</th><th>Quotes</th><th>Value quoted</th><th>Customers</th><th>Joined</th></tr></thead>
                  <tbody>
                    {filteredWorkspaces.map((ws) => (
                      <tr key={ws.id}>
                        <td><button type="button" className="dashboard-text-link" onClick={() => void openWorkspace(ws.id)}>{ws.name} →</button><small>{ws.businessType ?? 'General'}</small></td>
                        <td>{ws.owner.name}<small>{ws.owner.email}</small></td>
                        <td>{ws.country ?? '—'}</td>
                        <td><span className={`workspace-state ${ws.status === 'SUSPENDED' ? 'suspended' : 'active'}`}>{ws.status === 'SUSPENDED' ? 'Suspended' : 'Active'}</span></td>
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
              {workspacesHasMore && (
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

        {page === 'accounts' && (
          <section className="workspace-content">
            {selectedAccount ? <>
              <div className="list-toolbar"><div><button className="dashboard-text-link" type="button" onClick={() => setSelectedAccount(null)}>← All users</button><p className="workspace-eyebrow" style={{ marginTop: 12 }}>Account support</p><h2>{selectedAccount.name}</h2><p>{selectedAccount.email} · {selectedAccount.role === 'SUPERADMIN' ? 'Super-admin' : 'User'}</p></div><button type="button" className="quiet-button danger-button" disabled={accountsLoading || selectedAccount.id === user.id || accountSessions.length === 0} onClick={() => void revokeAccountSession(selectedAccount)}>{accountsLoading ? 'Updating…' : `Revoke all sessions (${accountSessions.length})`}</button></div>
              <section className="workspace-panel" style={{ padding: 20 }}><div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}><p>MFA: <strong>{selectedAccount.mfaEnabled ? 'Enabled' : 'Not enabled'}</strong></p><p>Joined: <strong>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(selectedAccount.createdAt))}</strong></p><p>Active sessions: <strong>{accountSessions.length}</strong></p><p>Workspace: <strong>{selectedAccount.workspace?.name ?? 'None'}</strong>{selectedAccount.workspace?.status === 'SUSPENDED' ? ' · Suspended' : ''}</p></div>{selectedAccount.id === user.id && <p className="workspace-eyebrow">Your current admin session is protected from this control.</p>}</section>
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Active sessions</h3><p>Only active sessions are shown. Session tokens are never exposed.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Started</th><th>Expires</th><th>Session</th><th>Action</th></tr></thead><tbody>
                {accountSessions.map((session) => <tr key={session.id}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.createdAt))}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}</td><td><code>{session.id.slice(0, 10)}</code></td><td><button type="button" className="dashboard-text-link danger-text" disabled={accountsLoading || selectedAccount.id === user.id} onClick={() => void revokeAccountSession(selectedAccount, session.id)}>Revoke</button></td></tr>)}
              </tbody></table></div>{!accountSessions.length && <div className="panel-empty">No active sessions.</div>}</section>
            </> : <>
              <div className="list-toolbar"><div><p className="workspace-eyebrow">Account support</p><h2>Users and sessions</h2><p>Find an account, review its active sessions, and revoke access when needed.</p></div><span className="workspace-eyebrow">{accountsTotal} users</span></div>
              <div className="filter-row"><input className="input-control search-control" type="search" placeholder="Search name, email, role, or workspace" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} /><span className="workspace-eyebrow" aria-live="polite">{accountsLoading ? 'Loading…' : 'Newest first'}</span></div>
              <section className="workspace-panel quote-list-panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Workspace</th><th>MFA</th><th>Sessions</th><th>Joined</th><th></th></tr></thead><tbody>
                {adminUsers.map((account) => <tr key={account.id}><td><strong>{account.name}</strong></td><td>{account.email}</td><td>{account.role === 'SUPERADMIN' ? 'Super-admin' : 'User'}</td><td>{account.workspace?.name ?? '—'}{account.workspace?.status === 'SUSPENDED' ? <small>Suspended</small> : null}</td><td>{account.mfaEnabled ? 'On' : 'Off'}</td><td>{account.activeSessionCount}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(account.createdAt))}</td><td><button type="button" className="dashboard-text-link" onClick={() => void openAccountSessions(account)}>Manage →</button></td></tr>)}
              </tbody></table></div>{!adminUsers.length && !accountsLoading && <div className="panel-empty">No accounts match that search.</div>}{accountsHasMore && <div className="load-more-row"><button type="button" className="quiet-button" disabled={accountsLoading} onClick={() => void fetchAdminUsers(adminUsers.length, true)}>{accountsLoading ? 'Loading…' : `Load more (${adminUsers.length} of ${accountsTotal})`}</button></div>}</section>
            </>}
          </section>
        )}

        {page === 'operations' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Service signals</p><h2>Platform operations</h2><p>Configuration, live Resend API connectivity, and recent operational records.</p></div><span className="workspace-eyebrow" aria-live="polite">{operationsLoading ? 'Refreshing…' : operations ? `Checked ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(operations.checkedAt))}` : 'No snapshot loaded'}</span></div>
            <section className="workspace-panel admin-ncba-config" style={{ padding: 20 }}>
              <div className="list-toolbar" style={{ padding: 0, marginBottom: 14 }}><div><p className="workspace-eyebrow">Platform subscriptions</p><h3>NCBA STK Push</h3><p>Credentials for iQuote subscription checkout. Tenant customer-payment credentials remain managed in each workspace.</p></div><span className={`plan-badge ${ncbaConfig?.configured ? 'plan-active' : 'plan-pastdue'}`}>{ncbaConfig?.configured ? 'Configured' : 'Not configured'}</span></div>
              {ncbaConfig && <p className="workspace-eyebrow">Source: {ncbaConfig.source === 'ADMIN' ? 'Super-admin settings' : ncbaConfig.source === 'ENVIRONMENT' ? 'Server environment' : 'Not set'}{ncbaConfig.updatedAt ? ` · Updated ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ncbaConfig.updatedAt))}` : ''}</p>}
              {!ncbaConfig?.encryptionReady && <div className="workspace-alert" style={{ display: 'block' }}>Credential encryption is not configured. Set <code>EMAIL_SETTINGS_ENCRYPTION_KEY</code> to a random value of at least 32 characters on the API before saving credentials.</div>}
              <form className="onboarding-form" onSubmit={(event) => void saveNcbaConfig(event)}>
                <div className="admin-ncba-fields">
                  <label>NCBA STK username<input className="input-control" autoComplete="off" required value={ncbaInputs.username} onChange={(event) => setNcbaInputs((current) => ({ ...current, username: event.target.value }))} /></label>
                  <label>STK secret key<input className="input-control" type="password" autoComplete="new-password" required={!ncbaConfig?.secretConfigured} placeholder={ncbaConfig?.secretConfigured ? 'Saved securely · leave blank to keep current key' : 'Enter secret key'} value={ncbaInputs.secret} onChange={(event) => setNcbaInputs((current) => ({ ...current, secret: event.target.value }))} /></label>
                  <label>NCBA Paybill number<input className="input-control" autoComplete="off" required value={ncbaInputs.paybillNumber} onChange={(event) => setNcbaInputs((current) => ({ ...current, paybillNumber: event.target.value }))} /></label>
                  <label>Till account reference<input className="input-control" autoComplete="off" required value={ncbaInputs.tillAccountNumber} onChange={(event) => setNcbaInputs((current) => ({ ...current, tillAccountNumber: event.target.value }))} /></label>
                </div>
                <label>Reason for change<input className="input-control" minLength={5} maxLength={500} required value={ncbaInputs.reason} onChange={(event) => setNcbaInputs((current) => ({ ...current, reason: event.target.value }))} placeholder="For example: NCBA production credentials activated" /></label>
                <div className="admin-pricing-actions"><span role="status">{ncbaMessage}</span><button className="button button-primary" type="submit" disabled={ncbaBusy || !ncbaConfig?.encryptionReady}>{ncbaBusy ? 'Saving securely…' : 'Save NCBA settings'}</button></div>
              </form>
              <p className="admin-ncba-footnote">Secrets are encrypted before database storage and never returned by the settings API. Saving updates the STK client configuration; this page does not perform a live NCBA credential test.</p>
            </section>
            {operations && <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">Database</p><strong>{operations.database}</strong></section>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">Email API key</p><strong>{operations.emailProvider}</strong></section>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">Resend live health</p><strong>{operations.emailProviderHealth}</strong></section>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">Sender configuration</p><strong>{operations.sender}</strong></section>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">Webhook secret</p><strong>{operations.webhookSecret}</strong></section>
                <section className="workspace-panel" style={{ padding: 18 }}><p className="workspace-eyebrow">API process uptime</p><strong>{Math.floor(operations.uptimeSeconds / 3600)}h {Math.floor((operations.uptimeSeconds % 3600) / 60)}m</strong></section>
              </div>
              <section className="workspace-panel" style={{ padding: 20 }}><h3>Email deliveries</h3><div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}><div><p className="workspace-eyebrow">Last 24 hours</p>{Object.entries(operations.deliveryCounts24h).map(([status, count]) => <p key={status}><strong>{status}</strong> · {count}</p>)}{!Object.keys(operations.deliveryCounts24h).length && <p>No delivery records.</p>}</div><div><p className="workspace-eyebrow">Last 7 days</p>{Object.entries(operations.deliveryCounts7d).map(([status, count]) => <p key={status}><strong>{status}</strong> · {count}</p>)}{!Object.keys(operations.deliveryCounts7d).length && <p>No delivery records.</p>}</div></div></section>
              <section className="workspace-panel" style={{ padding: 20 }}><h3>Webhook activity</h3><p>{operations.webhook.events24h} events processed in the last 24 hours · {operations.webhook.failures24h} processing failures in the last 24 hours.</p><p>{operations.webhook.latest ? `Latest: ${operations.webhook.latest.eventType} · ${operations.webhook.latest.processingStatus} · ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(operations.webhook.latest.receivedAt))}` : 'No webhook events recorded yet.'}</p>{operations.webhook.failures.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Received</th><th>Event</th><th>Source</th><th>Processing error</th><th>Support action</th></tr></thead><tbody>{operations.webhook.failures.map((event) => <tr key={event.id}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.receivedAt))}</td><td>{event.eventType}</td><td>{event.source}</td><td>{event.processingError ?? 'No error detail recorded'}</td><td><button type="button" className="dashboard-text-link" disabled={operationsLoading} onClick={() => void reprocessWebhook(event.id)}>Reprocess</button></td></tr>)}</tbody></table></div>}</section>
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Delivery incidents</h3><p>Failed, bounced, or pending for more than ten minutes · last 7 days</p></div><span className="workspace-eyebrow">{operations.incidents.length} shown</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Time</th><th>State</th><th>Workspace</th><th>Quote</th><th>Recipient</th><th>Issue</th></tr></thead><tbody>
                {operations.incidents.map((incident) => <tr key={incident.id}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(incident.createdAt))}</td><td><span className={`quote-status status-${incident.status.toLowerCase()}`}>{incident.status}</span></td><td>{incident.quote.organisation.name}</td><td>{incident.quote.documentNumber}</td><td>{incident.recipientEmail}</td><td>{incident.errorMessage ?? (incident.status === 'PENDING' ? 'No provider response after 10 minutes' : 'No provider error detail')}</td></tr>)}
              </tbody></table></div>{!operations.incidents.length && <div className="panel-empty">No recent delivery incidents.</div>}</section>
            </>}
          </section>
        )}

        {page === 'reports' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Financial activity</p><h2>Platform totals by currency</h2><p>Quotes are pipeline value; invoices and recorded payments are separate financial measures. Currencies are never combined.</p></div><label className="workspace-eyebrow">Period <select className="input-control" value={platformReportRange} onChange={(event) => setPlatformReportRange(event.target.value)}><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option><option value="365d">1 year</option></select></label></div>
            {platformReportLoading && !platformReport ? <main className="workspace-loading">Loading platform report…</main> : platformReport && <>
              <p className="workspace-eyebrow" aria-live="polite">{platformReportLoading ? 'Updating…' : `${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(platformReport.from))} – ${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(platformReport.to))}`}</p>
              <section className="workspace-panel quote-list-panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>Currency</th><th>Quoted value</th><th>Invoiced</th><th>Invoice paid amount</th><th>Receivables</th><th>Recorded payments</th></tr></thead><tbody>
                {platformReport.currencyTotals.map((row) => <tr key={row.currency}><td><strong>{row.currency}</strong></td><td>{formatMoney(row.quoted, row.currency)}</td><td>{formatMoney(row.invoiced, row.currency)}</td><td>{formatMoney(row.invoicePaid, row.currency)}</td><td>{formatMoney(row.receivables, row.currency)}</td><td>{formatMoney(row.paymentsRecorded, row.currency)}</td></tr>)}
              </tbody></table></div>{!platformReport.currencyTotals.length && <div className="panel-empty">No quote, invoice, or payment activity in this period.</div>}</section>
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Invoice reconciliation</h3><p>Compares each invoice's stored paid and balance amounts with its immutable payment records.</p></div><span className="workspace-eyebrow">{platformReport.reconciliation.issueCount} mismatches</span></div>{platformReport.reconciliation.invoices.length > 0 ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Workspace</th><th>Invoice</th><th>Currency</th><th>Invoice total</th><th>Stored paid</th><th>Payment records</th><th>Stored balance</th></tr></thead><tbody>{platformReport.reconciliation.invoices.map((invoice) => <tr key={invoice.id}><td>{invoice.organisation}</td><td>{invoice.invoiceNumber}</td><td>{invoice.currency}</td><td>{formatMoney(invoice.invoiceTotal, invoice.currency)}</td><td>{formatMoney(invoice.invoicePaid, invoice.currency)}</td><td>{formatMoney(invoice.paymentEvents, invoice.currency)}</td><td>{formatMoney(invoice.balanceDue, invoice.currency)}</td></tr>)}</tbody></table></div> : <div className="panel-empty">Invoice totals reconcile with recorded payment rows.</div>}</section>
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Activity over time</h3><p>Each row remains scoped to one currency.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Period</th><th>Currency</th><th>Quotes</th><th>Quoted</th><th>Invoices</th><th>Invoiced</th><th>Payments</th><th>Recorded amount</th></tr></thead><tbody>
                {platformReport.periods.map((row) => <tr key={`${row.bucket}-${row.currency}`}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(row.bucket))}</td><td>{row.currency}</td><td>{row.quoteCount}</td><td>{formatMoney(row.quoted, row.currency)}</td><td>{row.invoiceCount}</td><td>{formatMoney(row.invoiced, row.currency)}</td><td>{row.paymentCount}</td><td>{formatMoney(row.paymentsRecorded, row.currency)}</td></tr>)}
              </tbody></table></div>{!platformReport.periods.length && <div className="panel-empty">No activity buckets for the selected period.</div>}</section>
            </>}
          </section>
        )}

        {page === 'activity' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Governance</p><h2>Super-admin activity</h2><p>Security and workspace lifecycle actions are recorded here.</p></div><span className="workspace-eyebrow">{auditTotal} events</span></div>
            <div className="filter-row"><input className="input-control search-control" type="search" placeholder="Search admin, action, workspace, or reason" value={auditSearch} onChange={(event) => setAuditSearch(event.target.value)} /><span className="workspace-eyebrow" aria-live="polite">{auditLoading ? 'Loading…' : 'Newest first'}</span></div>
            <section className="workspace-panel quote-list-panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>IP address</th></tr></thead><tbody>
              {auditEvents.map((event) => <tr key={event.id}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.createdAt))}</td><td>{event.actorEmail}</td><td><strong>{event.action.replaceAll('_', ' ').toLowerCase()}</strong></td><td>{event.targetType}{event.targetId ? <small>{event.targetId}</small> : null}</td><td>{event.metadata?.reason ?? event.summary}</td><td>{event.ipAddress ?? '—'}</td></tr>)}
            </tbody></table></div>
              {!auditEvents.length && !auditLoading && <div className="panel-empty"><h3>No admin activity yet</h3><p>New sensitive actions will appear here.</p></div>}
              {auditHasMore && <div className="load-more-row"><button type="button" className="quiet-button" onClick={() => void loadMoreAudit()} disabled={auditLoading}>{auditLoading ? 'Loading…' : `Load older events (${auditEvents.length} of ${auditTotal})`}</button></div>}
            </section>
          </section>
        )}

        {page === 'security' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Account protection</p><h2>Super-admin security</h2></div></div>
            <section className="workspace-panel" style={{ maxWidth: 720, padding: 28 }}>
              <h3>Authenticator app</h3>
              <p>{mfaEnabled ? 'Two-step verification is required for this super-admin account. It cannot be disabled from the dashboard.' : 'Add an authenticator app to protect this super-admin account. Scan or enter the setup key, then confirm a current code.'}</p>
              {!mfaEnabled && mfaSecret && <div className="workspace-alert" style={{ display: 'block' }}><strong>Setup key</strong><p style={{ marginBottom: 8 }}>Add an account manually in your authenticator app with issuer iQuote.</p><code>{mfaSecret}</code><p style={{ marginBottom: 0 }}>Account: {user.email}</p></div>}
              {!mfaEnabled && <form className="onboarding-form" onSubmit={submitMfa}>
                <label>Confirm authenticator code<input className="input-control" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={mfaCode} onChange={event => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /></label>
                {mfaMessage && <p role="status">{mfaMessage}</p>}
                <button className="quiet-button" disabled={mfaBusy || !mfaSecret}>{mfaBusy ? 'Saving…' : 'Enable MFA'}</button>
              </form>}
              {!mfaEnabled && !mfaSecret && <button className="quiet-button" type="button" onClick={() => void openSecurity()}>Generate setup key</button>}
            </section>
          </section>
        )}
      </main>
    </div>
  )
}

function WorkspaceDetailView({ data, actionBusy, onSuspend, onRestore, onBack }: { data: WorkspaceDetailData; actionBusy: boolean; onSuspend: (reason: string) => void; onRestore: () => void; onBack: () => void }) {
  const [suspensionReason, setSuspensionReason] = useState('')
  const { workspace, recentQuotes, recentJobs, recentInvoices } = data
  const joined = new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(workspace.createdAt))
  return <section className="workspace-content">
    <div className="list-toolbar">
      <div><button className="dashboard-text-link" type="button" onClick={onBack}>← All workspaces</button><p className="workspace-eyebrow" style={{ marginTop: 12 }}>Workspace profile · Joined {joined}</p><h2>{workspace.name}</h2><p>{workspace.businessType ?? 'General business'}{workspace.country ? ` · ${workspace.country}` : ''}</p></div>
      <span className={planBadgeClass(workspace.subscription?.status ?? '')}>{workspace.subscription?.plan ?? 'FREE'}<small>{trialStatus(workspace)}</small></span>
    </div>

    <section className="workspace-panel" style={{ padding: 20, borderColor: workspace.status === 'SUSPENDED' ? '#efb3aa' : undefined }}>
      <div className="list-toolbar" style={{ padding: 0 }}><div><h3>Workspace access</h3><p>Current state: <span className={`workspace-state ${workspace.status === 'SUSPENDED' ? 'suspended' : 'active'}`}>{workspace.status === 'SUSPENDED' ? 'Suspended' : 'Active'}</span></p></div></div>
      {workspace.suspendedAt && <div style={{ marginTop: 14 }}><p><strong>Last suspension reason:</strong> {workspace.suspensionReason}</p><small>Suspended {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.suspendedAt))} by {workspace.suspendedByEmail ?? 'super-admin'}.</small>{workspace.restoredAt && <p><small>Restored {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.restoredAt))} by {workspace.restoredByEmail ?? 'super-admin'}.</small></p>}</div>}
      {workspace.status === 'SUSPENDED' ? <div style={{ marginTop: 14 }}><button type="button" className="quiet-button" disabled={actionBusy} onClick={() => { if (window.confirm(`Restore access to ${workspace.name}?`)) onRestore() }}>{actionBusy ? 'Restoring…' : 'Restore workspace'}</button></div> : <form className="workspace-suspend-form" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Suspend ${workspace.name}? The workspace owner and team will lose dashboard access until restored.`)) onSuspend(suspensionReason) }}><label htmlFor="workspace-suspension-reason">Reason required</label><input id="workspace-suspension-reason" className="input-control" minLength={5} maxLength={500} value={suspensionReason} onChange={(event) => setSuspensionReason(event.target.value)} placeholder="For example: billing issue or policy review" required /><button type="submit" className="quiet-button danger-button" disabled={actionBusy || suspensionReason.trim().length < 5}>{actionBusy ? 'Suspending…' : 'Suspend workspace'}</button></form>}
    </section>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
      {[
        ['Quotes', workspace.metrics.quoteCount], ['Customers', workspace.metrics.customerCount], ['Jobs', workspace.metrics.jobCount], ['Invoices', workspace.metrics.invoiceCount],
      ].map(([label, value]) => <section className="workspace-panel" key={label} style={{ padding: 18 }}><p className="workspace-eyebrow">{label}</p><strong style={{ fontSize: 24 }}>{value}</strong></section>)}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
      <section className="workspace-panel" style={{ padding: 20 }}>
        <h3>Account &amp; owner</h3>
        <p><strong>{workspace.owner.name}</strong><br />{workspace.owner.email}</p>
        <p>{workspace.email ?? 'No business email'}{workspace.phone ? ` · ${workspace.phone}` : ''}</p>
        {workspace.website && <p><a href={workspace.website} target="_blank" rel="noreferrer">{workspace.website}</a></p>}
        <p>Owner account: {workspace.owner.mfaEnabled ? 'MFA enabled' : 'MFA not enabled'}</p>
        <p>Plan: {workspace.subscription ? `${workspace.subscription.plan} · ${workspace.subscription.billingInterval.toLowerCase()} · ${workspace.subscription.simulated ? 'simulated billing' : 'provider billing'}` : 'No subscription record'}</p>
      </section>
      <section className="workspace-panel" style={{ padding: 20 }}>
        <h3>Team ({workspace.members.length})</h3>
        {workspace.members.length ? <ul style={{ paddingLeft: 18 }}>{workspace.members.map(member => <li key={member.id} style={{ margin: '10px 0' }}><strong>{member.name}</strong> · {member.teamRole.toLowerCase()}<small style={{ display: 'block' }}>{member.email}</small></li>)}</ul> : <p>No additional team members are linked to this workspace.</p>}
      </section>
    </div>

    <section className="workspace-panel quote-list-panel">
      <div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Recent quotes</h3><p>Latest activity and delivery status</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Quote</th><th>Customer</th><th>Total</th><th>Status</th><th>Delivery</th><th>Updated</th></tr></thead><tbody>
        {recentQuotes.map(quote => <tr key={quote.id}><td><strong>{quote.documentNumber}</strong></td><td>{quote.customer.name}</td><td>{formatMoney(quote.total, quote.currency)}</td><td>{quote.status}</td><td>{quote.delivery?.status ?? 'Not sent'}{quote.delivery?.errorMessage ? <small>{quote.delivery.errorMessage}</small> : null}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(quote.updatedAt))}</td></tr>)}
      </tbody></table></div>
      {!recentQuotes.length && <div className="panel-empty">No quotes yet.</div>}
    </section>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Recent jobs</h3></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Job</th><th>Status</th><th>Updated</th></tr></thead><tbody>{recentJobs.map(job => <tr key={job.id}><td><strong>{job.title}</strong></td><td>{job.status.replaceAll('_', ' ')}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(job.updatedAt))}</td></tr>)}</tbody></table></div>{!recentJobs.length && <div className="panel-empty">No jobs yet.</div>}</section>
      <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Recent invoices</h3></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Balance</th></tr></thead><tbody>{recentInvoices.map(invoice => <tr key={invoice.id}><td><strong>{invoice.invoiceNumber}</strong></td><td>{invoice.status.replaceAll('_', ' ')}</td><td>{formatMoney(invoice.total, invoice.currency)}</td><td>{formatMoney(invoice.balanceDue, invoice.currency)}</td></tr>)}</tbody></table></div>{!recentInvoices.length && <div className="panel-empty">No invoices yet.</div>}</section>
    </div>
  </section>
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
