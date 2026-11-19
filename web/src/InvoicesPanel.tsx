import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'

type Customer = { id: string; name: string; phone: string | null; email: string | null }
type Business = { id: string; name: string; currency: string }

type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED'

type Payment = {
  id: string
  amount: number
  method: string
  reference: string | null
  paymentDate: string
}

type Invoice = {
  id: string
  invoiceNumber: string
  status: InvoiceStatus
  currency: string
  customerId: string
  customer: { id: string; name: string }
  jobId: string | null
  job?: { id: string; title: string } | null
  subtotal: number
  taxTotal: number
  total: number
  amountPaid: number
  balanceDue: number
  issueDate: string
  dueDate: string | null
  notes: string | null
  payments?: Payment[]
}

type InvoiceListResponse = { invoices: Invoice[]; totalCount: number; hasMore: boolean }
type InvoiceResponse = { invoice: Invoice }

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

type InvoiceForm = {
  customerId: string
  subtotal: string
  taxTotal: string
  dueDate: string
  notes: string
}

const blankInvoiceForm: InvoiceForm = {
  customerId: '',
  subtotal: '0',
  taxTotal: '0',
  dueDate: '',
  notes: '',
}

type PaymentForm = {
  amount: string
  method: string
  reference: string
}

const blankPaymentForm: PaymentForm = {
  amount: '0',
  method: 'CASH',
  reference: '',
}

function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(date))
  } catch {
    return '—'
  }
}

export default function InvoicesPanel({ customers, currency }: { business: Business; customers: Customer[]; currency: string }) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [invoiceModal, setInvoiceModal] = useState(false)
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>(blankInvoiceForm)
  const [invoiceError, setInvoiceError] = useState('')
  const [saving, setSaving] = useState(false)

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

  const openInvoiceModal = () => {
    if (!customers.length) {
      setError('Add a customer first before creating an invoice.')
      return
    }
    setInvoiceForm({ ...blankInvoiceForm, customerId: customers[0].id })
    setInvoiceError('')
    setInvoiceModal(true)
  }

  const submitInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setInvoiceError('')
    setSaving(true)
    try {
      const payload = {
        customerId: invoiceForm.customerId,
        subtotal: Number(invoiceForm.subtotal) || 0,
        taxTotal: Number(invoiceForm.taxTotal) || 0,
        dueDate: invoiceForm.dueDate || undefined,
        notes: invoiceForm.notes || undefined,
      }
      const response = await apiRequest<InvoiceResponse>('/api/invoices', { method: 'POST', body: JSON.stringify(payload) })
      setInvoices((current) => [response.invoice, ...current])
      setInvoiceModal(false)
      setInvoiceForm(blankInvoiceForm)
    } catch (requestError) {
      setInvoiceError(requestError instanceof Error ? requestError.message : 'Unable to create invoice.')
    } finally {
      setSaving(false)
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
        currency={currency}
        customers={customers}
        onBack={() => { setSelectedInvoice(null); void loadInvoices() }}
        onSend={() => void sendInvoice(selectedInvoice)}
        onInvoiceUpdate={(updated) => setSelectedInvoice(updated)}
        setError={setError}
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
        <button className="button button-primary" type="button" onClick={openInvoiceModal}>New invoice</button>
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
            <p>{invoices.length === 0 ? 'Create an invoice to track payments and balances.' : 'Try a different status filter.'}</p>
            {invoices.length === 0 && <button className="button button-primary" type="button" onClick={openInvoiceModal}>Create your first invoice</button>}
          </div>
        )}
      </section>

      {invoiceModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInvoiceModal(false) }}>
          <form className="customer-modal" onSubmit={(event) => void submitInvoice(event)}>
            <div className="modal-heading">
              <div>
                <p className="workspace-eyebrow">Money &amp; insights</p>
                <h2>New invoice</h2>
              </div>
              <button className="quiet-button" type="button" onClick={() => setInvoiceModal(false)} aria-label="Close">×</button>
            </div>
            <label className="field-label">Customer<select className="input-control" required value={invoiceForm.customerId} onChange={(event) => setInvoiceForm((current) => ({ ...current, customerId: event.target.value }))}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <div className="settings-grid">
              <label className="field-label">Subtotal<input className="input-control" type="number" min="0" step="0.01" required value={invoiceForm.subtotal} onChange={(event) => setInvoiceForm((current) => ({ ...current, subtotal: event.target.value }))} /></label>
              <label className="field-label">Tax total<input className="input-control" type="number" min="0" step="0.01" value={invoiceForm.taxTotal} onChange={(event) => setInvoiceForm((current) => ({ ...current, taxTotal: event.target.value }))} /></label>
            </div>
            <label className="field-label">Due date<input className="input-control" type="date" value={invoiceForm.dueDate} onChange={(event) => setInvoiceForm((current) => ({ ...current, dueDate: event.target.value }))} /></label>
            <label className="field-label">Notes<textarea className="input-control" rows={2} value={invoiceForm.notes} onChange={(event) => setInvoiceForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional notes for the customer" /></label>
            {invoiceError && <p className="form-error" role="alert">{invoiceError}</p>}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={() => setInvoiceModal(false)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Creating…' : 'Create invoice'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

function InvoiceDetail({ invoice, customers, onBack, onSend, onInvoiceUpdate, setError }: {
  invoice: Invoice
  currency: string
  customers: Customer[]
  onBack: () => void
  onSend: () => void
  onInvoiceUpdate: (invoice: Invoice) => void
  setError: (error: string) => void
}) {
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(blankPaymentForm)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentSaving, setPaymentSaving] = useState(false)

  const customer = customers.find((c) => c.id === invoice.customerId)
  const payments = invoice.payments ?? []

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
        }),
      })
      const response = await apiRequest<InvoiceResponse>(`/api/invoices/${invoice.id}`)
      onInvoiceUpdate(response.invoice)
      setPaymentForm(blankPaymentForm)
      setShowPaymentForm(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to record payment.')
    } finally {
      setPaymentSaving(false)
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
        {invoice.status === 'DRAFT' && <button className="button button-primary" type="button" onClick={onSend}>Send invoice</button>}
      </div>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Invoice information</h2>
            <p>{customer?.name ?? '—'} · {invoice.job?.title ?? 'No linked job'}</p>
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
        </div>
        {invoice.notes && <div className="job-description"><span>Notes</span><p>{invoice.notes}</p></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Payments</h2>
            <p>Record payments received against this invoice</p>
          </div>
          {invoice.status !== 'CANCELLED' && invoice.status !== 'PAID' && <button className="button button-secondary" type="button" onClick={() => setShowPaymentForm(!showPaymentForm)}>{showPaymentForm ? 'Cancel' : 'Record payment'}</button>}
        </div>
        <div className="cost-list">
          {payments.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>{formatDate(payment.paymentDate)}</td>
                      <td>{paymentMethodNames[payment.method] ?? payment.method}</td>
                      <td>{payment.reference ?? '—'}</td>
                      <td>{formatMoney(payment.amount, invoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="panel-empty"><p>No payments recorded yet.</p></div>}
        </div>
        {showPaymentForm && (
          <form className="cost-add-form" onSubmit={(event) => void recordPayment(event)}>
            <input className="input-control" type="number" min="0.01" step="0.01" placeholder="Amount" required value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} />
            <select className="input-control" value={paymentForm.method} onChange={(event) => setPaymentForm((current) => ({ ...current, method: event.target.value }))}>
              {Object.entries(paymentMethodNames).map(([method, label]) => <option key={method} value={method}>{label}</option>)}
            </select>
            <input className="input-control" placeholder="Reference (optional)" value={paymentForm.reference} onChange={(event) => setPaymentForm((current) => ({ ...current, reference: event.target.value }))} />
            <button className="button button-primary" type="submit" disabled={paymentSaving}>{paymentSaving ? 'Saving…' : 'Record'}</button>
          </form>
        )}
      </section>
    </section>
  )
}
