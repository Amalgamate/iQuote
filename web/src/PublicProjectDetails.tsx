import { formatMoney } from './api'

export type PublicProject = {
  title: string
  status: string
  updatedAt: string
  milestones: Array<{ id: string; title: string; dueDate: string | null; completedAt: string | null }>
}

export type PublicInvoice = {
  invoiceNumber: string
  status: string
  currency: string
  subtotal: number
  taxTotal: number
  total: number
  amountPaid: number
  balanceDue: number
  issueDate: string
  dueDate: string | null
  lineItems: Array<{ description: string; quantity: number; unit: string; unitPrice: number; taxRate: number | null }>
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Not set'
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(value))
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export default function PublicProjectDetails({ project, invoice, quoteNumber }: { project: PublicProject | null; invoice: PublicInvoice | null; quoteNumber?: string }) {
  if (!project && !invoice) return null

  return (
    <section className="public-project-portal" aria-label="Project and invoice updates">
      <header className="public-project-heading">
        <div>
          <p className="workspace-eyebrow">Your iQuote link</p>
          <h2>Project updates &amp; billing</h2>
          <p>Track the work, review invoices, and message the team here.</p>
        </div>
        {quoteNumber && <span className="public-project-quote">Quote {quoteNumber}</span>}
      </header>

      {project && <article className="public-project-card">
        <div className="public-project-card-heading">
          <div><p className="workspace-eyebrow">Project</p><h3>{project.title}</h3></div>
          <span className={`status-badge status-${project.status.toLowerCase()}`}>{statusLabel(project.status)}</span>
        </div>
        <p className="public-project-updated">Last updated {dateLabel(project.updatedAt)}</p>
        <div className="public-project-milestones">
          {project.milestones.length ? project.milestones.map((milestone) => <div className="public-project-milestone" key={milestone.id}>
            <span className={milestone.completedAt ? 'milestone-indicator complete' : 'milestone-indicator'} aria-hidden="true">{milestone.completedAt ? '✓' : ''}</span>
            <div><strong>{milestone.title}</strong><small>{milestone.completedAt ? `Completed ${dateLabel(milestone.completedAt)}` : milestone.dueDate ? `Expected ${dateLabel(milestone.dueDate)}` : 'In progress'}</small></div>
          </div>) : <p className="public-project-empty">The team will post customer-visible milestones here as work is scheduled.</p>}
        </div>
      </article>}

      {project && !invoice && <article className="public-project-card public-invoice-pending"><div><p className="workspace-eyebrow">Invoice</p><h3>Invoice will appear here when issued</h3><p>The business will share the customer invoice in this same link when it is ready.</p></div></article>}

      {invoice && <article className="public-project-card public-invoice-card">
        <div className="public-project-card-heading">
          <div><p className="workspace-eyebrow">Invoice</p><h3>{invoice.invoiceNumber}</h3></div>
          <span className={`status-badge status-${invoice.status.toLowerCase()}`}>{statusLabel(invoice.status)}</span>
        </div>
        <div className="public-invoice-summary">
          <div><span>Invoice total</span><strong>{formatMoney(invoice.total, invoice.currency)}</strong></div>
          <div><span>Paid</span><strong>{formatMoney(invoice.amountPaid, invoice.currency)}</strong></div>
          <div><span>Balance due</span><strong>{formatMoney(invoice.balanceDue, invoice.currency)}</strong></div>
          {invoice.dueDate && <div><span>Due date</span><strong>{dateLabel(invoice.dueDate)}</strong></div>}
        </div>
        {invoice.lineItems.length > 0 && <div className="table-scroll public-invoice-lines"><table className="data-table"><thead><tr><th>Work</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>
          {invoice.lineItems.map((line, index) => <tr key={`${line.description}-${index}`}><td>{line.description}</td><td>{line.quantity} {line.unit}</td><td>{formatMoney(line.unitPrice, invoice.currency)}</td><td>{formatMoney(line.quantity * line.unitPrice, invoice.currency)}</td></tr>)}
        </tbody></table></div>}
        <p className="public-project-updated">Issued {dateLabel(invoice.issueDate)} · This invoice is linked to your accepted quotation.</p>
      </article>}
    </section>
  )
}
