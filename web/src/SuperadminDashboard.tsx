import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'
import PwaControls from './PwaControls'
import './Workspace.css'

type WorkspaceRow = {
  id: string
  status: string
  archivedAt?: string | null
  archivedByEmail?: string | null
  archiveReason?: string | null
  statusBeforeArchive?: string | null
  unarchivedAt?: string | null
  unarchivedByEmail?: string | null
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
type AdminSession = { id: string; createdAt: string; expiresAt: string; deviceType: string; deviceLabel: string | null; ipAddress: string | null; lastSeenAt: string; mfaVerifiedAt: string | null }
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
type PlatformRevenue = {
  range: string
  from: string
  to: string
  collected: Array<{ currency: string; amount: number; payments: number }>
  paymentStates: Array<{ status: string; count: number }>
  subscriptions: Array<{ status: string; count: number }>
  activeUsers: number
  activeSessions: number
  devices: Array<{ type: string; count: number }>
  issues: { failedWebhooks: number; deliveryIssues: number; subscriberInvoiceReconciliation: number }
  recentPayments: Array<{ id: string; plan: string; amount: number; currency: string; paidAt: string | null; providerReference: string | null; organisation: { id: string; name: string | null; owner: { name: string; email: string } } }>
}

type PlatformPlanPrice = { plan: string; amount: number | null; currency: string; source: 'ADMIN' | 'ENVIRONMENT' | 'UNSET' }

type User = { id: string; name: string; email: string; role: string }

type SuperadminPage = 'revenue' | 'workspaces' | 'accounts' | 'settings' | 'reports'
type PlatformSettingsSection = 'operations' | 'billing' | 'system'

type PaginatedWorkspaces = { workspaces: WorkspaceRow[]; totalCount: number; hasMore: boolean }

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
  const [page, setPage] = useState<SuperadminPage>('revenue')
  const [settingsSection, setSettingsSection] = useState<PlatformSettingsSection>('operations')
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [workspacesHasMore, setWorkspacesHasMore] = useState(false)
  const [workspacesTotal, setWorkspacesTotal] = useState(0)
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetailData | null>(null)
  const [workspaceDetailLoading, setWorkspaceDetailLoading] = useState(false)
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = useState(false)
  useEffect(() => {
    if (!workspaceDrawerOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceDrawerOpen(false)
        setWorkspaceDetail(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [workspaceDrawerOpen])
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false)
  const [workspaceActionBusy, setWorkspaceActionBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [workspaceStatusFilter, setWorkspaceStatusFilter] = useState('CURRENT')
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
  const [platformRevenue, setPlatformRevenue] = useState<PlatformRevenue | null>(null)
  const [platformRevenueRange, setPlatformRevenueRange] = useState('30d')
  const [platformRevenueLoading, setPlatformRevenueLoading] = useState(false)
  const [planPrices, setPlanPrices] = useState<PlatformPlanPrice[]>([])
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({ STARTER: '', GROWTH: '', TEAM: '' })
  const [priceReason, setPriceReason] = useState('')
  const [priceMessage, setPriceMessage] = useState('')
  const [priceBusy, setPriceBusy] = useState(false)
  const [updateFeature, setUpdateFeature] = useState('')
  const [updateTitle, setUpdateTitle] = useState('')
  const [updateDetails, setUpdateDetails] = useState('')
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)

  const WORKSPACE_PAGE_SIZE = 50
  const loadAll = async () => {
    const wsRes = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?limit=${WORKSPACE_PAGE_SIZE}&status=${encodeURIComponent(workspaceStatusFilter)}`)
    setWorkspaces(wsRes.workspaces)
    setWorkspacesHasMore(wsRes.hasMore)
    setWorkspacesTotal(wsRes.totalCount)
  }

  const loadPlatformRevenue = async (range = platformRevenueRange) => {
    setPlatformRevenueLoading(true)
    try { setPlatformRevenue(await apiRequest<PlatformRevenue>(`/api/superadmin/revenue?range=${encodeURIComponent(range)}`)) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load platform revenue.') }
    finally { setPlatformRevenueLoading(false) }
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

  const publishProductUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUpdateBusy(true)
    setUpdateMessage('')
    setError('')
    try {
      const result = await apiRequest<{ message: string }>('/api/superadmin/product-updates', {
        method: 'POST',
        body: JSON.stringify({ feature: updateFeature, title: updateTitle, details: updateDetails }),
      })
      setUpdateMessage(result.message)
      setUpdateFeature('')
      setUpdateTitle('')
      setUpdateDetails('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the product update.')
    } finally { setUpdateBusy(false) }
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
      if (page === 'settings' && settingsSection === 'operations') await loadOperations()
      if (page === 'reports') await loadPlatformReport()
      if (page === 'revenue') await loadPlatformRevenue()
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
      const query = new URLSearchParams({ limit: String(WORKSPACE_PAGE_SIZE), offset: String(workspaces.length), status: workspaceStatusFilter, ...(search.trim() ? { q: search.trim() } : {}) })
      const res = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?${query}`)
      setWorkspaces((current) => [...current, ...res.workspaces])
      setWorkspacesHasMore(res.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more workspaces.')
    } finally {
      setLoadingMore(false)
    }
  }

  const openWorkspace = async (id: string, inDrawer = false) => {
    setWorkspaceDrawerOpen(inDrawer)
    setWorkspaceDetailLoading(true)
    setWorkspaceDetail(null)
    setError('')
    try {
      setWorkspaceDetail(await apiRequest<WorkspaceDetailData>(`/api/superadmin/workspaces/${encodeURIComponent(id)}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace details.')
    } finally { setWorkspaceDetailLoading(false) }
  }

  const updateWorkspaceLifecycle = async (id: string, action: 'suspend' | 'restore' | 'archive' | 'unarchive', reason = '') => {
    setWorkspaceActionBusy(true)
    setError('')
    try {
      await apiRequest(`/api/superadmin/workspaces/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(['suspend', 'archive'].includes(action) ? { reason } : {}) })
      await loadAll()
      await openWorkspace(id, workspaceDrawerOpen)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} workspace.`)
    } finally { setWorkspaceActionBusy(false) }
  }

  const updateWorkspacePlan = async (id: string, plan: string, reason: string) => {
    setWorkspaceActionBusy(true)
    setError('')
    try {
      await apiRequest(`/api/superadmin/workspaces/${encodeURIComponent(id)}/plan`, { method: 'POST', body: JSON.stringify({ plan, reason }) })
      await loadAll()
      await openWorkspace(id, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the workspace plan.')
    } finally { setWorkspaceActionBusy(false) }
  }

  const approveWorkspace = async (id: string, reason: string) => {
    setWorkspaceActionBusy(true)
    setError('')
    try {
      await apiRequest(`/api/superadmin/workspaces/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ reason }) })
      await loadAll()
      await openWorkspace(id, workspaceDrawerOpen)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve workspace.')
    } finally { setWorkspaceActionBusy(false) }
  }

  const permanentlyDeleteWorkspace = async (id: string, confirmName: string, reason: string) => {
    setWorkspaceActionBusy(true)
    setError('')
    try {
      const result = await apiRequest<{ storageCleanupPending: number }>(`/api/superadmin/workspaces/${encodeURIComponent(id)}/permanent-delete`, { method: 'POST', body: JSON.stringify({ confirmName, reason }) })
      setWorkspaceDrawerOpen(false)
      setWorkspaceDetail(null)
      await loadAll()
      if (result.storageCleanupPending > 0) setError(`Workspace data was deleted, but ${result.storageCleanupPending} uploaded file(s) need storage cleanup. Check the API logs.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not permanently delete the workspace.')
    } finally { setWorkspaceActionBusy(false) }
  }

  useEffect(() => {
    if (page !== 'workspaces' || (workspaceDetail && !workspaceDrawerOpen)) return
    const timer = window.setTimeout(async () => {
      setWorkspaceSearchLoading(true)
      try {
        const query = new URLSearchParams({ limit: String(WORKSPACE_PAGE_SIZE), status: workspaceStatusFilter, ...(search.trim() ? { q: search.trim() } : {}) })
        const result = await apiRequest<PaginatedWorkspaces>(`/api/superadmin/workspaces?${query}`)
        setWorkspaces(result.workspaces)
        setWorkspacesHasMore(result.hasMore)
        setWorkspacesTotal(result.totalCount)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Workspace search failed.')
      } finally { setWorkspaceSearchLoading(false) }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [page, search, workspaceStatusFilter, workspaceDetail, workspaceDrawerOpen])

  useEffect(() => {
    if (page !== 'settings' || settingsSection !== 'system') return
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
  }, [page, settingsSection, auditSearch])

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
    if (page === 'settings' && settingsSection === 'operations') { void loadOperations(); void loadNcbaConfig() }
  }, [page, settingsSection])

  useEffect(() => {
    if (page === 'reports') void loadPlatformReport(platformReportRange)
  }, [page, platformReportRange])

  useEffect(() => {
    if (page === 'revenue') void loadPlatformRevenue(platformRevenueRange)
  }, [page, platformRevenueRange])

  useEffect(() => {
    if (page === 'settings' && settingsSection === 'billing') void loadPlanPrices()
  }, [page, settingsSection])

  const filteredWorkspaces = workspaces

  const heading = page === 'revenue' ? 'Revenue' : page === 'workspaces' ? 'Workspace Management' : page === 'accounts' ? 'Users & devices' : page === 'settings' ? 'Platform Settings' : 'Subscriber Reports'

  const openSecurity = async () => {
    setPage('settings')
    setSettingsSection('system')
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
        <a className="brand brand-workspace" href="#revenue" onClick={(e) => { e.preventDefault(); setPage('revenue') }}>
          <span className="brand-mark">iQ</span><span className="brand-word">i<span className="brand-q">Q</span>uote<span className="brand-period">.</span> Admin</span>
        </a>
        <div className="sidebar-caption">Superadmin</div>
        <nav className="app-navigation" aria-label="Superadmin navigation">
          {([['revenue', 'Revenue', '₭'], ['workspaces', 'Workspaces', '▦'], ['accounts', 'Users & devices', '♙'], ['reports', 'Subscriber reports', '▥'], ['settings', 'Platform settings', '⚙']] as const).map(([key, label, glyph]) => (
            <button key={key} type="button" className={`app-nav-item ${page === key ? 'active' : ''}`} onClick={() => { setWorkspaceDetail(null); setPage(key); if (key === 'settings') setSettingsSection('operations'); if (key !== 'accounts') setSelectedAccount(null) }}>
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

        {page === 'revenue' && <section className="workspace-content admin-revenue-page">
          <div className="list-toolbar"><div><p className="workspace-eyebrow">Platform subscriptions</p><h2>Collected revenue</h2><p>Confirmed NCBA subscription payments only. Tenant invoice collections are reported separately.</p></div><label className="workspace-eyebrow">Period <select className="input-control" value={platformRevenueRange} onChange={(event) => setPlatformRevenueRange(event.target.value)}><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option><option value="365d">1 year</option></select></label></div>
          {platformRevenueLoading && !platformRevenue ? <div className="workspace-loading">Loading revenue and platform health…</div> : platformRevenue && <>
            <div className="admin-dashboard-metrics">
              <article className="workspace-panel"><span>Active subscribers</span><strong>{platformRevenue.subscriptions.find((item) => item.status === 'ACTIVE')?.count ?? 0}</strong><small>Real, non-simulated plans</small></article>
              <article className="workspace-panel"><span>Active users</span><strong>{platformRevenue.activeUsers}</strong><small>{platformRevenue.activeSessions} active sessions · maximum 2 per user</small></article>
              <article className="workspace-panel"><span>Platform issues</span><strong>{platformRevenue.issues.failedWebhooks + platformRevenue.issues.deliveryIssues + platformRevenue.issues.subscriberInvoiceReconciliation}</strong><small>Webhook, email, and subscriber reconciliation</small></article>
              <article className="workspace-panel"><span>Payment attempts</span><strong>{platformRevenue.paymentStates.reduce((sum, item) => sum + item.count, 0)}</strong><small>Subscription checkout activity in this period</small></article>
            </div>
            <div className="admin-revenue-grid">
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar"><div><h3>Subscription revenue by currency</h3><p>Successful payment records grouped without mixing currencies.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Currency</th><th>Collected</th><th>Payments</th></tr></thead><tbody>{platformRevenue.collected.map((row) => <tr key={row.currency}><td><strong>{row.currency}</strong></td><td>{formatMoney(row.amount, row.currency)}</td><td>{row.payments}</td></tr>)}</tbody></table></div>{!platformRevenue.collected.length && <div className="panel-empty">No confirmed subscription payments in this period.</div>}</section>
              <section className="workspace-panel" style={{ padding: 20 }}><h3>Subscriptions and checkout</h3><div className="admin-revenue-status-grid">{platformRevenue.subscriptions.map((row) => <p key={row.status}>{row.status.replaceAll('_', ' ')} <strong>{row.count}</strong></p>)}</div><hr />{platformRevenue.paymentStates.map((row) => <p key={row.status}>{row.status.replaceAll('_', ' ')} <strong>{row.count}</strong></p>)}</section>
              <section className="workspace-panel" style={{ padding: 20 }}><h3>Issues to review</h3><p>Failed webhooks <strong>{platformRevenue.issues.failedWebhooks}</strong></p><p>Failed or bounced quote emails <strong>{platformRevenue.issues.deliveryIssues}</strong></p><p>Subscriber invoice mismatches <strong>{platformRevenue.issues.subscriberInvoiceReconciliation}</strong></p><button type="button" className="dashboard-text-link" onClick={() => { setPage('settings'); setSettingsSection('operations') }}>Open system operations →</button></section>
              <section className="workspace-panel" style={{ padding: 20 }}><h3>Sessions and gadgets</h3><p>Mobile devices <strong>{platformRevenue.devices.find((device) => device.type === 'MOBILE')?.count ?? 0}</strong></p><p>Desktop devices <strong>{platformRevenue.devices.find((device) => device.type === 'DESKTOP')?.count ?? 0}</strong></p><p>Each account can keep one phone and one desktop session active.</p><button type="button" className="dashboard-text-link" onClick={() => setPage('accounts')}>Manage users and devices →</button></section>
            </div>
            <section className="workspace-panel quote-list-panel"><div className="list-toolbar"><div><h3>Recent subscription payments</h3><p>Confirmed platform collections, not tenant invoice payments.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Paid</th><th>Workspace</th><th>Owner</th><th>Package</th><th>Amount</th><th>Provider reference</th></tr></thead><tbody>{platformRevenue.recentPayments.map((payment) => <tr key={payment.id}><td>{payment.paidAt ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payment.paidAt)) : '—'}</td><td>{payment.organisation.name ?? 'Unnamed workspace'}</td><td>{payment.organisation.owner.name}<small>{payment.organisation.owner.email}</small></td><td>{payment.plan}</td><td>{formatMoney(payment.amount, payment.currency)}</td><td>{payment.providerReference ?? '—'}</td></tr>)}</tbody></table></div>{!platformRevenue.recentPayments.length && <div className="panel-empty">No confirmed subscription payments in this period.</div>}</section>
          </>}
        </section>}

        {page === 'settings' && <section className="workspace-content">
          <div className="list-toolbar"><div><p className="workspace-eyebrow">Platform configuration</p><h2>Settings</h2><p>Manage platform services, payment configuration, and subscription pricing.</p></div></div>
          <div className="admin-settings-nav" role="tablist" aria-label="Platform settings sections">
            <button type="button" role="tab" aria-selected={settingsSection === 'operations'} className={`app-nav-item ${settingsSection === 'operations' ? 'active' : ''}`} onClick={() => setSettingsSection('operations')}>Operations</button>
            <button type="button" role="tab" aria-selected={settingsSection === 'billing'} className={`app-nav-item ${settingsSection === 'billing' ? 'active' : ''}`} onClick={() => setSettingsSection('billing')}>Billing &amp; plans</button>
            <button type="button" role="tab" aria-selected={settingsSection === 'system'} className={`app-nav-item ${settingsSection === 'system' ? 'active' : ''}`} onClick={() => void openSecurity()}>System management</button>
          </div>
        </section>}

        {page === 'settings' && settingsSection === 'billing' && <section className="workspace-content">
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
          <>
          <section className="workspace-content">
            <div className="list-toolbar">
              <div><p className="workspace-eyebrow">Platform</p><h2>All client workspaces</h2></div>
            </div>
            <div className="filter-row">
              <input className="input-control search-control" type="search" placeholder="Search business, owner, email, country, or type" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select className="input-control" value={workspaceStatusFilter} onChange={(event) => setWorkspaceStatusFilter(event.target.value)} aria-label="Filter workspaces by lifecycle status"><option value="CURRENT">Current and pending</option><option value="PENDING">Pending approval</option><option value="SUSPENDED">Suspended</option><option value="ARCHIVED">Archived</option><option value="ALL">All workspaces</option></select>
              <span className="workspace-eyebrow" aria-live="polite">{workspaceSearchLoading ? 'Searching…' : `${workspacesTotal} workspaces`}</span>
            </div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Business</th><th>Owner</th><th>Country</th><th>Workspace</th><th>Plan</th><th>Quotes</th><th>Value quoted</th><th>Customers</th><th>Joined</th><th>Actions</th></tr></thead>
                  <tbody>
                    {filteredWorkspaces.map((ws) => (
                      <tr key={ws.id}>
                        <td><button type="button" className="dashboard-text-link" onClick={() => void openWorkspace(ws.id, true)}>{ws.name} →</button><small>{ws.businessType ?? 'General'}</small></td>
                        <td>{ws.owner.name}<small>{ws.owner.email}</small></td>
                        <td>{ws.country ?? '—'}</td>
                        <td><span className={`workspace-state ${ws.status === 'SUSPENDED' ? 'suspended' : ws.status === 'ARCHIVED' ? 'archived' : ws.status === 'PENDING' ? 'pending' : 'active'}`}>{ws.status === 'SUSPENDED' ? 'Suspended' : ws.status === 'ARCHIVED' ? 'Archived' : ws.status === 'PENDING' ? 'Pending approval' : 'Active'}</span></td>
                        <td><span className={planBadgeClass(ws.subscription?.status ?? '')}>{ws.subscription?.plan ?? 'FREE'}<small>{trialStatus(ws)}</small></span></td>
                        <td>{ws.quoteCount}</td>
                        <td>{formatMoney(ws.totalQuotedValue, ws.currency)}</td>
                        <td>{ws.customerCount}</td>
                        <td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(ws.createdAt))}</td>
                        <td><button type="button" className="workspace-row-menu" aria-label={`Open controls for ${ws.name}`} title="Workspace controls" onClick={() => void openWorkspace(ws.id, true)}>⋮</button></td>
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
          {workspaceDrawerOpen && <div className="workspace-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setWorkspaceDrawerOpen(false); setWorkspaceDetail(null) } }}>
            <aside className="workspace-drawer" role="dialog" aria-modal="true" aria-label={workspaceDetail ? `${workspaceDetail.workspace.name} workspace controls` : 'Workspace controls'}>
              <button type="button" className="workspace-drawer-close" aria-label="Close workspace controls" onClick={() => { setWorkspaceDrawerOpen(false); setWorkspaceDetail(null) }}>×</button>
              {workspaceDetailLoading || !workspaceDetail ? <div className="workspace-loading">Loading workspace controls…</div> : <WorkspaceDetailView data={workspaceDetail} actionBusy={workspaceActionBusy} onApprove={(reason) => approveWorkspace(workspaceDetail.workspace.id, reason)} onSuspend={(reason) => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'suspend', reason)} onRestore={() => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'restore')} onArchive={(reason) => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'archive', reason)} onUnarchive={() => updateWorkspaceLifecycle(workspaceDetail.workspace.id, 'unarchive')} onChangePlan={(plan, reason) => updateWorkspacePlan(workspaceDetail.workspace.id, plan, reason)} onDelete={(confirmName, reason) => permanentlyDeleteWorkspace(workspaceDetail.workspace.id, confirmName, reason)} onBack={() => { setWorkspaceDrawerOpen(false); setWorkspaceDetail(null) }} />}
            </aside>
          </div>}
          </>
        )}

        {page === 'accounts' && (
          <section className="workspace-content">
            {selectedAccount ? <>
              <div className="list-toolbar"><div><button className="dashboard-text-link" type="button" onClick={() => setSelectedAccount(null)}>← All users</button><p className="workspace-eyebrow" style={{ marginTop: 12 }}>Account support</p><h2>{selectedAccount.name}</h2><p>{selectedAccount.email} · {selectedAccount.role === 'SUPERADMIN' ? 'Super-admin' : 'User'}</p></div><button type="button" className="quiet-button danger-button" disabled={accountsLoading || selectedAccount.id === user.id || accountSessions.length === 0} onClick={() => void revokeAccountSession(selectedAccount)}>{accountsLoading ? 'Updating…' : `Revoke all sessions (${accountSessions.length})`}</button></div>
              <section className="workspace-panel" style={{ padding: 20 }}><div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}><p>MFA: <strong>{selectedAccount.mfaEnabled ? 'Enabled' : 'Not enabled'}</strong></p><p>Joined: <strong>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(selectedAccount.createdAt))}</strong></p><p>Active sessions: <strong>{accountSessions.length}</strong></p><p>Workspace: <strong>{selectedAccount.workspace?.name ?? 'None'}</strong>{selectedAccount.workspace?.status === 'SUSPENDED' ? ' · Suspended' : ''}</p></div>{selectedAccount.id === user.id && <p className="workspace-eyebrow">Your current admin session is protected from this control.</p>}</section>
              <section className="workspace-panel quote-list-panel"><div className="list-toolbar" style={{ padding: '18px 18px 8px' }}><div><h3>Active sessions and devices</h3><p>Each account has one mobile and one desktop slot. Signing in again replaces the earlier session in that device category.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Device</th><th>IP</th><th>Last active</th><th>Started</th><th>Expires</th><th>MFA</th><th>Action</th></tr></thead><tbody>
                {accountSessions.map((session) => <tr key={session.id}><td><strong>{session.deviceLabel ?? (session.deviceType === 'MOBILE' ? 'Mobile device' : 'Desktop device')}</strong><small>{session.deviceType === 'MOBILE' ? 'Phone / tablet' : 'Desktop'} · <code>{session.id.slice(0, 8)}</code></small></td><td>{session.ipAddress ?? '—'}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.lastSeenAt))}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.createdAt))}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}</td><td>{session.mfaVerifiedAt ? 'Verified' : 'No'}</td><td><button type="button" className="dashboard-text-link danger-text" disabled={accountsLoading || selectedAccount.id === user.id} onClick={() => void revokeAccountSession(selectedAccount, session.id)}>Revoke</button></td></tr>)}
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

        {page === 'settings' && settingsSection === 'operations' && (
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
            <section className="workspace-panel product-update-admin" style={{ padding: 20 }}>
              <div className="list-toolbar" style={{ padding: 0, marginBottom: 14 }}><div><p className="workspace-eyebrow">Customer communication</p><h3>Publish a dashboard update</h3><p>Owners of active workspaces will see this in What’s new. It will not interrupt their work or send email.</p></div></div>
              <form className="onboarding-form" onSubmit={(event) => void publishProductUpdate(event)}>
                <div className="admin-ncba-fields">
                  <label>Feature area<input className="input-control" required maxLength={80} value={updateFeature} onChange={(event) => setUpdateFeature(event.target.value)} placeholder="For example: Invoices" /></label>
                  <label>Update title<input className="input-control" required minLength={4} maxLength={120} value={updateTitle} onChange={(event) => setUpdateTitle(event.target.value)} placeholder="For example: Faster invoice payments" /></label>
                </div>
                <label>What changed<textarea className="input-control" required minLength={10} maxLength={1600} rows={4} value={updateDetails} onChange={(event) => setUpdateDetails(event.target.value)} placeholder="Explain what changed and where the owner can find it." /></label>
                <div className="admin-pricing-actions"><span role="status">{updateMessage}</span><button className="button button-primary" type="submit" disabled={updateBusy}>{updateBusy ? 'Publishing…' : 'Publish to workspace owners'}</button></div>
              </form>
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
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Paying customers</p><h2>Subscriber business reports</h2><p>Only active, non-simulated subscriber workspaces are included. Quotes, invoices, payments, and balances stay separate and currency-specific.</p></div><label className="workspace-eyebrow">Period <select className="input-control" value={platformReportRange} onChange={(event) => setPlatformReportRange(event.target.value)}><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option><option value="365d">1 year</option></select></label></div>
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

        {page === 'settings' && settingsSection === 'system' && (
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

        {page === 'settings' && settingsSection === 'system' && (
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

function WorkspaceDetailView({ data, actionBusy, onApprove, onSuspend, onRestore, onArchive, onUnarchive, onChangePlan, onDelete, onBack }: { data: WorkspaceDetailData; actionBusy: boolean; onApprove: (reason: string) => void; onSuspend: (reason: string) => void; onRestore: () => void; onArchive: (reason: string) => void; onUnarchive: () => void; onChangePlan: (plan: string, reason: string) => void; onDelete: (confirmName: string, reason: string) => void; onBack: () => void }) {
  const [suspensionReason, setSuspensionReason] = useState('')
  const [archiveReason, setArchiveReason] = useState('')
  const [approvalReason, setApprovalReason] = useState('')
  const [selectedPlan, setSelectedPlan] = useState(data.workspace.subscription?.plan ?? 'STARTER')
  const [planReason, setPlanReason] = useState('')
  const [deleteName, setDeleteName] = useState('')
  const [deleteReason, setDeleteReason] = useState('')
  const { workspace, recentQuotes, recentJobs, recentInvoices } = data
  const joined = new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(workspace.createdAt))
  return <section className="workspace-content workspace-detail-page workspace-drawer-content">
    <div className="list-toolbar">
      <div><button className="dashboard-text-link" type="button" onClick={onBack}>← All workspaces</button><p className="workspace-eyebrow" style={{ marginTop: 12 }}>Workspace profile · Joined {joined}</p><h2>{workspace.name}</h2><p>{workspace.businessType ?? 'General business'}{workspace.country ? ` · ${workspace.country}` : ''}</p></div>
      <span className={planBadgeClass(workspace.subscription?.status ?? '')}>{workspace.subscription?.plan ?? 'FREE'}<small>{trialStatus(workspace)}</small></span>
    </div>

    <section className="workspace-panel" style={{ padding: 20, borderColor: workspace.status !== 'ACTIVE' ? '#efb3aa' : undefined }}>
      <div className="list-toolbar" style={{ padding: 0 }}><div><h3>Workspace access</h3><p>Current state: <span className={`workspace-state ${workspace.status === 'SUSPENDED' ? 'suspended' : workspace.status === 'ARCHIVED' ? 'archived' : 'active'}`}>{workspace.status === 'ARCHIVED' ? 'Archived' : workspace.status === 'SUSPENDED' ? 'Suspended' : 'Active'}</span></p></div></div>
      {workspace.suspendedAt && <div style={{ marginTop: 14 }}><p><strong>Last suspension reason:</strong> {workspace.suspensionReason}</p><small>Suspended {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.suspendedAt))} by {workspace.suspendedByEmail ?? 'super-admin'}.</small>{workspace.restoredAt && <p><small>Restored {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.restoredAt))} by {workspace.restoredByEmail ?? 'super-admin'}.</small></p>}</div>}
      {workspace.archivedAt && <div style={{ marginTop: 14 }}><p><strong>Archive reason:</strong> {workspace.archiveReason}</p><small>Archived {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.archivedAt))} by {workspace.archivedByEmail ?? 'super-admin'}. Workspace data is retained; customer links are unavailable until restored.</small>{workspace.unarchivedAt && <p><small>Last restored from archive {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(workspace.unarchivedAt))} by {workspace.unarchivedByEmail ?? 'super-admin'}.</small></p>}</div>}
      {workspace.status === 'ARCHIVED' ? <div style={{ marginTop: 14 }}><button type="button" className="quiet-button" disabled={actionBusy} onClick={() => { if (window.confirm(`Restore ${workspace.name} from archive? This restores its previous ${workspace.statusBeforeArchive === 'SUSPENDED' ? 'suspended' : 'active'} state.`)) onUnarchive() }}>{actionBusy ? 'Restoring…' : 'Restore from archive'}</button></div> : <>
        {workspace.status === 'PENDING' ? <form className="workspace-suspend-form" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Approve ${workspace.name} and allow workspace access?`)) onApprove(approvalReason) }}><label htmlFor="workspace-approval-reason">Approval reason required</label><input id="workspace-approval-reason" className="input-control" minLength={5} maxLength={500} value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} placeholder="For example: business verification completed" required /><button type="submit" className="quiet-button" disabled={actionBusy || approvalReason.trim().length < 5}>{actionBusy ? 'Approving…' : 'Approve workspace'}</button></form> : workspace.status === 'SUSPENDED' ? <div style={{ marginTop: 14 }}><button type="button" className="quiet-button" disabled={actionBusy} onClick={() => { if (window.confirm(`Restore access to ${workspace.name}?`)) onRestore() }}>{actionBusy ? 'Restoring…' : 'Restore access'}</button></div> : <form className="workspace-suspend-form" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Suspend ${workspace.name}? The workspace owner and team will lose dashboard access until restored.`)) onSuspend(suspensionReason) }}><label htmlFor="workspace-suspension-reason">Reason required</label><input id="workspace-suspension-reason" className="input-control" minLength={5} maxLength={500} value={suspensionReason} onChange={(event) => setSuspensionReason(event.target.value)} placeholder="For example: billing issue or policy review" required /><button type="submit" className="quiet-button danger-button" disabled={actionBusy || suspensionReason.trim().length < 5}>{actionBusy ? 'Suspending…' : 'Suspend workspace'}</button></form>}
        <form className="workspace-suspend-form workspace-archive-form" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Archive ${workspace.name}? Dashboard access and public quote/project links will be disabled. All workspace data will be retained and can be restored.`)) onArchive(archiveReason) }}><label htmlFor="workspace-archive-reason">Archive reason required</label><input id="workspace-archive-reason" className="input-control" minLength={5} maxLength={500} value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} placeholder="For example: customer requested closure" required /><button type="submit" className="quiet-button danger-button" disabled={actionBusy || archiveReason.trim().length < 5}>{actionBusy ? 'Archiving…' : 'Archive workspace'}</button></form>
      </>}
    </section>

    <section className="workspace-panel workspace-plan-control">
      <h3>Subscription package</h3>
      <p>This is an admin override: package access changes immediately, but it does not charge the customer or record a payment. Billing status and payment history stay unchanged. Archived workspaces must be restored first.</p>
      <form className="workspace-suspend-form" onSubmit={(event) => { event.preventDefault(); onChangePlan(selectedPlan, planReason) }}>
        <label htmlFor="workspace-plan-select">Package</label>
        <select id="workspace-plan-select" className="input-control" value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}><option value="STARTER">Starter</option><option value="GROWTH">Growth</option><option value="TEAM">Team</option></select>
        <label htmlFor="workspace-plan-reason">Reason required</label>
        <input id="workspace-plan-reason" className="input-control" minLength={5} maxLength={500} required value={planReason} onChange={(event) => setPlanReason(event.target.value)} placeholder="For example: approved package change" />
        <button type="submit" className="quiet-button" disabled={actionBusy || data.workspace.status === 'ARCHIVED' || selectedPlan === data.workspace.subscription?.plan || planReason.trim().length < 5}>{actionBusy ? 'Updating…' : 'Apply package'}</button>
      </form>
    </section>

    <section className="workspace-panel workspace-permanent-delete-note">
      <h3>Permanent deletion</h3>
      <p>This permanently deletes this workspace, its quotes, invoices, payments, jobs, customer records, and uploaded job files. Linked users lose this workspace membership and their active sessions are revoked; their login accounts remain. This cannot be undone. Archive the workspace first and download any records you need.</p>
      {workspace.status !== 'ARCHIVED' ? <p><strong>Archive this workspace before permanent deletion is enabled.</strong></p> : <form className="workspace-suspend-form" onSubmit={(event) => { event.preventDefault(); if (window.confirm(`Permanently delete ${workspace.name || 'Unnamed workspace'} and all of its data? This cannot be undone.`)) onDelete(deleteName, deleteReason) }}>
        <label htmlFor="workspace-delete-name">Type the workspace name exactly: <strong>{workspace.name || 'Unnamed workspace'}</strong></label>
        <input id="workspace-delete-name" className="input-control" required autoComplete="off" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} />
        <label htmlFor="workspace-delete-reason">Reason required</label>
        <input id="workspace-delete-reason" className="input-control" minLength={10} maxLength={500} required value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Explain the approved deletion request" />
        <button type="submit" className="quiet-button danger-button" disabled={actionBusy || deleteName !== (workspace.name || 'Unnamed workspace') || deleteReason.trim().length < 10}>{actionBusy ? 'Deleting workspace…' : 'Permanently delete workspace'}</button>
      </form>}
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
