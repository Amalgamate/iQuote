import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney, assetUrl } from './api'
import LogoUpload from './LogoUpload'
import PublicQuote from './PublicQuote'
import QuoteDocument, { type QuoteDocumentData, type QuoteLine } from './QuoteDocument'
import { QuotePdfDownloadLink } from './QuotePdf'
import './Workspace.css'

type User = { id: string; name: string; email: string }
type Business = {
  id: string
  name: string
  email: string | null
  phone: string | null
  country: string | null
  businessType: string | null
  currency: string
  defaultTaxRate: number | string | null
  quotePrefix: string | null
  logoUrl: string | null
  paymentInstructions: string | null
  terms: string | null
  subdomain: string | null
  subscription?: { plan: string; status: string; trialEndsAt: string; simulated: boolean } | null
}
type Customer = { id: string; name: string; phone: string | null; email: string | null }
type ServiceItem = { id: string; name: string; category: string; kind: 'SERVICE' | 'PRODUCT'; description: string | null; unit: string; defaultPrice: number; defaultTaxRate: number | null; isStarter: boolean }
type QuoteTemplate = { id: string; name: string; description: string; workflow: string; lineItems: Array<{ description: string; unit: string }>; defaultNotes: string | null; defaultTerms: string | null; isStarter: boolean }
type ServiceForm = { id: string; name: string; category: string; kind: 'SERVICE' | 'PRODUCT'; description: string; unit: string; defaultPrice: string; defaultTaxRate: string }
type QuoteStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'APPROVED' | 'DECLINED' | 'EXPIRED'
type Quote = QuoteDocumentData & {
  id: string
  publicToken: string | null
  status: QuoteStatus
  createdAt: string
  updatedAt: string
  viewedAt: string | null
  decidedAt: string | null
  decisionComment: string | null
}
type QuoteDraft = {
  customerId: string
  validUntil: string
  notes: string
  terms: string
  lines: QuoteLine[]
}
type Page = 'dashboard' | 'quotes' | 'customers' | 'services' | 'settings' | 'editor'
type ChartRange = '7D' | '30D' | '90D' | '1Y'
type CustomerForm = { id: string; name: string; phone: string; email: string }
type EmailSettings = { provider: 'PLATFORM' | 'CUSTOM'; senderName: string; senderEmail: string; customDomain: string; domainStatus: string; domainRecords: unknown[] | null; apiKeySet: boolean; encryptionReady: boolean; platformSenderAvailable: boolean }
type EmailSettingsForm = { provider: 'PLATFORM' | 'CUSTOM'; senderName: string; senderEmail: string; customDomain: string; apiKey: string }

const blankCustomer: CustomerForm = { id: '', name: '', phone: '', email: '' }
const blankService: ServiceForm = { id: '', name: '', category: '', kind: 'SERVICE', description: '', unit: 'job', defaultPrice: '0', defaultTaxRate: '' }
const emptyBusiness: Omit<Business, 'id'> = {
  name: '', email: '', phone: '', country: 'Kenya', businessType: '', currency: 'KES', defaultTaxRate: '16',
  quotePrefix: 'QT', logoUrl: '', paymentInstructions: '', terms: '', subdomain: null,
}
const statusNames: Record<QuoteStatus, string> = {
  DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', APPROVED: 'Approved', DECLINED: 'Declined', EXPIRED: 'Expired',
}

function statusClass(status: QuoteStatus) { return `quote-status status-${status.toLowerCase()}` }
function roundMoney(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100 }

function quoteTotals(lines: QuoteLine[]) {
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0))
  const taxTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.taxRate || 0) / 100, 0))
  return { subtotal, taxTotal, total: roundMoney(subtotal + taxTotal) }
}

function quoteDraftFrom(quote: Quote): QuoteDraft {
  return {
    customerId: quote.customer.id ?? '',
    validUntil: quote.validUntil ? quote.validUntil.slice(0, 10) : '',
    notes: quote.notes ?? '',
    terms: quote.terms ?? '',
    lines: quote.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, taxRate: line.taxRate })),
  }
}

function documentFromDraft(draft: QuoteDraft, quoteNumber: string, business: Business, customer: Customer | undefined): QuoteDocumentData {
  const totals = quoteTotals(draft.lines)
  return {
    documentNumber: quoteNumber,
    currency: business.currency,
    validUntil: draft.validUntil || null,
    notes: draft.notes,
    terms: draft.terms,
    ...totals,
    lines: draft.lines,
    customer: customer ?? { name: '' },
    organisation: {
      name: business.name,
      email: business.email,
      phone: business.phone,
      country: business.country,
      logoUrl: assetUrl(business.logoUrl),
      paymentInstructions: business.paymentInstructions,
    },
  }
}

export default function QuoteWorkspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const publicMatch = window.location.pathname.match(/^\/quote\/([^/]+)\/?$/)
  if (publicMatch) return <PublicQuote token={decodeURIComponent(publicMatch[1])} />
  return <AuthenticatedWorkspace user={user} onLogout={onLogout} />
}

function AuthenticatedWorkspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<Page>('dashboard')
  const [business, setBusiness] = useState<Business | null>(null)
  const [businessForm, setBusinessForm] = useState(emptyBusiness)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [serviceItems, setServiceItems] = useState<ServiceItem[]>([])
  const [quoteTemplates, setQuoteTemplates] = useState<QuoteTemplate[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [quoteStatusFilter, setQuoteStatusFilter] = useState('ALL')
  const [customerModal, setCustomerModal] = useState(false)
  const [customerForm, setCustomerForm] = useState<CustomerForm>(blankCustomer)
  const [customerError, setCustomerError] = useState('')
  const [serviceModal, setServiceModal] = useState(false)
  const [serviceForm, setServiceForm] = useState<ServiceForm>(blankService)
  const [serviceError, setServiceError] = useState('')
  const [templateModal, setTemplateModal] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [editor, setEditor] = useState<QuoteDraft | null>(null)
  const [editorQuoteId, setEditorQuoteId] = useState<string | null>(null)
  const [editorNumber, setEditorNumber] = useState('')
  const [editorDirty, setEditorDirty] = useState(false)
  const [saveState, setSaveState] = useState('')
  const [quickCustomer, setQuickCustomer] = useState({ name: '', phone: '', email: '' })
  const [showQuickCustomer, setShowQuickCustomer] = useState(false)
  const [sharedUrl, setSharedUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [showMobilePreview, setShowMobilePreview] = useState(false)
  const [businessSaving, setBusinessSaving] = useState(false)
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null)
  const [emailSettingsForm, setEmailSettingsForm] = useState<EmailSettingsForm>({ provider: 'PLATFORM', senderName: '', senderEmail: '', customDomain: '', apiKey: '' })
  const [emailSettingsSaving, setEmailSettingsSaving] = useState(false)
  const [emailSettingsMessage, setEmailSettingsMessage] = useState('')
  const [chartRange, setChartRange] = useState<ChartRange>('30D')
  const editorRef = useRef<QuoteDraft | null>(null)

  useEffect(() => { editorRef.current = editor }, [editor])

  const loadWorkspace = async () => {
    const [businessResponse, customerResponse, quoteResponse, serviceResponse, templateResponse] = await Promise.all([
      apiRequest<{ organisation: Business | null }>('/api/business/me'),
      apiRequest<{ customers: Customer[] }>('/api/customers'),
      apiRequest<{ quotes: Quote[] }>('/api/quotes'),
      apiRequest<{ items: ServiceItem[] }>('/api/service-items'),
      apiRequest<{ templates: QuoteTemplate[] }>('/api/quote-templates'),
    ])
    if (!businessResponse.organisation) throw new Error('Your business profile is missing. Sign out and complete setup again.')
    setBusiness(businessResponse.organisation)
    setBusinessForm({ ...emptyBusiness, ...businessResponse.organisation })
    setCustomers(customerResponse.customers)
    setQuotes(quoteResponse.quotes)
    setServiceItems(serviceResponse.items)
    setQuoteTemplates(templateResponse.templates)
    try {
      const emailResponse = await apiRequest<EmailSettings>('/api/settings/email')
      setEmailSettings(emailResponse)
      setEmailSettingsForm({ provider: emailResponse.provider, senderName: emailResponse.senderName, senderEmail: emailResponse.senderEmail, customDomain: emailResponse.customDomain, apiKey: '' })
    } catch { /* workspace remains usable when the email settings table is not migrated yet */ }
  }

  useEffect(() => {
    loadWorkspace().catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load your workspace.'))
      .finally(() => setLoading(false))
  }, [])

  const filteredCustomers = useMemo(() => {
    const query = search.trim().toLowerCase()
    return customers.filter((customer) => !query || [customer.name, customer.phone ?? '', customer.email ?? ''].some((value) => value.toLowerCase().includes(query)))
  }, [customers, search])
  const filteredQuotes = useMemo(() => {
    const query = search.trim().toLowerCase()
    return quotes.filter((quote) => (quoteStatusFilter === 'ALL' || quote.status === quoteStatusFilter)
      && (!query || [quote.documentNumber, quote.customer.name, statusNames[quote.status]].some((value) => value.toLowerCase().includes(query))))
  }, [quotes, quoteStatusFilter, search])
  const filteredServiceItems = useMemo(() => {
    const query = search.trim().toLowerCase()
    return serviceItems.filter((item) => !query || [item.name, item.category, item.description ?? '', item.kind].some((value) => value.toLowerCase().includes(query)))
  }, [serviceItems, search])

  const dashboardStats = useMemo(() => {
    const total = quotes.length
    const approved = quotes.filter((q) => q.status === 'APPROVED').length
    const approvedValue = quotes.filter((q) => q.status === 'APPROVED').reduce((sum, q) => sum + q.total, 0)
    const pending = quotes.filter((q) => ['SENT', 'VIEWED'].includes(q.status)).length
    const draftCount = quotes.filter((q) => q.status === 'DRAFT').length
    const totalRevenue = quotes.filter((q) => ['APPROVED'].includes(q.status)).reduce((sum, q) => sum + q.total, 0)
    const conversionRate = total > 0 ? Math.round((approved / total) * 100) : 0
    return { total, approved, approvedValue, pending, draftCount, totalRevenue, conversionRate }
  }, [quotes])

  const chartData = useMemo(() => {
    const now = new Date()
    const days = chartRange === '7D' ? 7 : chartRange === '30D' ? 30 : chartRange === '90D' ? 90 : 365
    const buckets: { label: string; value: number; count: number }[] = []
    const bucketSize = days <= 7 ? 1 : days <= 30 ? 3 : days <= 90 ? 10 : 30
    const bucketCount = Math.ceil(days / bucketSize)
    for (let i = bucketCount - 1; i >= 0; i--) {
      const end = new Date(now)
      end.setDate(end.getDate() - i * bucketSize)
      const start = new Date(end)
      start.setDate(start.getDate() - (bucketSize - 1))
      const dayQuotes = quotes.filter((q) => {
        const qd = new Date(q.createdAt)
        return qd >= start && qd <= end
      })
      const value = dayQuotes.reduce((sum, q) => sum + q.total, 0)
      const label = bucketSize === 1
        ? end.toLocaleDateString('en-KE', { weekday: 'short' })
        : bucketSize >= 30
          ? end.toLocaleDateString('en-KE', { month: 'short' })
          : `${end.getDate()}/${end.getMonth() + 1}`
      buckets.push({ label, value, count: dayQuotes.length })
    }
    const maxValue = Math.max(...buckets.map((b) => b.value), 1)
    return { buckets, maxValue, totalQuotes: buckets.reduce((s, b) => s + b.count, 0) }
  }, [quotes, chartRange])

  const updateEditor = (patch: Partial<QuoteDraft>) => {
    setEditor((current) => current ? { ...current, ...patch } : current)
    setEditorDirty(true)
    setSaveState('')
  }

  const saveDraft = async (draft: QuoteDraft, id: string | null) => {
    const payload = {
      customerId: draft.customerId,
      validUntil: draft.validUntil || null,
      notes: draft.notes,
      terms: draft.terms,
      lines: draft.lines.map((line) => ({ ...line, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice), taxRate: line.taxRate === null ? null : Number(line.taxRate) })),
    }
    const response = await apiRequest<{ quote: Quote }>(id ? `/api/quotes/${id}` : '/api/quotes', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    setEditorQuoteId(response.quote.id)
    setEditorNumber(response.quote.documentNumber)
    setQuotes((current) => [response.quote, ...current.filter((quote) => quote.id !== response.quote.id)])
    return response.quote
  }

  useEffect(() => {
    if (page !== 'editor' || !editor || !editorDirty || !editor.customerId) return
    const snapshot = editor
    const timer = window.setTimeout(async () => {
      setSaveState('Saving…')
      try {
        const saved = await saveDraft(snapshot, editorQuoteId)
        if (JSON.stringify(editorRef.current) === JSON.stringify(snapshot)) {
          setEditorDirty(false)
          setSaveState(`Saved ${new Intl.DateTimeFormat('en-KE', { hour: 'numeric', minute: '2-digit' }).format(new Date(saved.updatedAt))}`)
        }
      } catch (requestError) {
        setSaveState(requestError instanceof Error ? requestError.message : 'Unable to save draft')
      }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [page, editor, editorDirty, editorQuoteId])

  const startNewQuote = () => {
    if (!customers.length) {
      setPage('customers')
      setError('Add a customer first, then create a quote.')
      return
    }
    setEditor({ customerId: customers[0].id, validUntil: '', notes: '', terms: business?.terms ?? '', lines: [{ description: '', quantity: 1, unit: 'unit', unitPrice: 0, taxRate: Number(business?.defaultTaxRate ?? 0) }] })
    setEditorQuoteId(null)
    setEditorNumber(`${business?.quotePrefix || 'QT'}-${new Date().getFullYear()}-Draft`)
    setEditorDirty(false)
    setSaveState('')
    setSharedUrl('')
    setPage('editor')
  }

  const openQuote = async (quote: Quote) => {
    if (quote.status !== 'DRAFT' && quote.publicToken) {
      window.open(`/quote/${encodeURIComponent(quote.publicToken)}`, '_blank', 'noopener,noreferrer')
      return
    }
    setError('')
    setSaveState('Loading quote…')
    try {
      const response = await apiRequest<{ quote: Quote }>(`/api/quotes/${quote.id}`)
      setEditor(quoteDraftFrom(response.quote))
      setEditorQuoteId(response.quote.id)
      setEditorNumber(response.quote.documentNumber)
      setEditorDirty(false)
      setPage('editor')
      setSharedUrl('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to open quote.')
    } finally {
      setSaveState('')
    }
  }

  const addLine = () => updateEditor({ lines: [...(editor?.lines ?? []), { description: '', quantity: 1, unit: 'unit', unitPrice: 0, taxRate: Number(business?.defaultTaxRate ?? 0) }] })
  const addServiceItemToQuote = (itemId: string) => {
    const item = serviceItems.find((candidate) => candidate.id === itemId)
    if (!editor || !item) return
    updateEditor({ lines: [...editor.lines, { description: item.name, quantity: 1, unit: item.unit, unitPrice: item.defaultPrice, taxRate: item.defaultTaxRate ?? Number(business?.defaultTaxRate ?? 0) }] })
  }

  const applyQuoteTemplate = (templateId: string) => {
    const template = quoteTemplates.find((candidate) => candidate.id === templateId)
    if (!editor || !template) return
    updateEditor({
      notes: template.defaultNotes ?? editor.notes,
      terms: template.defaultTerms ?? editor.terms,
      lines: template.lineItems.map((line) => ({ description: line.description, quantity: 1, unit: line.unit, unitPrice: 0, taxRate: Number(business?.defaultTaxRate ?? 0) })),
    })
  }

  const openServiceForm = (item?: ServiceItem) => {
    setServiceError('')
    setServiceForm(item ? { id: item.id, name: item.name, category: item.category, kind: item.kind, description: item.description ?? '', unit: item.unit, defaultPrice: String(item.defaultPrice), defaultTaxRate: item.defaultTaxRate === null ? '' : String(item.defaultTaxRate) } : blankService)
    setServiceModal(true)
  }

  const saveServiceItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setServiceError('')
    const isUpdate = Boolean(serviceForm.id)
    const payload = { name: serviceForm.name, category: serviceForm.category, kind: serviceForm.kind, description: serviceForm.description, unit: serviceForm.unit, defaultPrice: Number(serviceForm.defaultPrice), defaultTaxRate: serviceForm.defaultTaxRate === '' ? null : Number(serviceForm.defaultTaxRate) }
    try {
      const response = await apiRequest<{ item: ServiceItem }>(isUpdate ? `/api/service-items/${serviceForm.id}` : '/api/service-items', { method: isUpdate ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      setServiceItems((current) => isUpdate ? current.map((item) => item.id === response.item.id ? response.item : item) : [...current, response.item].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)))
      setServiceModal(false)
      setServiceForm(blankService)
    } catch (requestError) {
      setServiceError(requestError instanceof Error ? requestError.message : 'Unable to save this service or product.')
    }
  }

  const archiveServiceItem = async (item: ServiceItem) => {
    try {
      await apiRequest(`/api/service-items/${item.id}`, { method: 'DELETE' })
      setServiceItems((current) => current.filter((candidate) => candidate.id !== item.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to archive this item.')
    }
  }

  const saveQuoteTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editor) return
    try {
      const response = await apiRequest<{ template: QuoteTemplate }>('/api/quote-templates', { method: 'POST', body: JSON.stringify({ name: templateName, description: templateDescription, workflow: 'CUSTOM', lineItems: editor.lines.map(({ description, unit }) => ({ description, unit })), defaultNotes: editor.notes, defaultTerms: editor.terms }) })
      setQuoteTemplates((current) => [...current, response.template].sort((a, b) => Number(b.isStarter) - Number(a.isStarter) || a.name.localeCompare(b.name)))
      setTemplateModal(false)
      setTemplateName('')
      setTemplateDescription('')
      setSaveState('Template saved')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save this quote template.')
    }
  }
  const updateLine = (index: number, field: keyof QuoteLine, value: string) => {
    if (!editor) return
    const lines = editor.lines.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: field === 'description' || field === 'unit' ? value : field === 'taxRate' && value === '' ? null : Number(value) }
      : line)
    updateEditor({ lines })
  }

  const submitCustomer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCustomerError('')
    try {
      const edit = Boolean(customerForm.id)
      const response = await apiRequest<{ customer: Customer }>(edit ? `/api/customers/${customerForm.id}` : '/api/customers', {
        method: edit ? 'PUT' : 'POST',
        body: JSON.stringify({ name: customerForm.name, phone: customerForm.phone, email: customerForm.email }),
      })
      setCustomers((current) => edit ? current.map((item) => item.id === response.customer.id ? response.customer : item) : [response.customer, ...current])
      setCustomerModal(false)
      setCustomerForm(blankCustomer)
      if (!edit && page === 'editor' && editor && !editor.customerId) updateEditor({ customerId: response.customer.id })
    } catch (requestError) {
      setCustomerError(requestError instanceof Error ? requestError.message : 'Unable to save customer.')
    }
  }

  const createQuickCustomer = async () => {
    try {
      const response = await apiRequest<{ customer: Customer }>('/api/customers', { method: 'POST', body: JSON.stringify(quickCustomer) })
      setCustomers((current) => [response.customer, ...current])
      updateEditor({ customerId: response.customer.id })
      setQuickCustomer({ name: '', phone: '', email: '' })
      setShowQuickCustomer(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to add customer.')
    }
  }

  const deleteCustomer = async (customer: Customer) => {
    if (!window.confirm(`Delete ${customer.name}?`)) return
    try {
      await apiRequest(`/api/customers/${customer.id}`, { method: 'DELETE' })
      setCustomers((current) => current.filter((item) => item.id !== customer.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete customer.')
    }
  }

  const handleBusinessSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusinessSaving(true)
    setError('')
    try {
      const response = await apiRequest<{ organisation: Business }>('/api/business/setup', { method: 'POST', body: JSON.stringify(businessForm) })
      setBusiness(response.organisation)
      setBusinessForm({ ...emptyBusiness, ...response.organisation })
      const [serviceResponse, templateResponse] = await Promise.all([
        apiRequest<{ items: ServiceItem[] }>('/api/service-items'),
        apiRequest<{ templates: QuoteTemplate[] }>('/api/quote-templates'),
      ])
      setServiceItems(serviceResponse.items)
      setQuoteTemplates(templateResponse.templates)
      setSaveState('Business profile saved')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save business profile.')
    } finally {
      setBusinessSaving(false)
    }
  }

  const saveEmailSettings = async () => {
    setEmailSettingsSaving(true)
    setEmailSettingsMessage('')
    try {
      const response = await apiRequest<EmailSettings>('/api/settings/email', { method: 'PUT', body: JSON.stringify(emailSettingsForm) })
      setEmailSettings(response)
      setEmailSettingsForm((current) => ({ ...current, apiKey: '' }))
      setEmailSettingsMessage('Email settings saved. Your API key stays encrypted and hidden.')
      return true
    } catch (requestError) {
      setEmailSettingsMessage(requestError instanceof Error ? requestError.message : 'Could not save email settings.')
      return false
    } finally {
      setEmailSettingsSaving(false)
    }
  }

  const setupEmailDomain = async () => {
    setEmailSettingsSaving(true)
    setEmailSettingsMessage('')
    try {
      const savedSettings = await saveEmailSettings()
      if (!savedSettings) return
      const response = await apiRequest<{ domainStatus: string; domainRecords: unknown[] | null }>('/api/settings/email/domain', { method: 'POST' })
      setEmailSettings((current) => current ? { ...current, domainStatus: response.domainStatus, domainRecords: response.domainRecords } : current)
      setEmailSettingsMessage('Resend returned DNS records. Add them at your DNS provider, then check status again after propagation.')
    } catch (requestError) {
      setEmailSettingsMessage(requestError instanceof Error ? requestError.message : 'Could not start domain setup.')
    } finally {
      setEmailSettingsSaving(false)
    }
  }

  const checkEmailDomain = async () => {
    setEmailSettingsSaving(true)
    setEmailSettingsMessage('')
    try {
      const response = await apiRequest<{ domainStatus: string; domainRecords: unknown[] | null }>('/api/settings/email/domain/check', { method: 'POST' })
      setEmailSettings((current) => current ? { ...current, domainStatus: response.domainStatus, domainRecords: response.domainRecords } : current)
      setEmailSettingsMessage(`Domain status: ${response.domainStatus.toLowerCase().replaceAll('_', ' ')}.`)
    } catch (requestError) {
      setEmailSettingsMessage(requestError instanceof Error ? requestError.message : 'Could not check domain status.')
    } finally {
      setEmailSettingsSaving(false)
    }
  }

  const handleEmailSettingsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void saveEmailSettings()
  }

  const shareQuote = async () => {
    if (!editor || !editor.customerId) return
    setError('')
    setEditorDirty(false)
    try {
      setSaveState('Saving…')
      const saved = await saveDraft(editor, editorQuoteId)
      const response = await apiRequest<{ quote: { id: string; publicToken: string } }>(`/api/quotes/${saved.id}/share`, { method: 'POST' })
      const url = `${window.location.origin}/quote/${response.quote.publicToken}`
      setSharedUrl(url)
      setCopied(false)
      setQuotes((current) => current.map((quote) => quote.id === saved.id ? { ...quote, status: 'SENT', publicToken: response.quote.publicToken } : quote))
      setSaveState('Quote shared')
    } catch (requestError) {
      setEditorDirty(true)
      setError(requestError instanceof Error ? requestError.message : 'Unable to share quote.')
      setSaveState('')
    }
  }

  const deleteDraft = async () => {
    if (!editorQuoteId || !window.confirm('Delete this draft quote?')) return
    try {
      await apiRequest(`/api/quotes/${editorQuoteId}`, { method: 'DELETE' })
      setQuotes((current) => current.filter((quote) => quote.id !== editorQuoteId))
      setEditor(null)
      setEditorQuoteId(null)
      setPage('quotes')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete draft.')
    }
  }

  const changePage = (next: Page) => { setError(''); setPage(next); setSearch('') }
  const heading = page === 'dashboard' ? 'Overview' : page === 'quotes' ? 'Quotes' : page === 'customers' ? 'Customers' : page === 'services' ? 'Services & products' : page === 'settings' ? 'Settings' : 'Quote editor'

  if (loading) return <main className="workspace-loading">Loading your workspace…</main>

  return (
    <div className="workspace-root">
      <aside className="app-sidebar">
        <a className="brand brand-workspace" href="#dashboard" onClick={(event) => { event.preventDefault(); changePage('dashboard') }}>
          <span className="brand-mark">iQ</span><span>iQuote<span className="brand-period">.</span></span>
        </a>
        <nav className="app-navigation" aria-label="Workspace navigation">
          <button type="button" className={`app-nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => changePage('dashboard')}>
            <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg></span>
            <span>Dashboard</span>
          </button>
          <button type="button" className={`app-nav-item ${page === 'customers' ? 'active' : ''}`} onClick={() => changePage('customers')}>
            <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg></span>
            <span>Customers</span>
          </button>
          <button type="button" className={`app-nav-item ${page === 'quotes' ? 'active' : ''}`} onClick={() => changePage('quotes')}>
            <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg></span>
            <span>Quotations</span>
            {quotes.length > 0 && <small>{quotes.length}</small>}
          </button>
          <button type="button" className={`app-nav-item ${page === 'services' ? 'active' : ''}`} onClick={() => changePage('services')}>
            <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg></span>
            <span>Services &amp; Products</span>
          </button>
          <button type="button" className={`app-nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => changePage('settings')}>
            <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg></span>
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-user-card">
          <span className="user-avatar">{user.name?.slice(0, 1).toUpperCase() || 'U'}</span>
          <div className="sidebar-user-info">
            <strong>{user.name}</strong>
            <small>{business?.name || 'Your business'}</small>
          </div>
          <button type="button" className="sidebar-logout" onClick={onLogout} aria-label="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
          </button>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-topbar">
          <div className="topbar-left">
            <h1>{heading}</h1>
          </div>
          <div className="topbar-right">
            {business?.subdomain && <a className="topbar-domain-link" href={`https://${business.subdomain}.trendscore.co.ke`} target="_blank" rel="noreferrer">{business.subdomain}.trendscore.co.ke</a>}
            <button type="button" className="topbar-icon-btn" aria-label="Notifications">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
              {dashboardStats.pending > 0 && <span className="topbar-badge">{dashboardStats.pending}</span>}
            </button>
            {page !== 'editor' && <button type="button" className="button button-primary" onClick={startNewQuote}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              New Quote
            </button>}
          </div>
        </header>

        {error && <div className="workspace-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

        {page === 'dashboard' && business && <CustomerDashboard user={user} business={business} quotes={quotes} customers={customers} chartRange={chartRange} chartData={chartData} onRangeChange={setChartRange} onNewQuote={startNewQuote} onViewQuotes={() => changePage('quotes')} onViewCustomers={() => changePage('customers')} onOpenQuote={openQuote} />}

        {page === 'quotes' && business && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Documents</p><h2>All quotes</h2></div><button className="button button-primary" type="button" onClick={startNewQuote}>New quote</button></div>
            <div className="filter-row"><input className="input-control search-control" type="search" placeholder="Search by quote or customer" value={search} onChange={(event) => setSearch(event.target.value)} /><select className="input-control filter-control" value={quoteStatusFilter} onChange={(event) => setQuoteStatusFilter(event.target.value)}><option value="ALL">All statuses</option>{Object.entries(statusNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></div>
            <section className="workspace-panel quote-list-panel"><QuoteTable quotes={filteredQuotes} currency={business.currency} onOpen={openQuote} />{quotes.length === 0 ? <div className="panel-empty"><h3>No quotes yet</h3><p>Create a quotation and send a public link to your customer.</p><button className="button button-primary" type="button" onClick={startNewQuote}>Create your first quote</button></div> : <EmptyRows hasQuotes={filteredQuotes.length > 0} label="No quotes match this search" />}</section>
          </section>
        )}

        {page === 'customers' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Address book</p><h2>Customers</h2></div><button className="button button-primary" type="button" onClick={() => { setCustomerForm(blankCustomer); setCustomerError(''); setCustomerModal(true) }}>Add customer</button></div>
            <div className="filter-row"><input className="input-control search-control" type="search" placeholder="Search customers" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
            <section className="workspace-panel quote-list-panel">
              <div className="table-scroll"><table className="data-table"><thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th /></tr></thead><tbody>{filteredCustomers.map((customer) => <tr key={customer.id}><td><strong>{customer.name}</strong></td><td>{customer.phone || '—'}</td><td>{customer.email || '—'}</td><td><div className="table-action-group"><button className="quiet-button" type="button" onClick={() => { setCustomerForm({ id: customer.id, name: customer.name, phone: customer.phone ?? '', email: customer.email ?? '' }); setCustomerError(''); setCustomerModal(true) }}>Edit</button><button className="quiet-button danger-button" type="button" onClick={() => void deleteCustomer(customer)}>Delete</button></div></td></tr>)}</tbody></table></div>
              {customers.length === 0 && <div className="panel-empty"><h3>No customers yet</h3><p>Add a customer to start preparing a quote.</p><button className="button button-primary" type="button" onClick={() => { setCustomerForm(blankCustomer); setCustomerModal(true) }}>Add customer</button></div>}
              {customers.length > 0 && filteredCustomers.length === 0 && <div className="panel-empty"><p>No customers match this search.</p></div>}
            </section>
          </section>
        )}

        {page === 'services' && (
          <section className="workspace-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Business price book</p><h2>Services & products</h2><p>Starter items are tailored to your business type. Update prices and wording to fit your work.</p></div><button className="button button-primary" type="button" onClick={() => openServiceForm()}>Add service or product</button></div>
            <div className="filter-row"><input className="input-control search-control" type="search" placeholder="Search name or category" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
            <section className="workspace-panel quote-list-panel">
              {filteredServiceItems.length > 0 ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Name</th><th>Category</th><th>Type</th><th>Unit</th><th>Default price</th><th /></tr></thead><tbody>{filteredServiceItems.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.description || (item.isStarter ? 'Starter item · add your own description' : 'No description')}</small></td><td>{item.category}</td><td>{item.kind === 'PRODUCT' ? 'Product' : 'Service'}</td><td>{item.unit}</td><td>{formatMoney(item.defaultPrice, business?.currency ?? 'KES')}{item.defaultPrice === 0 && <small>Set your rate</small>}</td><td><div className="table-action-group"><button className="quiet-button" type="button" onClick={() => openServiceForm(item)}>Edit</button><button className="quiet-button danger-button" type="button" onClick={() => void archiveServiceItem(item)}>Archive</button></div></td></tr>)}</tbody></table></div> : <div className="panel-empty"><h3>{serviceItems.length ? 'No items match this search' : 'Your starter price book is ready'}</h3><p>{serviceItems.length ? 'Try another service or category.' : 'Add your own rates to the starter services, or create a product or service from scratch.'}</p><button className="button button-primary" type="button" onClick={() => openServiceForm()}>Add service or product</button></div>}
            </section>
            <section className="workspace-panel"><div className="panel-heading"><div><h2>Quote templates</h2><p>Start with a workflow that fits the work, then edit every line.</p></div></div><div className="template-card-grid">{quoteTemplates.map((template) => <article className="template-card" key={template.id}><span className="template-workflow">{template.workflow.replaceAll('_', ' ').toLowerCase()}</span><h3>{template.name}</h3><p>{template.description}</p><small>{template.lineItems.length} starter line{template.lineItems.length === 1 ? '' : 's'} · {template.isStarter ? 'Business starter' : 'Your template'}</small></article>)}</div></section>
          </section>
        )}

        {page === 'settings' && (
          <section className="workspace-content settings-content">
            <div className="list-toolbar"><div><p className="workspace-eyebrow">Workspace</p><h2>Business settings</h2><p>These details appear on your quotations.</p></div></div>
            <form className="workspace-panel settings-form" onSubmit={(event) => void handleBusinessSave(event)}>
              <div className="settings-section"><h3>Business profile</h3><p>Contact details and quote numbering</p><div className="settings-grid">
                <label>Business name<input className="input-control" required value={businessForm.name} onChange={(event) => setBusinessForm((current) => ({ ...current, name: event.target.value }))} /></label>
                <label>Business email<input className="input-control" type="email" value={businessForm.email ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, email: event.target.value }))} /></label>
                <label>Phone<input className="input-control" value={businessForm.phone ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, phone: event.target.value }))} /></label>
                <label>Country<input className="input-control" value={businessForm.country ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, country: event.target.value }))} /></label>
                <label>Business type<select className="input-control" value={businessForm.businessType ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, businessType: event.target.value }))}><option value="">General service business</option><option>Handyman / home repair</option><option>Plumbing</option><option>Electrical</option><option>Cleaning &amp; maintenance</option><option>Construction &amp; contracting</option><option>Consulting &amp; professional services</option><option>Creative studio</option><option>Retail &amp; product sales</option><option>Other service business</option></select></label>
                <label>Currency<input className="input-control" maxLength={3} required value={businessForm.currency} onChange={(event) => setBusinessForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></label>
                <label>Default tax rate (%)<input className="input-control" type="number" min="0" max="100" step="0.01" value={businessForm.defaultTaxRate ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, defaultTaxRate: event.target.value }))} /></label>
                <label>Quote prefix<input className="input-control" maxLength={8} value={businessForm.quotePrefix ?? 'QT'} onChange={(event) => setBusinessForm((current) => ({ ...current, quotePrefix: event.target.value.toUpperCase() }))} /></label>
              </div></div>
              <div className="settings-section">
                <h3>Logo</h3>
                <p>Upload your business logo — it appears on every quote document.</p>
                <LogoUpload
                  logoUrl={businessForm.logoUrl ?? null}
                  onUploaded={(url) => {
                    setBusinessForm((current) => ({ ...current, logoUrl: url }))
                    setBusiness((current) => current ? { ...current, logoUrl: url } : current)
                    setSaveState('Logo uploaded')
                  }}
                  onRemoved={() => {
                    setBusinessForm((current) => ({ ...current, logoUrl: '' }))
                    setBusiness((current) => current ? { ...current, logoUrl: null } : current)
                    setSaveState('Logo removed')
                  }}
                />
              </div>
              <div className="settings-section"><h3>Quote details</h3><p>Shown on customer facing documents</p><div className="settings-grid"><label className="span-two">Payment instructions<textarea className="input-control" rows={3} value={businessForm.paymentInstructions ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, paymentInstructions: event.target.value }))} placeholder="Bank, account, or payment details" /></label><label className="span-two">Default terms<textarea className="input-control" rows={4} value={businessForm.terms ?? ''} onChange={(event) => setBusinessForm((current) => ({ ...current, terms: event.target.value }))} placeholder="Payment timing, quote validity, delivery conditions" /></label></div></div>
              <div className="settings-footer"><span className="save-feedback">{saveState}</span><button className="button button-primary" type="submit" disabled={businessSaving}>{businessSaving ? 'Saving…' : 'Save settings'}</button></div>
            </form>
            <form className="workspace-panel settings-form email-settings-panel" onSubmit={handleEmailSettingsSubmit}>
              <div className="settings-section"><h3>Email &amp; sending domain</h3><p>Choose the iQuote managed sender or connect your own Resend account and domain.</p>
                <div className="email-provider-options"><label className={`email-provider-option ${emailSettingsForm.provider === 'PLATFORM' ? 'selected' : ''}`}><input type="radio" name="emailProvider" checked={emailSettingsForm.provider === 'PLATFORM'} onChange={() => setEmailSettingsForm((current) => ({ ...current, provider: 'PLATFORM' }))} /><span><strong>iQuote managed sender</strong><small>{emailSettings?.platformSenderAvailable ? 'Available with your workspace' : 'Platform email is not configured yet'} · no domain setup</small></span></label><label className={`email-provider-option ${emailSettingsForm.provider === 'CUSTOM' ? 'selected' : ''}`}><input type="radio" name="emailProvider" checked={emailSettingsForm.provider === 'CUSTOM'} onChange={() => setEmailSettingsForm((current) => ({ ...current, provider: 'CUSTOM' }))} /><span><strong>Use my Resend account</strong><small>Your API key and verified sender domain belong to this workspace</small></span></label></div>
                {emailSettingsForm.provider === 'CUSTOM' && <div className="settings-grid email-settings-fields"><label>Sender name<input className="input-control" value={emailSettingsForm.senderName} onChange={(event) => setEmailSettingsForm((current) => ({ ...current, senderName: event.target.value }))} placeholder={business?.name || 'Your business'} /></label><label>Sender email<input className="input-control" type="email" value={emailSettingsForm.senderEmail} onChange={(event) => setEmailSettingsForm((current) => ({ ...current, senderEmail: event.target.value }))} placeholder="quotes@yourdomain.com" /></label><label className="span-two">Resend API key<input className="input-control" type="password" autoComplete="new-password" value={emailSettingsForm.apiKey} onChange={(event) => setEmailSettingsForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={emailSettings?.apiKeySet ? 'Key saved · enter a new key to replace' : 're_…'} /></label><label className="span-two">Custom sending domain<input className="input-control" value={emailSettingsForm.customDomain} onChange={(event) => setEmailSettingsForm((current) => ({ ...current, customDomain: event.target.value.toLowerCase() }))} placeholder="yourdomain.com" /><small className="field-hint">Optional. Must match the sender email domain. Resend will provide DNS records for verification.</small></label></div>}
                <div className="email-settings-status"><span className={`domain-status status-${(emailSettings?.domainStatus ?? 'not_configured').toLowerCase()}`}>Domain: {(emailSettings?.domainStatus ?? 'NOT_CONFIGURED').toLowerCase().replaceAll('_', ' ')}</span><span>{emailSettings?.apiKeySet ? 'Resend API key saved securely' : 'No tenant API key saved'}</span><span>{emailSettings?.encryptionReady ? 'Encrypted storage ready' : 'Tenant key encryption needs platform setup'}</span></div>
                {emailSettingsMessage && <p className="save-feedback" role="status">{emailSettingsMessage}</p>}
                {emailSettings?.domainRecords && <div className="dns-records"><h4>DNS records from Resend</h4><pre>{JSON.stringify(emailSettings.domainRecords, null, 2)}</pre></div>}
                <div className="settings-footer email-settings-footer"><button className="button button-secondary" type="button" onClick={() => void setupEmailDomain()} disabled={emailSettingsSaving || emailSettingsForm.provider !== 'CUSTOM' || !emailSettingsForm.customDomain}>Set up domain</button><button className="button button-secondary" type="button" onClick={() => void checkEmailDomain()} disabled={emailSettingsSaving || !emailSettings?.customDomain}>Check status</button><button className="button button-primary" type="submit" disabled={emailSettingsSaving}>{emailSettingsSaving ? 'Saving…' : 'Save email settings'}</button></div>
              </div>
            </form>
          </section>
        )}

        {page === 'editor' && editor && business && (
          <section className="editor-content">
            <div className="editor-toolbar"><button className="link-button" type="button" onClick={() => changePage('quotes')}>← All quotes</button><div className="editor-toolbar-actions"><span className="save-feedback" role="status">{saveState || (editorDirty ? 'Unsaved changes' : 'Draft')}</span><button className="button button-secondary" type="button" onClick={() => { setTemplateName(''); setTemplateDescription(''); setTemplateModal(true) }}>Save as template</button><button className="button button-secondary mobile-preview-toggle" type="button" onClick={() => setShowMobilePreview(true)}>Preview</button>{editorQuoteId && <button className="button button-secondary" type="button" onClick={() => void deleteDraft()}>Delete draft</button>}<QuotePdfDownloadLink className="button button-secondary" quote={documentFromDraft(editor, editorNumber, business, customers.find((customer) => customer.id === editor.customerId))} /><button className="button button-secondary" type="button" onClick={() => window.print()}>Print</button><button className="button button-primary" type="button" onClick={() => void shareQuote()} disabled={!editor.customerId}>Mark as sent</button></div></div>
            {sharedUrl && <div className="share-callout"><div><strong>Quote link is ready</strong><span>{sharedUrl}</span></div><div className="share-actions"><button className="button button-secondary" type="button" onClick={() => { void navigator.clipboard.writeText(sharedUrl).then(() => setCopied(true)).catch(() => setError('Copy the quote link from the address shown.')) }}>{copied ? 'Copied' : 'Copy link'}</button><a className="button button-secondary" href={`https://wa.me/?text=${encodeURIComponent(`Here is your quotation: ${sharedUrl}`)}`} target="_blank" rel="noreferrer">WhatsApp</a></div></div>}
            <div className="editor-layout">
              <div className="editor-fields">
                <section className="workspace-panel editor-section"><div className="panel-heading"><div><h2>Quote details</h2><p>{editorNumber}</p></div><span className={statusClass(editorQuoteId ? quotes.find((quote) => quote.id === editorQuoteId)?.status ?? 'DRAFT' : 'DRAFT')}>{editorQuoteId ? statusNames[quotes.find((quote) => quote.id === editorQuoteId)?.status ?? 'DRAFT'] : 'Draft'}</span></div>
                  <label className="field-label">Customer<select className="input-control" value={editor.customerId} onChange={(event) => event.target.value === '__new__' ? setShowQuickCustomer(true) : updateEditor({ customerId: event.target.value })}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}<option value="__new__">+ Add a customer</option></select></label>
                  {showQuickCustomer && <div className="quick-customer"><div className="quick-customer-fields"><input className="input-control" placeholder="Customer name" value={quickCustomer.name} onChange={(event) => setQuickCustomer((current) => ({ ...current, name: event.target.value }))} /><input className="input-control" type="tel" placeholder="Phone" value={quickCustomer.phone} onChange={(event) => setQuickCustomer((current) => ({ ...current, phone: event.target.value }))} /><input className="input-control" type="email" placeholder="Email" value={quickCustomer.email} onChange={(event) => setQuickCustomer((current) => ({ ...current, email: event.target.value }))} /></div><button type="button" className="button button-primary" onClick={() => void createQuickCustomer()}>Save customer</button><button type="button" className="quiet-button" onClick={() => setShowQuickCustomer(false)}>Cancel</button></div>}
                  <label className="field-label">Valid until<input className="input-control" type="date" value={editor.validUntil} onChange={(event) => updateEditor({ validUntil: event.target.value })} /></label>
                </section>

                <section className="workspace-panel editor-section"><div className="panel-heading"><div><h2>Line items</h2><p>Describe the work or products in this quotation.</p></div><div className="quote-line-tools">{quoteTemplates.length > 0 && <select className="input-control template-select" aria-label="Start from a quote template" defaultValue="" onChange={(event) => { applyQuoteTemplate(event.target.value); event.target.value = '' }}><option value="">Use a template…</option>{quoteTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>}<select className="input-control template-select" aria-label="Add from service catalogue" defaultValue="" onChange={(event) => { addServiceItemToQuote(event.target.value); event.target.value = '' }}><option value="">Add from price book…</option>{serviceItems.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}</option>)}</select><button className="quiet-button" type="button" onClick={addLine}>+ Add line</button></div></div>
                  <div className="quote-lines-editor">{editor.lines.map((line, index) => <div className="quote-line-editor" key={line.id ?? index}><label>Description<input className="input-control" value={line.description} placeholder="Service or product" onChange={(event) => updateLine(index, 'description', event.target.value)} /></label><label>Qty<input className="input-control" type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} /></label><label>Unit<input className="input-control" value={line.unit} onChange={(event) => updateLine(index, 'unit', event.target.value)} /></label><label>Unit price<input className="input-control" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(index, 'unitPrice', event.target.value)} /></label><label>Tax %<input className="input-control" type="number" min="0" max="100" step="0.01" value={line.taxRate ?? ''} onChange={(event) => updateLine(index, 'taxRate', event.target.value)} /></label><div className="line-amount">{formatMoney(line.quantity * line.unitPrice, business.currency)}<button className="quiet-button danger-button" type="button" aria-label="Remove line" onClick={() => updateEditor({ lines: editor.lines.filter((_, rowIndex) => rowIndex !== index) })}>×</button></div></div>)}</div>
                  <button className="add-line-button" type="button" onClick={addLine}>+ Add a line item</button>
                  <div className="totals-summary"><div><span>Subtotal</span><strong>{formatMoney(quoteTotals(editor.lines).subtotal, business.currency)}</strong></div><div><span>Tax</span><strong>{formatMoney(quoteTotals(editor.lines).taxTotal, business.currency)}</strong></div><div className="summary-grand-total"><span>Total</span><strong>{formatMoney(quoteTotals(editor.lines).total, business.currency)}</strong></div></div>
                </section>

                <section className="workspace-panel editor-section notes-section"><label className="field-label">Notes<textarea className="input-control" rows={3} value={editor.notes} onChange={(event) => updateEditor({ notes: event.target.value })} placeholder="Anything the customer should know" /></label><label className="field-label">Terms<textarea className="input-control" rows={3} value={editor.terms} onChange={(event) => updateEditor({ terms: event.target.value })} placeholder="Payment, delivery, and validity terms" /></label></section>
              </div>
              <div className={`document-preview ${showMobilePreview ? 'mobile-preview-open' : ''}`}><div className="preview-label"><span>Live document preview</span><span>A4</span><button className="mobile-preview-close" type="button" onClick={() => setShowMobilePreview(false)} aria-label="Close preview">×</button></div><QuoteDocument quote={documentFromDraft(editor, editorNumber, business, customers.find((customer) => customer.id === editor.customerId))} /></div>
            </div>
          </section>
        )}
      </main>

      {customerModal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCustomerModal(false) }}><form className="customer-modal" onSubmit={(event) => void submitCustomer(event)}><div className="modal-heading"><div><p className="workspace-eyebrow">Address book</p><h2>{customerForm.id ? 'Edit customer' : 'Add a customer'}</h2></div><button className="quiet-button" type="button" onClick={() => setCustomerModal(false)} aria-label="Close">×</button></div><label className="field-label">Customer name<input className="input-control" required value={customerForm.name} onChange={(event) => setCustomerForm((current) => ({ ...current, name: event.target.value }))} /></label><label className="field-label">Phone<input className="input-control" type="tel" value={customerForm.phone} onChange={(event) => setCustomerForm((current) => ({ ...current, phone: event.target.value }))} /></label><label className="field-label">Email<input className="input-control" type="email" value={customerForm.email} onChange={(event) => setCustomerForm((current) => ({ ...current, email: event.target.value }))} /></label><p className="field-hint">Add a phone number or an email address.</p>{customerError && <p className="form-error" role="alert">{customerError}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setCustomerModal(false)}>Cancel</button><button type="submit" className="button button-primary">{customerForm.id ? 'Save changes' : 'Add customer'}</button></div></form></div>}
      {serviceModal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setServiceModal(false) }}><form className="customer-modal" onSubmit={(event) => void saveServiceItem(event)}><div className="modal-heading"><div><p className="workspace-eyebrow">Your price book</p><h2>{serviceForm.id ? 'Edit item' : 'Add a service or product'}</h2></div><button className="quiet-button" type="button" onClick={() => setServiceModal(false)} aria-label="Close">×</button></div><div className="settings-grid"><label>Name<input className="input-control" required maxLength={100} value={serviceForm.name} onChange={(event) => setServiceForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Tap replacement" /></label><label>Category<input className="input-control" required maxLength={60} value={serviceForm.category} onChange={(event) => setServiceForm((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Plumbing repairs" /></label><label>Type<select className="input-control" value={serviceForm.kind} onChange={(event) => setServiceForm((current) => ({ ...current, kind: event.target.value as ServiceForm['kind'] }))}><option value="SERVICE">Service</option><option value="PRODUCT">Product</option></select></label><label>Unit<input className="input-control" required maxLength={24} value={serviceForm.unit} onChange={(event) => setServiceForm((current) => ({ ...current, unit: event.target.value }))} placeholder="job, hour, visit, item" /></label><label>Default price<input className="input-control" type="number" min="0" step="0.01" required value={serviceForm.defaultPrice} onChange={(event) => setServiceForm((current) => ({ ...current, defaultPrice: event.target.value }))} /></label><label>Tax rate (%)<input className="input-control" type="number" min="0" max="100" step="0.01" value={serviceForm.defaultTaxRate} onChange={(event) => setServiceForm((current) => ({ ...current, defaultTaxRate: event.target.value }))} placeholder={`Business default (${business?.defaultTaxRate ?? 0}%)`} /></label><label className="span-two">Customer-facing description<textarea className="input-control" rows={3} maxLength={500} value={serviceForm.description} onChange={(event) => setServiceForm((current) => ({ ...current, description: event.target.value }))} /></label></div>{serviceError && <p className="form-error" role="alert">{serviceError}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setServiceModal(false)}>Cancel</button><button type="submit" className="button button-primary">{serviceForm.id ? 'Save item' : 'Add item'}</button></div></form></div>}
      {templateModal && editor && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplateModal(false) }}><form className="customer-modal" onSubmit={(event) => void saveQuoteTemplate(event)}><div className="modal-heading"><div><p className="workspace-eyebrow">Reusable workflow</p><h2>Save this quote as a template</h2></div><button className="quiet-button" type="button" onClick={() => setTemplateModal(false)} aria-label="Close">×</button></div><label className="field-label">Template name<input className="input-control" required maxLength={100} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="e.g. Bathroom leak repair" /></label><label className="field-label">When do you use it?<textarea className="input-control" rows={3} maxLength={300} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder="Briefly describe the job flow" /></label><p className="field-hint">This saves the current quote lines, notes, and terms as a starter for your next quote.</p><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setTemplateModal(false)}>Cancel</button><button type="submit" className="button button-primary">Save template</button></div></form></div>}
    </div>
  )
}

function QuoteTable({ quotes, currency, onOpen }: { quotes: Quote[]; currency: string; onOpen: (quote: Quote) => void }) {
  if (!quotes.length) return null
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>Quote</th><th>Customer</th><th>Valid until</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>{quotes.map((quote) => <tr key={quote.id} onClick={() => onOpen(quote)}><td><strong>{quote.documentNumber}</strong><small>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(quote.updatedAt))}</small></td><td>{quote.customer.name}</td><td>{quote.validUntil ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(quote.validUntil)) : '—'}</td><td>{formatMoney(quote.total, currency)}</td><td><span className={statusClass(quote.status)}>{statusNames[quote.status]}</span></td><td><button className="quiet-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(quote) }}>{quote.status === 'DRAFT' ? 'Edit' : 'View'}</button></td></tr>)}</tbody></table></div>
}

function EmptyRows({ hasQuotes, label }: { hasQuotes: boolean; label: string }) {
  return hasQuotes ? null : <div className="panel-empty"><h3>{label}</h3><p>Try changing the search or status filter.</p></div>
}

function DashboardQuoteTable({ quotes, currency, onOpen }: { quotes: Quote[]; currency: string; onOpen: (quote: Quote) => void }) {
  return (
    <div className="table-scroll">
      <table className="data-table dashboard-table">
        <thead>
          <tr>
            <th>Quote #</th>
            <th>Customer</th>
            <th>Date</th>
            <th>Amount</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {quotes.map((quote) => (
            <tr key={quote.id} onClick={() => onOpen(quote)}>
              <td><strong>{quote.documentNumber}</strong></td>
              <td>{quote.customer.name}</td>
              <td className="muted-cell">{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(quote.updatedAt))}</td>
              <td className="amount-cell">{formatMoney(quote.total, currency)}</td>
              <td><span className={statusClass(quote.status)}>{statusNames[quote.status]}</span></td>
              <td><button className="quiet-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(quote) }}>{quote.status === 'DRAFT' ? 'Edit' : 'View'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CustomerDashboard({ user, business, quotes, customers, chartRange, chartData, onRangeChange, onNewQuote, onViewQuotes, onViewCustomers, onOpenQuote }: {
  user: User
  business: Business
  quotes: Quote[]
  customers: Customer[]
  chartRange: ChartRange
  chartData: { buckets: Array<{ label: string; value: number; count: number }>; maxValue: number; totalQuotes: number }
  onRangeChange: (range: ChartRange) => void
  onNewQuote: () => void
  onViewQuotes: () => void
  onViewCustomers: () => void
  onOpenQuote: (quote: Quote) => void
}) {
  const now = new Date()
  const monthQuotes = quotes.filter((quote) => {
    const created = new Date(quote.createdAt)
    return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear()
  })
  const monthQuoted = monthQuotes.reduce((sum, quote) => sum + quote.total, 0)
  const awaitingQuotes = quotes.filter((quote) => ['SENT', 'VIEWED'].includes(quote.status))
  const awaitingValue = awaitingQuotes.reduce((sum, quote) => sum + quote.total, 0)
  const approvedQuotes = quotes.filter((quote) => quote.status === 'APPROVED')
  const approvedValue = approvedQuotes.reduce((sum, quote) => sum + quote.total, 0)
  const statusCounts = {
    approved: approvedQuotes.length,
    awaiting: awaitingQuotes.length,
    drafts: quotes.filter((quote) => quote.status === 'DRAFT').length,
    other: quotes.filter((quote) => ['DECLINED', 'EXPIRED'].includes(quote.status)).length,
  }
  const pipelineTotal = Math.max(quotes.length, 1)
  const approvedStop = statusCounts.approved / pipelineTotal * 100
  const awaitingStop = approvedStop + statusCounts.awaiting / pipelineTotal * 100
  const draftStop = awaitingStop + statusCounts.drafts / pipelineTotal * 100
  const pipelineStyle = { background: `conic-gradient(#237b56 0 ${approvedStop}%, #e2b75d ${approvedStop}% ${awaitingStop}%, #7897ba ${awaitingStop}% ${draftStop}%, #e7ece8 ${draftStop}% 100%)` }
  const customerTotals = new Map<string, { customer: Customer; value: number; count: number }>()
  for (const quote of approvedQuotes) {
    const customer = customers.find((item) => item.id === quote.customer.id)
    if (!customer) continue
    const current = customerTotals.get(customer.id) ?? { customer, value: 0, count: 0 }
    current.value += quote.total
    current.count += 1
    customerTotals.set(customer.id, current)
  }
  const topCustomers = [...customerTotals.values()].sort((a, b) => b.value - a.value).slice(0, 4)
  const recentActivity = [...quotes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4)
  const chartPoints = chartData.buckets.map((bucket, index) => {
    const x = chartData.buckets.length > 1 ? index / (chartData.buckets.length - 1) * 720 : 360
    const y = 190 - bucket.value / chartData.maxValue * 160
    return `${x},${y}`
  }).join(' ')
  const chartArea = chartPoints ? `0,200 ${chartPoints} 720,200` : ''
  const firstName = user.name.trim().split(/\s+/)[0] || 'there'
  const money = (value: number) => formatMoney(value, business.currency).replace(/\.00$/, '')

  return (
    <section className="workspace-content customer-dashboard-page">
      <div className="customer-dashboard-heading">
        <div><p className="dashboard-date-label">{now.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p><h2>Good morning, <em>{firstName}</em>.</h2><p>Here’s how {business.name || 'your business'} is moving this month.</p></div>
        <button className="button button-primary dashboard-create-button" type="button" onClick={onNewQuote}><span>＋</span>Create a quote</button>
      </div>

      <div className="customer-dashboard-metrics">
        <article className="customer-dashboard-metric"><div>Quoted this month <span className="dashboard-metric-icon">↗</span></div><strong>{money(monthQuoted)}</strong><small>Across {monthQuotes.length} {monthQuotes.length === 1 ? 'quote' : 'quotes'} created this month</small></article>
        <article className="customer-dashboard-metric"><div>Awaiting a response <span className="dashboard-metric-icon dashboard-metric-gold">◷</span></div><strong>{money(awaitingValue)}</strong><small>Across {awaitingQuotes.length} open {awaitingQuotes.length === 1 ? 'quote' : 'quotes'}</small></article>
        <article className="customer-dashboard-metric"><div>Approved work <span className="dashboard-metric-icon">✓</span></div><strong>{money(approvedValue)}</strong><small>{approvedQuotes.length} approved {approvedQuotes.length === 1 ? 'quote' : 'quotes'}</small></article>
        <article className="customer-dashboard-metric"><div>Active customers <span className="dashboard-metric-icon dashboard-metric-blue">♙</span></div><strong>{customers.length}</strong><small>In your customer list</small></article>
      </div>

      <div className="customer-dashboard-grid">
        <div className="customer-dashboard-main-column">
          <section className="customer-dashboard-panel customer-activity-chart">
            <div className="customer-panel-heading"><div><h3>Quote activity</h3><p>A quick look at the value you’re putting out there</p></div><div className="dashboard-range-picker">{(['7D', '30D', '90D', '1Y'] as ChartRange[]).map((range) => <button key={range} type="button" className={chartRange === range ? 'selected' : ''} onClick={() => onRangeChange(range)}>{range}</button>)}</div></div>
            <div className="dashboard-line-chart"><div className="dashboard-chart-total"><strong>{money(chartData.buckets.reduce((sum, bucket) => sum + bucket.value, 0))}</strong><span>{chartData.totalQuotes} quotes in this period</span></div><svg viewBox="0 0 720 220" role="img" aria-label="Quote value activity over time" preserveAspectRatio="none"><defs><linearGradient id="quoteActivityFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#6bb789" stopOpacity=".28"/><stop offset="100%" stopColor="#6bb789" stopOpacity="0"/></linearGradient></defs><path className="dashboard-chart-gridline" d="M0 40H720 M0 90H720 M0 140H720 M0 190H720"/><polygon points={chartArea} fill="url(#quoteActivityFill)"/><polyline points={chartPoints} fill="none" stroke="#237b56" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>{chartData.buckets.map((bucket, index) => { const x = chartData.buckets.length > 1 ? index / (chartData.buckets.length - 1) * 720 : 360; const y = 190 - bucket.value / chartData.maxValue * 160; return bucket.value > 0 ? <circle key={`${bucket.label}-${index}`} cx={x} cy={y} r="4" fill="#fff" stroke="#237b56" strokeWidth="2"/> : null })}</svg><div className="dashboard-chart-labels">{chartData.buckets.filter((_, index) => index === 0 || index === chartData.buckets.length - 1 || index % Math.max(1, Math.floor(chartData.buckets.length / 6)) === 0).map((bucket, index) => <span key={`${bucket.label}-${index}`}>{bucket.label}</span>)}</div></div>
          </section>

          <section className="customer-dashboard-panel customer-recent-quotes">
            <div className="customer-panel-heading"><div><h3>Recent quotes</h3><p>Keep the important conversations moving</p></div><button type="button" className="dashboard-text-link" onClick={onViewQuotes}>View all quotes →</button></div>
            {quotes.length ? <DashboardQuoteTable quotes={[...quotes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5)} currency={business.currency} onOpen={onOpenQuote}/> : <div className="customer-dashboard-empty"><strong>Your first quote is one step away.</strong><p>Create a quote and share a clear link with your customer.</p><button type="button" className="button button-primary" onClick={onNewQuote}>Create a quote</button></div>}
          </section>
        </div>

        <aside className="customer-dashboard-side-column">
          <section className="customer-dashboard-panel">
            <div className="customer-panel-heading"><div><h3>Quote pipeline</h3><p>Where your quotes stand</p></div></div>
            <div className="dashboard-pipeline"><div className="dashboard-donut" style={pipelineStyle}><div><strong>{quotes.length}</strong><small>total quotes</small></div></div><div className="dashboard-pipeline-legend"><span><i className="pipeline-approved"/>Approved<b>{statusCounts.approved}</b></span><span><i className="pipeline-awaiting"/>Awaiting reply<b>{statusCounts.awaiting}</b></span><span><i className="pipeline-draft"/>Draft<b>{statusCounts.drafts}</b></span><span><i className="pipeline-other"/>Other<b>{statusCounts.other}</b></span></div></div>
          </section>

          <section className="customer-dashboard-panel">
            <div className="customer-panel-heading"><div><h3>Latest activity</h3><p>A little movement in your workspace</p></div></div>
            {recentActivity.length ? <div className="dashboard-activity-list">{recentActivity.map((quote) => { const verb = quote.status === 'APPROVED' ? 'approved a quote' : quote.status === 'VIEWED' ? 'viewed a quote' : quote.status === 'SENT' ? 'received a quote' : quote.status === 'DECLINED' ? 'declined a quote' : quote.status === 'EXPIRED' ? 'quote expired' : 'draft was updated'; return <button type="button" key={quote.id} className="dashboard-activity-item" onClick={() => onOpenQuote(quote)}><span className={`dashboard-activity-icon activity-${quote.status.toLowerCase()}`}>{quote.status === 'APPROVED' ? '✓' : quote.status === 'VIEWED' ? '◉' : '↗'}</span><span><strong>{quote.customer.name}</strong> {verb}<small>{quote.documentNumber} · {money(quote.total)} · {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(quote.updatedAt))}</small></span></button> })}</div> : <div className="customer-dashboard-empty compact">Quote activity will appear here.</div>}
          </section>

          <section className="customer-dashboard-panel customer-top-customers">
            <div className="customer-panel-heading"><div><h3>Top customers</h3><p>By approved quote value</p></div><button type="button" className="dashboard-text-link" onClick={onViewCustomers}>View all →</button></div>
            {topCustomers.length ? <div className="dashboard-customer-list">{topCustomers.map(({ customer, value, count }) => <div className="dashboard-customer-row" key={customer.id}><span className="dashboard-customer-avatar">{customer.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span className="dashboard-customer-copy"><strong>{customer.name}</strong><small>{count} approved {count === 1 ? 'quote' : 'quotes'}</small></span><b>{money(value)}</b></div>)}</div> : <div className="customer-dashboard-empty compact">Approved customer totals will appear here.</div>}
          </section>
        </aside>
      </div>
    </section>
  )
}
