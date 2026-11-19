import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'

type Customer = { id: string; name: string; phone: string | null; email: string | null }
type Business = {
  id: string
  name: string
  currency: string
}

type JobStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'ON_HOLD'

type Milestone = {
  id: string
  title: string
  dueDate: string | null
  completedAt: string | null
  position: number
}

type Cost = {
  id: string
  description: string
  amount: number
  category: string | null
  incurredAt: string | null
}

type Job = {
  id: string
  title: string
  status: JobStatus
  description: string | null
  startDate: string | null
  endDate: string | null
  currency: string
  customerId: string
  customer: { id: string; name: string }
  quoteId: string | null
  quote?: { id: string; documentNumber: string; status: string } | null
  milestones: Milestone[]
  costs: Cost[]
  createdAt: string
  updatedAt: string
}

type JobListResponse = { jobs: Job[]; totalCount: number; hasMore: boolean }
type JobResponse = { job: Job }
type MilestoneResponse = { milestone: Milestone }
type CostListResponse = { costs: Cost[] }
type CostResponse = { cost: Cost }

const jobStatusNames: Record<JobStatus, string> = {
  PLANNED: 'Planned',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On Hold',
}

const jobStatusClasses: Record<JobStatus, string> = {
  PLANNED: 'status-badge status-planned',
  IN_PROGRESS: 'status-badge status-in_progress',
  COMPLETED: 'status-badge status-completed',
  CANCELLED: 'status-badge status-cancelled',
  ON_HOLD: 'status-badge status-on_hold',
}

type JobForm = {
  title: string
  customerId: string
  description: string
  status: JobStatus
  startDate: string
  endDate: string
}

const blankJobForm: JobForm = {
  title: '',
  customerId: '',
  description: '',
  status: 'PLANNED',
  startDate: '',
  endDate: '',
}

type MilestoneForm = { title: string; dueDate: string }
const blankMilestoneForm: MilestoneForm = { title: '', dueDate: '' }

type CostForm = { description: string; amount: string; category: string; incurredAt: string }
const blankCostForm: CostForm = { description: '', amount: '0', category: '', incurredAt: '' }

function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(date))
  } catch {
    return '—'
  }
}

function totalCosts(costs: Cost[]): number {
  return costs.reduce((sum, cost) => sum + Number(cost.amount || 0), 0)
}

export default function JobsPanel({ business, customers, currency }: { business: Business; customers: Customer[]; currency: string }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [jobModal, setJobModal] = useState(false)
  const [jobForm, setJobForm] = useState<JobForm>(blankJobForm)
  const [jobError, setJobError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadJobs()
  }, [])

  const loadJobs = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<JobListResponse>('/api/jobs')
      setJobs(response.jobs)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load jobs.')
    } finally {
      setLoading(false)
    }
  }

  const filteredJobs = useMemo(() => {
    if (statusFilter === 'ALL') return jobs
    return jobs.filter((job) => job.status === statusFilter)
  }, [jobs, statusFilter])

  const openJobDetail = async (job: Job) => {
    setError('')
    try {
      const response = await apiRequest<JobResponse>(`/api/jobs/${job.id}`)
      setSelectedJob(response.job)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load job details.')
    }
  }

  const openJobModal = () => {
    if (!customers.length) {
      setError('Add a customer first before creating a job.')
      return
    }
    setJobForm({ ...blankJobForm, customerId: customers[0].id })
    setJobError('')
    setJobModal(true)
  }

  const submitJob = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setJobError('')
    setSaving(true)
    try {
      const payload = {
        title: jobForm.title,
        customerId: jobForm.customerId,
        description: jobForm.description || undefined,
        status: jobForm.status,
        startDate: jobForm.startDate || undefined,
        endDate: jobForm.endDate || undefined,
      }
      const response = await apiRequest<JobResponse>('/api/jobs', { method: 'POST', body: JSON.stringify(payload) })
      setJobs((current) => [response.job, ...current])
      setJobModal(false)
      setJobForm(blankJobForm)
    } catch (requestError) {
      setJobError(requestError instanceof Error ? requestError.message : 'Unable to create job.')
    } finally {
      setSaving(false)
    }
  }

  const updateJobStatus = async (job: Job, status: JobStatus) => {
    try {
      const response = await apiRequest<JobResponse>(`/api/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify({ status }) })
      setJobs((current) => current.map((j) => (j.id === response.job.id ? response.job : j)))
      setSelectedJob(response.job)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update job.')
    }
  }

  if (selectedJob) {
    return (
      <JobDetail
        job={selectedJob}
        currency={currency}
        customers={customers}
        onBack={() => { setSelectedJob(null); void loadJobs() }}
        onStatusChange={(status) => void updateJobStatus(selectedJob, status)}
        onJobUpdate={(updated) => setSelectedJob(updated)}
        setError={setError}
      />
    )
  }

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <p className="workspace-eyebrow">Deliver work</p>
          <h2>Jobs</h2>
        </div>
        <button className="button button-primary" type="button" onClick={openJobModal}>New job</button>
      </div>

      {error && <div className="workspace-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

      <div className="filter-row">
        <select className="input-control filter-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="ALL">All statuses</option>
          {Object.entries(jobStatusNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select>
      </div>

      <section className="workspace-panel">
        {loading ? (
          <div className="panel-empty"><p>Loading jobs…</p></div>
        ) : filteredJobs.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Costs</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.id} onClick={() => void openJobDetail(job)}>
                    <td><strong>{job.title}</strong><small>{formatDate(job.createdAt)}</small></td>
                    <td>{job.customer?.name ?? '—'}</td>
                    <td><span className={jobStatusClasses[job.status]}>{jobStatusNames[job.status]}</span></td>
                    <td>{formatDate(job.startDate)}</td>
                    <td>{formatDate(job.endDate)}</td>
                    <td>{formatMoney(totalCosts(job.costs ?? []), currency)}</td>
                    <td><button className="quiet-button" type="button" onClick={(event) => { event.stopPropagation(); void openJobDetail(job) }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel-empty">
            <h3>{jobs.length === 0 ? 'No jobs yet' : 'No jobs match this filter'}</h3>
            <p>{jobs.length === 0 ? 'Create a job to track milestones and costs for your work.' : 'Try a different status filter.'}</p>
            {jobs.length === 0 && <button className="button button-primary" type="button" onClick={openJobModal}>Create your first job</button>}
          </div>
        )}
      </section>

      {jobModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setJobModal(false) }}>
          <form className="customer-modal" onSubmit={(event) => void submitJob(event)}>
            <div className="modal-heading">
              <div>
                <p className="workspace-eyebrow">Deliver work</p>
                <h2>New job</h2>
              </div>
              <button className="quiet-button" type="button" onClick={() => setJobModal(false)} aria-label="Close">×</button>
            </div>
            <label className="field-label">Title<input className="input-control" required value={jobForm.title} onChange={(event) => setJobForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. Bathroom renovation" /></label>
            <label className="field-label">Customer<select className="input-control" required value={jobForm.customerId} onChange={(event) => setJobForm((current) => ({ ...current, customerId: event.target.value }))}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <label className="field-label">Description<textarea className="input-control" rows={3} value={jobForm.description} onChange={(event) => setJobForm((current) => ({ ...current, description: event.target.value }))} placeholder="Brief scope of work" /></label>
            <div className="settings-grid">
              <label className="field-label">Status<select className="input-control" value={jobForm.status} onChange={(event) => setJobForm((current) => ({ ...current, status: event.target.value as JobStatus }))}>{Object.entries(jobStatusNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
              <label className="field-label">Start date<input className="input-control" type="date" value={jobForm.startDate} onChange={(event) => setJobForm((current) => ({ ...current, startDate: event.target.value }))} /></label>
              <label className="field-label">End date<input className="input-control" type="date" value={jobForm.endDate} onChange={(event) => setJobForm((current) => ({ ...current, endDate: event.target.value }))} /></label>
            </div>
            {jobError && <p className="form-error" role="alert">{jobError}</p>}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={() => setJobModal(false)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Creating…' : 'Create job'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

function JobDetail({ job, currency, customers, onBack, onStatusChange, onJobUpdate, setError }: {
  job: Job
  currency: string
  customers: Customer[]
  onBack: () => void
  onStatusChange: (status: JobStatus) => void
  onJobUpdate: (job: Job) => void
  setError: (error: string) => void
}) {
  const [milestoneForm, setMilestoneForm] = useState<MilestoneForm>(blankMilestoneForm)
  const [costForm, setCostForm] = useState<CostForm>(blankCostForm)
  const [editMilestoneId, setEditMilestoneId] = useState<string | null>(null)
  const [editMilestoneForm, setEditMilestoneForm] = useState<MilestoneForm>(blankMilestoneForm)
  const [showCostForm, setShowCostForm] = useState(false)

  const customer = customers.find((c) => c.id === job.customerId)

  const addMilestone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!milestoneForm.title.trim()) return
    try {
      const response = await apiRequest<MilestoneResponse>(`/api/jobs/${job.id}/milestones`, {
        method: 'POST',
        body: JSON.stringify({ title: milestoneForm.title, dueDate: milestoneForm.dueDate || undefined }),
      })
      onJobUpdate({ ...job, milestones: [...job.milestones, response.milestone] })
      setMilestoneForm(blankMilestoneForm)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to add milestone.')
    }
  }

  const toggleMilestoneComplete = async (milestone: Milestone) => {
    try {
      const completedAt = milestone.completedAt ? null : new Date().toISOString()
      const response = await apiRequest<MilestoneResponse>(`/api/jobs/${job.id}/milestones/${milestone.id}`, {
        method: 'PUT',
        body: JSON.stringify({ completedAt }),
      })
      onJobUpdate({ ...job, milestones: job.milestones.map((m) => (m.id === response.milestone.id ? response.milestone : m)) })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update milestone.')
    }
  }

  const startEditMilestone = (milestone: Milestone) => {
    setEditMilestoneId(milestone.id)
    setEditMilestoneForm({ title: milestone.title, dueDate: milestone.dueDate ? milestone.dueDate.slice(0, 10) : '' })
  }

  const saveEditMilestone = async (milestoneId: string) => {
    try {
      const response = await apiRequest<MilestoneResponse>(`/api/jobs/${job.id}/milestones/${milestoneId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: editMilestoneForm.title, dueDate: editMilestoneForm.dueDate || undefined }),
      })
      onJobUpdate({ ...job, milestones: job.milestones.map((m) => (m.id === response.milestone.id ? response.milestone : m)) })
      setEditMilestoneId(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update milestone.')
    }
  }

  const deleteMilestone = async (milestone: Milestone) => {
    if (!window.confirm(`Delete milestone "${milestone.title}"?`)) return
    try {
      await apiRequest(`/api/jobs/${job.id}/milestones/${milestone.id}`, { method: 'DELETE' })
      onJobUpdate({ ...job, milestones: job.milestones.filter((m) => m.id !== milestone.id) })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete milestone.')
    }
  }

  const addCost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!costForm.description.trim() || Number(costForm.amount) <= 0) return
    try {
      const response = await apiRequest<CostResponse>(`/api/jobs/${job.id}/costs`, {
        method: 'POST',
        body: JSON.stringify({
          description: costForm.description,
          amount: Number(costForm.amount),
          category: costForm.category || undefined,
          incurredAt: costForm.incurredAt || undefined,
        }),
      })
      onJobUpdate({ ...job, costs: [...job.costs, response.cost] })
      setCostForm(blankCostForm)
      setShowCostForm(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to add cost.')
    }
  }

  const refreshCosts = async () => {
    try {
      const response = await apiRequest<CostListResponse>(`/api/jobs/${job.id}/costs`)
      onJobUpdate({ ...job, costs: response.costs })
    } catch {
      /* costs already loaded from job detail */
    }
  }

  useEffect(() => { void refreshCosts() }, [])

  const costs = job.costs ?? []
  const milestones = job.milestones ?? []

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <button className="link-button" type="button" onClick={onBack}>← All jobs</button>
          <p className="workspace-eyebrow">Job detail</p>
          <h2>{job.title}</h2>
        </div>
        <select className="input-control filter-control" value={job.status} onChange={(event) => onStatusChange(event.target.value as JobStatus)}>
          {Object.entries(jobStatusNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select>
      </div>

      <section className="workspace-panel job-detail">
        <div className="panel-heading">
          <div>
            <h2>Job information</h2>
            <p>{customer?.name ?? '—'} · {job.quote?.documentNumber ?? 'No linked quote'}</p>
          </div>
          <span className={jobStatusClasses[job.status]}>{jobStatusNames[job.status]}</span>
        </div>
        <div className="job-info-grid">
          <div><span>Customer</span><strong>{customer?.name ?? '—'}</strong></div>
          <div><span>Start date</span><strong>{formatDate(job.startDate)}</strong></div>
          <div><span>End date</span><strong>{formatDate(job.endDate)}</strong></div>
          <div><span>Created</span><strong>{formatDate(job.createdAt)}</strong></div>
        </div>
        {job.description && <div className="job-description"><span>Description</span><p>{job.description}</p></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Milestones</h2>
            <p>Track key steps and deadlines</p>
          </div>
        </div>
        <div className="milestone-list">
          {milestones.length > 0 ? milestones.sort((a, b) => a.position - b.position).map((milestone) => (
            <div key={milestone.id} className="milestone-item">
              <label className="milestone-check">
                <input type="checkbox" checked={Boolean(milestone.completedAt)} onChange={() => void toggleMilestoneComplete(milestone)} />
              </label>
              {editMilestoneId === milestone.id ? (
                <div className="milestone-edit">
                  <input className="input-control" value={editMilestoneForm.title} onChange={(event) => setEditMilestoneForm((current) => ({ ...current, title: event.target.value }))} />
                  <input className="input-control" type="date" value={editMilestoneForm.dueDate} onChange={(event) => setEditMilestoneForm((current) => ({ ...current, dueDate: event.target.value }))} />
                  <button className="button button-primary" type="button" onClick={() => void saveEditMilestone(milestone.id)}>Save</button>
                  <button className="quiet-button" type="button" onClick={() => setEditMilestoneId(null)}>Cancel</button>
                </div>
              ) : (
                <div className="milestone-content">
                  <strong className={milestone.completedAt ? 'milestone-done' : ''}>{milestone.title}</strong>
                  <small>Due: {formatDate(milestone.dueDate)}{milestone.completedAt && ` · Completed ${formatDate(milestone.completedAt)}`}</small>
                </div>
              )}
              {editMilestoneId !== milestone.id && (
                <div className="table-action-group">
                  <button className="quiet-button" type="button" onClick={() => startEditMilestone(milestone)}>Edit</button>
                  <button className="quiet-button danger-button" type="button" onClick={() => void deleteMilestone(milestone)}>Delete</button>
                </div>
              )}
            </div>
          )) : <div className="panel-empty"><p>No milestones yet.</p></div>}
        </div>
        <form className="milestone-add-form" onSubmit={(event) => void addMilestone(event)}>
          <input className="input-control" placeholder="Milestone title" required value={milestoneForm.title} onChange={(event) => setMilestoneForm((current) => ({ ...current, title: event.target.value }))} />
          <input className="input-control" type="date" value={milestoneForm.dueDate} onChange={(event) => setMilestoneForm((current) => ({ ...current, dueDate: event.target.value }))} />
          <button className="button button-secondary" type="submit">Add milestone</button>
        </form>
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>Costs</h2>
            <p>Track expenses for this job</p>
          </div>
          <button className="button button-secondary" type="button" onClick={() => setShowCostForm(!showCostForm)}>{showCostForm ? 'Cancel' : 'Add cost'}</button>
        </div>
        <div className="cost-list">
          {costs.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Description</th><th>Category</th><th>Date</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {costs.map((cost) => (
                    <tr key={cost.id}>
                      <td><strong>{cost.description}</strong></td>
                      <td>{cost.category ?? '—'}</td>
                      <td>{formatDate(cost.incurredAt)}</td>
                      <td>{formatMoney(Number(cost.amount), currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="panel-empty"><p>No costs recorded yet.</p></div>}
        </div>
        {showCostForm && (
          <form className="cost-add-form" onSubmit={(event) => void addCost(event)}>
            <input className="input-control" placeholder="Description" required value={costForm.description} onChange={(event) => setCostForm((current) => ({ ...current, description: event.target.value }))} />
            <input className="input-control" type="number" min="0" step="0.01" placeholder="Amount" required value={costForm.amount} onChange={(event) => setCostForm((current) => ({ ...current, amount: event.target.value }))} />
            <input className="input-control" placeholder="Category" value={costForm.category} onChange={(event) => setCostForm((current) => ({ ...current, category: event.target.value }))} />
            <input className="input-control" type="date" value={costForm.incurredAt} onChange={(event) => setCostForm((current) => ({ ...current, incurredAt: event.target.value }))} />
            <button className="button button-primary" type="submit">Add cost</button>
          </form>
        )}
        <div className="cost-summary">
          <span>Total costs</span>
          <strong>{formatMoney(totalCosts(costs), currency)}</strong>
        </div>
      </section>
    </section>
  )
}
