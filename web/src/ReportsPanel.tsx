import { useEffect, useState } from 'react'
import { apiRequest, formatMoney } from './api'

type Business = { id: string; name: string; currency: string }

type ReportData = {
  funnel: { sent: number; viewed: number; approved: number; declined: number }
  repeatCustomers: Array<{ id: string; name: string; approvedQuotes: number }>
  revenueByCurrency: Record<string, { totalInvoiced: number; totalPaid: number; totalDue: number }>
  jobProfitability: Array<{ id: string; title: string; estimated: number; actualCosts: number; invoiced: number; collected: number; margin: number }>
}

export default function ReportsPanel({ currency }: { business: Business; currency: string }) {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadReports()
  }, [])

  const loadReports = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<ReportData>('/api/reports')
      setData(response)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load reports.')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <section className="workspace-content">
        <div className="panel-empty"><p>Loading reports…</p></div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="workspace-content">
        <div className="workspace-alert" role="alert"><span>{error}</span></div>
      </section>
    )
  }

  if (!data) return null

  const funnelConversionRate = data.funnel.sent > 0 ? Math.round((data.funnel.approved / data.funnel.sent) * 100) : 0

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <p className="workspace-eyebrow">Money &amp; insights</p>
          <h2>Reports</h2>
        </div>
      </div>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Quote funnel</h2>
            <p>Track how quotes move from sent to approved</p>
          </div>
        </div>
        <div className="dashboard-stats">
          <div className="stat-card">
            <span className="stat-label">Sent</span>
            <strong className="stat-value">{data.funnel.sent}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Viewed</span>
            <strong className="stat-value">{data.funnel.viewed}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Approved</span>
            <strong className="stat-value">{data.funnel.approved}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Declined</span>
            <strong className="stat-value">{data.funnel.declined}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Conversion rate</span>
            <strong className="stat-value">{funnelConversionRate}%</strong>
          </div>
        </div>
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Revenue by currency</h2>
            <p>Invoiced, collected, and outstanding amounts grouped by currency</p>
          </div>
        </div>
        {Object.keys(data.revenueByCurrency).length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Currency</th><th>Total invoiced</th><th>Collected</th><th>Outstanding</th></tr>
              </thead>
              <tbody>
                {Object.entries(data.revenueByCurrency).map(([curr, rev]) => (
                  <tr key={curr}>
                    <td><strong>{curr}</strong></td>
                    <td>{formatMoney(rev.totalInvoiced, curr)}</td>
                    <td>{formatMoney(rev.totalPaid, curr)}</td>
                    <td>{formatMoney(rev.totalDue, curr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="panel-empty"><p>No invoice data yet.</p></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Repeat customers</h2>
            <p>Customers with more than one approved quote</p>
          </div>
        </div>
        {data.repeatCustomers.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Customer</th><th>Approved quotes</th></tr>
              </thead>
              <tbody>
                {data.repeatCustomers.map((customer) => (
                  <tr key={customer.id}>
                    <td><strong>{customer.name}</strong></td>
                    <td>{customer.approvedQuotes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="panel-empty"><p>No repeat customers yet.</p></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Job profitability</h2>
            <p>Estimated value vs actual costs and collected revenue</p>
          </div>
        </div>
        {data.jobProfitability.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Job</th><th>Estimated</th><th>Actual costs</th><th>Invoiced</th><th>Collected</th><th>Margin</th></tr>
              </thead>
              <tbody>
                {data.jobProfitability.map((job) => (
                  <tr key={job.id}>
                    <td><strong>{job.title}</strong></td>
                    <td>{formatMoney(job.estimated, currency)}</td>
                    <td>{formatMoney(job.actualCosts, currency)}</td>
                    <td>{formatMoney(job.invoiced, currency)}</td>
                    <td>{formatMoney(job.collected, currency)}</td>
                    <td className={job.margin >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(job.margin, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="panel-empty"><p>No jobs to report yet.</p></div>}
      </section>
    </section>
  )
}
