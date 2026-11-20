import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'
import { ReceiptPdfDownloadLink } from './ReceiptPdf'

type Customer = { id: string; name: string; phone: string | null; email: string | null }
type Business = { id: string; name: string; currency: string; email?: string | null; phone?: string | null; country?: string | null }

type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED'

type Payment = {
  id: string
  receiptNumber: string
  amount: number
  sourceAmount?: number
  invoiceNumber?: string
  currency: string
  method: string
  reference: string | null
  paymentDate: string
  receivedBy?: string
  isDeposit?: boolean
  refunds?: Array<{ id: string; amount: number; currency: string; method: string; reference: string | null; reason: string; refundedAt: string; recordedByName: string }>
  receiptDeliveries?: Array<{ id: string; recipientEmail: string; recipientName: string | null; status: string; errorMessage: string | null; sentAt: string | null; createdAt: string }>
}

type InvoiceReconciliation = { id: string; actorName: string; reason: string; previousAmountPaid: number; previousBalanceDue: number; correctedAmountPaid: number; correctedBalanceDue: number; createdAt: string }

type Invoice = {
  id: string
  invoiceNumber: string
  status: InvoiceStatus
  currency: string
  customerId: string
  customer: { id: string; name: string; phone?: string | null; email?: string | null }
  jobId: string | null
  job?: { id: string; title: string } | null
  sourceQuoteId?: string | null
  sourceQuote?: { id: string; documentNumber: string } | null
  lineItems?: Array<{ description: string; quantity: number; unit: string; unitPrice: number; taxRate: number | null }> | null
  subtotal: number
  taxTotal: number
  total: number
  amountPaid: number
  balanceDue: number
  depositRequired: number | null
  depositPaid: number
  sentAt: string | null
  issueDate: string
  dueDate: string | null
  notes: string | null
  payments?: Payment[]
  allocationHistory?: Array<{ id: string; eventType: string; amount: number; currency: string; reason: string; actorName: string; createdAt: string; receiptNumber: string; invoiceNumber: string }>
  reconciliations?: InvoiceReconciliation[]
}

type InvoiceListResponse = { invoices: Invoice[]; totalCount: number; hasMore: boolean }
type InvoiceResponse = { invoice: Invoice }
type MpesaSettingsResponse = { enabled: boolean }
type MpesaAttempt = { id: string; merchantType?: string; phone?: string; status: string; statusDescription: string | null; amount: number; currency: string; transactionId?: string | null; providerReference?: string | null; queryable?: boolean; createdAt?: string; completedAt?: string | null; paidAt?: string | null }

const invoiceStatusNames: Record<InvoiceStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_PAID: 'Partially Paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
}

const invoiceStatusClasses: Record<InvoiceStatus, string> = {
  DRAFT: 'status-badge status-draft',
  SENT: 'status-badge status-sent',
  PARTIALLY_PAID: 'status-badge status-partially_paid',
  PAID: 'status-badge status-paid',
  OVERDUE: 'status-badge status-overdue',
  CANCELLED: 'status-badge status-cancelled',
}

const paymentMethodNames: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank Transfer',
  MOBILE_MONEY: 'Mobile Money',
  CARD: 'Card',
  OTHER: 'Other',
}

type PaymentForm = {
  amount: string
  method: string
  reference: string
  isDeposit: boolean
}

type RefundForm = { amount: string; method: string; reference: string; reason: string; confirmedExternally: boolean }

const blankPaymentForm: PaymentForm = {
  amount: '0',
  method: 'CASH',
  reference: '',
  isDeposit: false,
}

function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(date))
  } catch {
    return '—'
  }
}

export default function InvoicesPanel({ business, customers, currency, canManageFinancials, onOpenQuotes }: { business: Business; customers: Customer[]; currency: string; canManageFinancials: boolean; onOpenQuotes: () => void }) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)

  useEffect(() => {
    void loadInvoices()
  }, [])

  const loadInvoices = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<InvoiceListResponse>('/api/invoices')
      setInvoices(response.invoices)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load invoices.')
    } finally {
      setLoading(false)
    }
  }

  const filteredInvoices = useMemo(() => {
    if (statusFilter === 'ALL') return invoices
    return invoices.filter((inv) => inv.status === statusFilter)
  }, [invoices, statusFilter])

  const openInvoiceDetail = async (invoice: Invoice) => {
    setError('')
    try {
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      setSelectedInvoice(response.invoice)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load invoice details.')
    }
  }

  const sendInvoice = async (invoice: Invoice) => {
    try {
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`, { method: 'PUT', body: JSON.stringify({ status: 'SENT' }) })
      setInvoices((current) => current.map((inv) => inv.id === response.invoice.id ? response.invoice : inv))
      if (selectedInvoice?.id === invoice.id) setSelectedInvoice(response.invoice)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to send invoice.')
    }
  }

  if (selectedInvoice) {
    return (
      <InvoiceDetail
        invoice={selectedInvoice}
        business={business}
        currency={currency}
        customers={customers}
        onBack={() => { setSelectedInvoice(null); void loadInvoices() }}
        onSend={() => void sendInvoice(selectedInvoice)}
        onInvoiceUpdate={(updated) => setSelectedInvoice(updated)}
        onInvoicesRefresh={() => void loadInvoices()}
        setError={setError}
        canManageFinancials={canManageFinancials}
      />
    )
  }

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <p className="workspace-eyebrow">Money &amp; insights</p>
          <h2>Invoices</h2>
        </div>
        {canManageFinancials && <button className="button button-secondary" type="button" onClick={onOpenQuotes}>Create from quote</button>}
      </div>

      {error && <div className="workspace-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

      <div className="filter-row">
        <select className="input-control filter-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="ALL">All statuses</option>
          {Object.entries(invoiceStatusNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select>
      </div>

      <section className="workspace-panel">
        {loading ? (
          <div className="panel-empty"><p>Loading invoices…</p></div>
        ) : filteredInvoices.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Source quote</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map((invoice) => (
                  <tr key={invoice.id} onClick={() => void openInvoiceDetail(invoice)}>
                    <td><strong>{invoice.invoiceNumber}</strong></td>
                    <td>{invoice.sourceQuote?.documentNumber ?? '—'}</td>
                    <td>{invoice.customer?.name ?? '—'}</td>
                    <td><span className={invoiceStatusClasses[invoice.status]}>{invoiceStatusNames[invoice.status]}</span></td>
                    <td>{formatMoney(invoice.total, invoice.currency)}</td>
                    <td>{formatMoney(invoice.amountPaid, invoice.currency)}</td>
                    <td>{formatMoney(invoice.balanceDue, invoice.currency)}</td>
                    <td>{formatDate(invoice.dueDate)}</td>
                    <td><button className="quiet-button" type="button" onClick={(event) => { event.stopPropagation(); void openInvoiceDetail(invoice) }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel-empty">
            <h3>{invoices.length === 0 ? 'No invoices yet' : 'No invoices match this filter'}</h3>
            <p>{invoices.length === 0 ? 'Invoices are created from approved quotes so the customer, line items, and totals stay connected.' : 'Try a different status filter.'}</p>
            {invoices.length === 0 && canManageFinancials && <button className="button button-primary" type="button" onClick={onOpenQuotes}>View approved quotes</button>}
          </div>
        )}
      </section>
    </section>
  )
}

function InvoiceDetail({ invoice, business, customers, onBack, onSend, onInvoiceUpdate, onInvoicesRefresh, setError, canManageFinancials }: {
  invoice: Invoice
  business: Business
  currency: string
  customers: Customer[]
  onBack: () => void
  onSend: () => void
  onInvoiceUpdate: (invoice: Invoice) => void
  onInvoicesRefresh: () => void
  setError: (error: string) => void
  canManageFinancials: boolean
}) {
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(blankPaymentForm)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null)
  const [refundForm, setRefundForm] = useState<RefundForm>({ amount: '', method: 'BANK_TRANSFER', reference: '', reason: '', confirmedExternally: false })
  const [refundIdempotencyKey, setRefundIdempotencyKey] = useState(() => crypto.randomUUID())
  const [refundSaving, setRefundSaving] = useState(false)
  const [reallocationTarget, setReallocationTarget] = useState<Payment | null>(null)
  const [reallocationInvoices, setReallocationInvoices] = useState<Invoice[]>([])
  const [reallocationAmount, setReallocationAmount] = useState('')
  const [reallocationReason, setReallocationReason] = useState('')
  const [reallocationSaving, setReallocationSaving] = useState(false)
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [receiptTarget, setReceiptTarget] = useState<Payment | null>(null)
  const [receiptEmail, setReceiptEmail] = useState('')
  const [receiptSending, setReceiptSending] = useState(false)
  const [mpesaEnabled, setMpesaEnabled] = useState(false)
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [mpesaAmount, setMpesaAmount] = useState(String(invoice.balanceDue.toFixed(2)))
  const [mpesaAttempt, setMpesaAttempt] = useState<MpesaAttempt | null>(null)
  const [mpesaHistory, setMpesaHistory] = useState<MpesaAttempt[]>([])
  const [mpesaBusy, setMpesaBusy] = useState(false)
  const [mpesaMessage, setMpesaMessage] = useState('')
  const invoiceUpdateRef = useRef(onInvoiceUpdate)
  const paymentIdempotencyStorageKey = `iquote.payment.${invoice.id}`
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState(() => {
    try {
      const stored = sessionStorage.getItem(paymentIdempotencyStorageKey)
      if (stored) return stored
      const generated = crypto.randomUUID()
      sessionStorage.setItem(paymentIdempotencyStorageKey, generated)
      return generated
    } catch {
      return crypto.randomUUID()
    }
  })

  const customer = customers.find((c) => c.id === invoice.customerId)
  const payments = invoice.payments ?? []
  const paymentRowsTotal = payments.reduce((sum, payment) => sum + Number(payment.amount) - (payment.refunds ?? []).reduce((refundTotal, refund) => refundTotal + Number(refund.amount), 0), 0)
  const hasReconciliationMismatch = Math.abs(invoice.amountPaid - paymentRowsTotal) > 0.01 || Math.abs(invoice.balanceDue - (invoice.total - paymentRowsTotal)) > 0.01

  useEffect(() => { invoiceUpdateRef.current = onInvoiceUpdate }, [onInvoiceUpdate])

  useEffect(() => {
    if (!canManageFinancials || !customer?.id) return
    void apiRequest<InvoiceListResponse>(`/api/invoices?customerId=${encodeURIComponent(customer.id)}&status=SENT,PARTIALLY_PAID,OVERDUE`).then(({ invoices: rows }) => setReallocationInvoices(rows.filter((row) => row.id !== invoice.id && row.currency === invoice.currency))).catch(() => setReallocationInvoices([]))
  }, [canManageFinancials, customer?.id, invoice.id, invoice.currency])

  useEffect(() => {
    let active = true
    void apiRequest<MpesaSettingsResponse>('/api/settings/payments').then((settings) => { if (active) setMpesaEnabled(settings.enabled) }).catch(() => { if (active) setMpesaEnabled(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<{ attempts: MpesaAttempt[] }>(`/api/invoices/${invoice.id}/mpesa/attempts`).then(({ attempts }) => {
      if (!active) return
      setMpesaHistory(attempts)
      const unresolved = attempts.find((attempt) => ['PENDING', 'UNKNOWN'].includes(attempt.status))
      setMpesaAttempt(unresolved ? { ...unresolved, queryable: unresolved.queryable ?? Boolean(unresolved.transactionId) } : null)
    }).catch(() => { if (active) setMpesaHistory([]) })
    return () => { active = false }
  }, [invoice.id])

  useEffect(() => {
    setMpesaPhone(customer?.phone ?? '')
    setMpesaAmount(invoice.balanceDue.toFixed(2))
  }, [invoice.id, invoice.balanceDue, customer?.phone])

  useEffect(() => {
    if (!mpesaAttempt || !['PENDING', 'UNKNOWN'].includes(mpesaAttempt.status) || (mpesaAttempt.status === 'UNKNOWN' && mpesaAttempt.queryable === false)) return
    const timer = window.setTimeout(() => {
      void apiRequest<{ payment: MpesaAttempt }>(`/api/invoices/${invoice.id}/mpesa/attempts/${mpesaAttempt.id}`).then(async ({ payment }) => {
        setMpesaAttempt(payment)
        setMpesaHistory((current) => current.map((item) => item.id === payment.id ? { ...item, ...payment, completedAt: payment.paidAt ?? item.completedAt } : item))
        setMpesaMessage(payment.statusDescription ?? '')
        if (payment.status === 'PAID') {
          const refreshed = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
          invoiceUpdateRef.current(refreshed.invoice)
        }
      }).catch(() => undefined)
    }, 5_000)
    return () => window.clearTimeout(timer)
  }, [mpesaAttempt, invoice.id])

  const sendMpesaPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMpesaBusy(true)
    setMpesaMessage('Sending the secure prompt…')
    try {
      const response = await apiRequest<{ payment: MpesaAttempt }>(`/api/invoices/${invoice.id}/mpesa/stk`, {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ phone: mpesaPhone, amount: Number(mpesaAmount) }),
      })
      setMpesaAttempt({ ...response.payment, queryable: response.payment.queryable ?? response.payment.status === 'PENDING' })
      setMpesaHistory((current) => [response.payment, ...current.filter((item) => item.id !== response.payment.id)].slice(0, 20))
      setMpesaMessage(response.payment.statusDescription ?? 'Ask your customer to approve the M-Pesa prompt.')
    } catch (requestError) {
      setMpesaMessage(requestError instanceof Error ? requestError.message : 'Could not send the M-Pesa prompt.')
    } finally {
      setMpesaBusy(false)
    }
  }

  const recordPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (Number(paymentForm.amount) <= 0) return
    setPaymentSaving(true)
    try {
      await apiRequest(`/api/invoices/${invoice.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(paymentForm.amount),
          method: paymentForm.method,
          reference: paymentForm.reference || undefined,
          isDeposit: paymentForm.isDeposit || undefined,
          idempotencyKey: paymentIdempotencyKey,
        }),
      })
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      onInvoiceUpdate(response.invoice)
      setPaymentForm(blankPaymentForm)
      const nextPaymentKey = crypto.randomUUID()
      setPaymentIdempotencyKey(nextPaymentKey)
      try { sessionStorage.setItem(paymentIdempotencyStorageKey, nextPaymentKey) } catch { /* persistent storage is optional */ }
      setShowPaymentForm(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to record payment.')
    } finally {
      setPaymentSaving(false)
    }
  }

  const sendReceipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!receiptTarget) return
    setReceiptSending(true)
    try {
      await apiRequest(`/api/payments/${receiptTarget.id}/send-receipt`, {
        method: 'POST',
        body: JSON.stringify({ recipientEmail: receiptEmail }),
      })
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      onInvoiceUpdate(response.invoice)
      setReceiptTarget(null)
      setReceiptEmail('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to send receipt.')
      // Refresh invoice even on error — the API may have created a FAILED delivery record
      try {
        const refreshed = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
        onInvoiceUpdate(refreshed.invoice)
      } catch { /* secondary refresh failure is not actionable */ }
    } finally {
      setReceiptSending(false)
    }
  }

  const recordRefund = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!refundTarget) return
    setRefundSaving(true)
    try {
      await apiRequest(`/api/invoices/${invoice.id}/refunds`, { method: 'POST', body: JSON.stringify({ paymentId: refundTarget.id, amount: Number(refundForm.amount), method: refundForm.method, reference: refundForm.reference || undefined, reason: refundForm.reason, confirmedExternally: refundForm.confirmedExternally, idempotencyKey: refundIdempotencyKey }) })
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      onInvoiceUpdate(response.invoice)
      setRefundTarget(null)
      setRefundForm({ amount: '', method: 'BANK_TRANSFER', reference: '', reason: '', confirmedExternally: false })
      setRefundIdempotencyKey(crypto.randomUUID())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to record refund.')
    } finally {
      setRefundSaving(false)
    }
  }

  const reallocatePayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!reallocationTarget) return
    const targetInvoiceId = (event.currentTarget.elements.namedItem('targetInvoice') as HTMLSelectElement).value
    setReallocationSaving(true)
    try {
      await apiRequest(`/api/payments/${reallocationTarget.id}/reallocate`, { method: 'POST', body: JSON.stringify({ fromInvoiceId: invoice.id, toInvoiceId: targetInvoiceId, amount: Number(reallocationAmount), reason: reallocationReason, idempotencyKey: crypto.randomUUID() }) })
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      onInvoiceUpdate(response.invoice)
      setReallocationTarget(null)
      setReallocationAmount('')
      setReallocationReason('')
      onInvoicesRefresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reallocate payment.')
    } finally {
      setReallocationSaving(false)
    }
  }

  const reconcileInvoice = async () => {
    const reason = window.prompt('Why are you reconciling this invoice against its recorded payments?')?.trim()
    if (!reason) return
    try {
      const response = await apiRequest<{ invoice: Invoice }>(`/api/invoices/${invoice.id}/reconcile`, { method: 'POST', body: JSON.stringify({ reason }) })
      onInvoiceUpdate(response.invoice)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reconcile invoice totals.')
    }
  }

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <button className="link-button" type="button" onClick={onBack}>← All invoices</button>
          <p className="workspace-eyebrow">Invoice detail</p>
          <h2>{invoice.invoiceNumber}</h2>
        </div>
        {canManageFinancials && invoice.status === 'DRAFT' && <button className="button button-primary" type="button" onClick={onSend}>Send invoice</button>}
      </div>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Invoice information</h2>
            <p>{customer?.name ?? '—'} · {invoice.job?.title ?? 'No linked job'}{invoice.sourceQuote?.documentNumber ? ` · From ${invoice.sourceQuote.documentNumber}` : ''}</p>
          </div>
          <span className={invoiceStatusClasses[invoice.status]}>{invoiceStatusNames[invoice.status]}</span>
        </div>
        <div className="job-info-grid">
          <div><span>Customer</span><strong>{customer?.name ?? '—'}</strong></div>
          <div><span>Issue date</span><strong>{formatDate(invoice.issueDate)}</strong></div>
          <div><span>Due date</span><strong>{formatDate(invoice.dueDate)}</strong></div>
          <div><span>Currency</span><strong>{invoice.currency}</strong></div>
        </div>
        <div className="cost-summary">
          <div><span>Subtotal</span><strong>{formatMoney(invoice.subtotal, invoice.currency)}</strong></div>
          <div><span>Tax</span><strong>{formatMoney(invoice.taxTotal, invoice.currency)}</strong></div>
          <div><span>Total</span><strong>{formatMoney(invoice.total, invoice.currency)}</strong></div>
          <div><span>Paid</span><strong>{formatMoney(invoice.amountPaid, invoice.currency)}</strong></div>
          <div><span>Balance due</span><strong>{formatMoney(invoice.balanceDue, invoice.currency)}</strong></div>
          {invoice.depositRequired ? <>
            <div><span>Deposit required</span><strong>{formatMoney(invoice.depositRequired, invoice.currency)}</strong></div>
            <div><span>Deposit paid</span><strong>{formatMoney(invoice.depositPaid, invoice.currency)}{invoice.depositPaid >= (invoice.depositRequired ?? 0) - 0.01 ? ' ✓' : ''}</strong></div>
          </> : null}
        </div>
        {invoice.notes && <div className="job-description"><span>Notes</span><p>{invoice.notes}</p></div>}
      </section>

      {invoice.lineItems?.length ? <section className="workspace-panel">
        <div className="panel-heading"><div><h2>Quoted work</h2><p>Copied from the accepted quote. Review before sending the invoice.</p></div></div>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Description</th><th>Quantity</th><th>Unit</th><th>Unit price</th><th>Tax</th><th>Line amount</th></tr></thead><tbody>
          {invoice.lineItems.map((line, index) => <tr key={`${line.description}-${index}`}><td><strong>{line.description}</strong></td><td>{line.quantity}</td><td>{line.unit}</td><td>{formatMoney(line.unitPrice, invoice.currency)}</td><td>{line.taxRate === null ? '—' : `${line.taxRate}%`}</td><td>{formatMoney(line.quantity * line.unitPrice, invoice.currency)}</td></tr>)}
        </tbody></table></div>
      </section> : null}

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Payments</h2>
            <p>Record payments received against this invoice</p>
          </div>
          <div className="table-action-group">{canManageFinancials && hasReconciliationMismatch && <button className="quiet-button" type="button" onClick={() => void reconcileInvoice()}>Reconcile totals</button>}{canManageFinancials && invoice.status !== 'CANCELLED' && invoice.status !== 'PAID' && <button className="button button-secondary" type="button" onClick={() => setShowPaymentForm(!showPaymentForm)}>{showPaymentForm ? 'Cancel' : 'Record payment'}</button>}</div>
        </div>
        <div className="cost-list">
          {payments.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th><th>Refunded</th><th>Receipt</th><th /></tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>{formatDate(payment.paymentDate)}</td>
                      <td>{paymentMethodNames[payment.method] ?? payment.method}</td>
                      <td>{payment.reference ?? '—'}</td>
                      <td>{formatMoney(payment.amount, payment.currency || invoice.currency)}{payment.isDeposit && <span className="deposit-badge" title="This payment was marked as a deposit">Deposit</span>}</td>
                      <td>{(payment.refunds?.length ?? 0) ? <>{formatMoney(payment.refunds!.reduce((sum, refund) => sum + Number(refund.amount), 0), payment.currency || invoice.currency)}<small>{payment.refunds!.map((refund) => `${refund.reason} · ${formatDate(refund.refundedAt)}`).join(' · ')}</small></> : '—'}</td>
                      <td><ReceiptPdfDownloadLink receipt={{ receiptNumber: payment.receiptNumber, invoiceNumber: payment.invoiceNumber ?? invoice.invoiceNumber, customerName: customer?.name ?? 'Customer', business, amount: payment.sourceAmount ?? payment.amount, currency: payment.currency || invoice.currency, method: paymentMethodNames[payment.method] ?? payment.method, reference: payment.reference, paymentDate: payment.paymentDate }} /></td>
                      <td>{canManageFinancials && <div className="table-action-group">{payment.amount > (payment.refunds ?? []).reduce((sum, refund) => sum + Number(refund.amount), 0) && <button className="quiet-button" type="button" onClick={() => { setRefundTarget(payment); setRefundForm({ amount: (payment.amount - (payment.refunds ?? []).reduce((sum, refund) => sum + Number(refund.amount), 0)).toFixed(2), method: 'BANK_TRANSFER', reference: '', reason: '', confirmedExternally: false }); setRefundIdempotencyKey(crypto.randomUUID()) }}>Record refund</button>}{reallocationInvoices.length > 0 && <button className="quiet-button" type="button" disabled={(payment.refunds?.length ?? 0) > 0} title={(payment.refunds?.length ?? 0) ? 'Payments with refunds cannot be reallocated.' : undefined} onClick={() => { setReallocationTarget(payment); setReallocationAmount(payment.amount.toFixed(2)); setReallocationReason('') }}>Reallocate</button>}<button className="quiet-button" type="button" onClick={() => { setReceiptTarget(payment); setReceiptEmail(customer?.email ?? '') }}>Send receipt</button></div>}
                        {payment.receiptDeliveries && payment.receiptDeliveries.length > 0 && (
                          <div className="receipt-delivery-history">
                            {payment.receiptDeliveries.map((delivery) => (
                              <small key={delivery.id} className={`delivery-status delivery-${delivery.status.toLowerCase()}`}>
                                {delivery.status === 'SENT' ? '✓ Receipt sent' : delivery.status === 'FAILED' ? '✗ Send failed' : '… Sending'} to {delivery.recipientEmail}{delivery.sentAt ? ` · ${formatDate(delivery.sentAt)}` : ''}
                                {delivery.errorMessage && <span className="delivery-error"> — {delivery.errorMessage}</span>}
                              </small>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="panel-empty"><p>No payments recorded yet.</p></div>}
        </div>
        {refundTarget && <form className="cost-add-form refund-form" onSubmit={(event) => void recordRefund(event)}>
          <div className="span-two"><strong>Record a refund for {refundTarget.receiptNumber}</strong><p>First send the money back through your bank, Till, or Paybill. This records the completed refund in iQuote; it does not move funds.</p></div>
          <label className="field-label">Refund amount<input className="input-control" type="number" min="0.01" max={refundTarget.amount - (refundTarget.refunds ?? []).reduce((sum, refund) => sum + Number(refund.amount), 0)} step="0.01" required value={refundForm.amount} onChange={(event) => setRefundForm((current) => ({ ...current, amount: event.target.value }))} /></label>
          <label className="field-label">Sent by<select className="input-control" value={refundForm.method} onChange={(event) => setRefundForm((current) => ({ ...current, method: event.target.value }))}><option value="BANK_TRANSFER">Bank transfer</option><option value="MOBILE_MONEY">Mobile money</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></label>
          <label className="field-label">Transfer reference<input className="input-control" value={refundForm.reference} onChange={(event) => setRefundForm((current) => ({ ...current, reference: event.target.value }))} placeholder="Optional reference" /></label>
          <label className="field-label">Reason<input className="input-control" required value={refundForm.reason} onChange={(event) => setRefundForm((current) => ({ ...current, reason: event.target.value }))} /></label>
          <label className="span-two"><input type="checkbox" required checked={refundForm.confirmedExternally} onChange={(event) => setRefundForm((current) => ({ ...current, confirmedExternally: event.target.checked }))} /> I have already sent this refund outside iQuote.</label>
          <div className="table-action-group span-two"><button className="button button-secondary" type="button" onClick={() => setRefundTarget(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={refundSaving || !refundForm.confirmedExternally}>{refundSaving ? 'Saving…' : 'Record completed refund'}</button></div>
        </form>}
        {reallocationTarget && <form className="cost-add-form refund-form" onSubmit={(event) => void reallocatePayment(event)}>
          <div className="span-two"><strong>Reallocate {reallocationTarget.receiptNumber}</strong><p>Move part or all of this recorded payment to another invoice for the same customer and currency. The change is kept in the audit ledger.</p></div>
          <label className="field-label">Target invoice<select className="input-control" name="targetInvoice" required defaultValue="">{<option value="" disabled>Select an invoice</option>}{reallocationInvoices.map((target) => <option key={target.id} value={target.id}>{target.invoiceNumber} · due {formatMoney(target.balanceDue, target.currency)}</option>)}</select></label>
          <label className="field-label">Amount<input className="input-control" type="number" min="0.01" max={reallocationTarget.amount} step="0.01" required value={reallocationAmount} onChange={(event) => setReallocationAmount(event.target.value)} /></label>
          <label className="field-label span-two">Reason<input className="input-control" required value={reallocationReason} onChange={(event) => setReallocationReason(event.target.value)} /></label>
          <div className="table-action-group span-two"><button className="button button-secondary" type="button" onClick={() => setReallocationTarget(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={reallocationSaving}>{reallocationSaving ? 'Saving…' : 'Save reallocation'}</button></div>
        </form>}
        {receiptTarget && <form className="cost-add-form refund-form" onSubmit={(event) => void sendReceipt(event)}>
          <div className="span-two"><strong>Send receipt for {receiptTarget.receiptNumber}</strong><p>Email a PDF receipt to the customer. They will receive it immediately at the address below.</p></div>
          <label className="field-label span-two">Recipient email<input className="input-control" type="email" required value={receiptEmail} onChange={(event) => setReceiptEmail(event.target.value)} placeholder="customer@example.com" /></label>
          <div className="table-action-group span-two"><button className="button button-secondary" type="button" onClick={() => setReceiptTarget(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={receiptSending}>{receiptSending ? 'Sending…' : 'Send receipt'}</button></div>
        </form>}
        {canManageFinancials && mpesaEnabled && invoice.status !== 'CANCELLED' && invoice.status !== 'PAID' && invoice.currency === 'KES' && <form className="cost-add-form mpesa-prompt-form" onSubmit={(event) => void sendMpesaPrompt(event)}>
          <label className="field-label">Customer M-Pesa number<input className="input-control" required inputMode="tel" value={mpesaPhone} onChange={(event) => setMpesaPhone(event.target.value)} placeholder="07… or 2547…" /></label>
          <label className="field-label">Amount (KES)<input className="input-control" required type="number" min="0.01" max={invoice.balanceDue} step="0.01" value={mpesaAmount} onChange={(event) => setMpesaAmount(event.target.value)} /></label>
          <button className="button button-primary" type="submit" disabled={mpesaBusy || ['PENDING', 'UNKNOWN', 'REVIEW'].includes(mpesaAttempt?.status ?? '')}>{mpesaBusy ? 'Sending…' : ['PENDING', 'UNKNOWN', 'REVIEW'].includes(mpesaAttempt?.status ?? '') ? 'Payment needs confirmation' : 'Send M-Pesa prompt'}</button>
          {mpesaMessage && <p className={`save-feedback ${['FAILED', 'UNKNOWN', 'REVIEW'].includes(mpesaAttempt?.status ?? '') ? 'form-error' : ''}`} role="status">{mpesaAttempt?.status === 'PAID' ? `Payment received · ${formatMoney(mpesaAttempt.amount, mpesaAttempt.currency)}` : mpesaAttempt?.status === 'UNKNOWN' && mpesaAttempt.queryable === false ? `${mpesaMessage} Do not send another prompt until NCBA support confirms the result.` : mpesaMessage}</p>}
        </form>}
        {mpesaHistory.length > 0 && <div className="table-scroll mpesa-history"><h3>M-Pesa request history</h3><table className="data-table"><thead><tr><th>Requested</th><th>Customer number</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody>{mpesaHistory.map((attempt) => <tr key={attempt.id}><td>{attempt.createdAt ? formatDate(attempt.createdAt) : '—'}</td><td>{attempt.phone ?? '—'}</td><td>{formatMoney(attempt.amount, attempt.currency)}</td><td><span className={`status-badge status-${attempt.status.toLowerCase()}`}>{attempt.status}</span><small>{attempt.statusDescription}</small></td><td>{attempt.providerReference ?? attempt.transactionId ?? '—'}</td></tr>)}</tbody></table></div>}
        {showPaymentForm && (
          <form className="cost-add-form" onSubmit={(event) => void recordPayment(event)}>
            <input className="input-control" type="number" min="0.01" step="0.01" placeholder="Amount" required value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} />
            <select className="input-control" value={paymentForm.method} onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value }))}>
              {Object.entries(paymentMethodNames).map(([method, label]) => <option key={method} value={method}>{label}</option>)}
            </select>
            <input className="input-control" placeholder="Reference (optional)" value={paymentForm.reference} onChange={(event) => setPaymentForm((current) => ({ ...current, reference: event.target.value }))} />
            <label className="field-label deposit-checkbox"><input type="checkbox" checked={paymentForm.isDeposit} onChange={(event) => setPaymentForm((current) => ({ ...current, isDeposit: event.target.checked }))} /> Mark as deposit</label>
            <button className="button button-primary" type="submit" disabled={paymentSaving}>{paymentSaving ? 'Saving…' : 'Record'}</button>
          </form>
        )}
      </section>
      {(invoice.reconciliations?.length ?? 0) > 0 && <section className="workspace-panel"><div className="panel-heading"><div><h2>Reconciliation history</h2><p>Reason-recorded adjustments to stored invoice totals</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>When</th><th>By</th><th>Reason</th><th>Paid total</th><th>Balance due</th></tr></thead><tbody>{invoice.reconciliations?.map((event) => <tr key={event.id}><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.createdAt))}</td><td>{event.actorName}</td><td>{event.reason}</td><td>{formatMoney(event.previousAmountPaid, invoice.currency)} → {formatMoney(event.correctedAmountPaid, invoice.currency)}</td><td>{formatMoney(event.previousBalanceDue, invoice.currency)} → {formatMoney(event.correctedBalanceDue, invoice.currency)}</td></tr>)}</tbody></table></div></section>}
      {(invoice.allocationHistory?.length ?? 0) > 0 && <section className="workspace-panel"><div className="panel-heading"><div><h2>Payment allocation history</h2><p>Recorded payment movements for this invoice</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>When</th><th>Action</th><th>Receipt</th><th>Amount</th><th>Reason</th><th>By</th></tr></thead><tbody>{invoice.allocationHistory?.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td>{event.eventType === 'REVERSE' ? 'Moved out' : 'Applied'}</td><td>{event.receiptNumber}</td><td>{formatMoney(event.amount, event.currency)}</td><td>{event.reason}</td><td>{event.actorName}</td></tr>)}</tbody></table></div></section>}
    </section>
  )
}
