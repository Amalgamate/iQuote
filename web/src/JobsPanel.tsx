import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { apiRequest, downloadAuthenticatedFile, formatMoney } from './api'

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
  customerVisible: boolean
}

type Cost = {
  id: string
  description: string
  amount: number
  currency: string
  category: string | null
  incurredAt: string | null
}

type JobActivity = {
  id: string
  actorName: string
  action: string
  details: { title?: string; fromStatus?: string; toStatus?: string; fromOwnerId?: string; toOwnerName?: string; amount?: number; currency?: string } | null
  createdAt: string
}

type JobAttachment = { id: string; originalFilename: string; mimeType: string; sizeBytes: number; uploadedBy: string; uploaderName: string; createdAt: string }

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) return reject(new Error('Could not read this file.'))
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(new Error('Could not read this file.'))
    reader.readAsDataURL(file)
  })
}

type Job = {
  id: string
  ownerId: string
  owner?: { id: string; name: string; email: string }
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
  activities?: JobActivity[]
  attachments?: JobAttachment[]
  progressEnabled?: boolean
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

const nextJobStatuses: Record<JobStatus, JobStatus[]> = {
  PLANNED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['PLANNED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  CANCELLED: ['PLANNED'],
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
  ownerId: string
  description: string
  status: JobStatus
  startDate: string
  endDate: string
}

const blankJobForm: JobForm = {
  title: '',
  customerId: '',
  ownerId: '',
  description: '',
  status: 'PLANNED',
  startDate: '',
  endDate: '',
}

type MilestoneForm = { title: string; dueDate: string }
const blankMilestoneForm: MilestoneForm = { title: '', dueDate: '' }

type CostForm = { description: string; amount: string; category: string; incurredAt: string }
const blankCostForm: CostForm = { description: '', amount: '0', category: 'MATERIALS', incurredAt: '' }

function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(date))
  } catch {
    return '—'
  }
}

function formatCostTotals(costs: Cost[], fallbackCurrency: string): string {
  const totals = new Map<string, number>()
  for (const cost of costs) totals.set(cost.currency || fallbackCurrency, (totals.get(cost.currency || fallbackCurrency) ?? 0) + Number(cost.amount || 0))
  return totals.size ? Array.from(totals, ([code, amount]) => formatMoney(amount, code)).join(' · ') : formatMoney(0, fallbackCurrency)
}

type JobAssignee = { id: string; name: string; email: string; teamRole: string }

export default function JobsPanel({ customers, currency, canManageJobs }: { business: Business; customers: Customer[]; currency: string; canManageJobs: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [jobModal, setJobModal] = useState(false)
  const [jobForm, setJobForm] = useState<JobForm>(blankJobForm)
  const [jobError, setJobError] = useState('')
  const [saving, setSaving] = useState(false)
  const [teamMembers, setTeamMembers] = useState<JobAssignee[]>([])

  useEffect(() => {
    void loadJobs()
    void apiRequest<{ members: JobAssignee[] }>('/api/team').then((response) => setTeamMembers(response.members)).catch(() => setTeamMembers([]))
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
    setJobForm({ ...blankJobForm, customerId: customers[0].id, ownerId: teamMembers.find((member) => member.teamRole === 'OWNER')?.id ?? '' })
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
        ...(jobForm.ownerId ? { ownerId: jobForm.ownerId } : {}),
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

  const updateJobOwner = async (job: Job, ownerId: string) => {
    try {
      const response = await apiRequest<JobResponse>(`/api/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify({ ownerId }) })
      setJobs((current) => current.map((item) => item.id === response.job.id ? response.job : item))
      setSelectedJob(response.job)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to assign this job.')
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
        teamMembers={teamMembers}
        canManageJobs={canManageJobs}
        onOwnerChange={(ownerId) => void updateJobOwner(selectedJob, ownerId)}
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
                    <td><strong>{job.title}</strong><small>{job.owner?.name ? `Owner: ${job.owner.name} · ` : ''}{formatDate(job.createdAt)}</small></td>
                    <td>{job.customer?.name ?? '—'}</td>
                    <td><span className={jobStatusClasses[job.status]}>{jobStatusNames[job.status]}</span></td>
                    <td>{formatDate(job.startDate)}</td>
                    <td>{formatDate(job.endDate)}</td>
                    <td>{formatCostTotals(job.costs ?? [], currency)}</td>
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
            {canManageJobs && teamMembers.length > 0 && <label className="field-label">Job owner<select className="input-control" value={jobForm.ownerId} onChange={(event) => setJobForm((current) => ({ ...current, ownerId: event.target.value }))}>{teamMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.teamRole.toLowerCase()}</option>)}</select></label>}
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

function JobDetail({ job, currency, customers, onBack, onStatusChange, onJobUpdate, setError, teamMembers, canManageJobs, onOwnerChange }: {
  job: Job
  currency: string
  customers: Customer[]
  onBack: () => void
  onStatusChange: (status: JobStatus) => void
  onJobUpdate: (job: Job) => void
  setError: (error: string) => void
  teamMembers: JobAssignee[]
  canManageJobs: boolean
  onOwnerChange: (ownerId: string) => void
}) {
  const [milestoneForm, setMilestoneForm] = useState<MilestoneForm>(blankMilestoneForm)
  const [costForm, setCostForm] = useState<CostForm>(blankCostForm)
  const [editMilestoneId, setEditMilestoneId] = useState<string | null>(null)
  const [editMilestoneForm, setEditMilestoneForm] = useState<MilestoneForm>(blankMilestoneForm)
  const [showCostForm, setShowCostForm] = useState(false)
  const [activities, setActivities] = useState<JobActivity[]>(job.activities ?? [])
  const [progressUrl, setProgressUrl] = useState<string | null>(null)
  const [attachmentUploading, setAttachmentUploading] = useState(false)

  const customer = customers.find((c) => c.id === job.customerId)

  const refreshActivity = async () => {
    try {
      const response = await apiRequest<{ activities: JobActivity[] }>(`/api/jobs/${job.id}/activity`)
      setActivities(response.activities)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load job history.')
    }
  }

  useEffect(() => { void refreshActivity() }, [job.id])

  const addMilestone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!milestoneForm.title.trim()) return
    try {
      const response = await apiRequest<MilestoneResponse>(`/api/jobs/${job.id}/milestones`, {
        method: 'POST',
        body: JSON.stringify({ title: milestoneForm.title, dueDate: milestoneForm.dueDate || undefined }),
      })
      onJobUpdate({ ...job, milestones: [...job.milestones, response.milestone] })
      void refreshActivity()
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
      void refreshActivity()
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
      void refreshActivity()
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
      void refreshActivity()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete milestone.')
    }
  }

  const toggleMilestoneVisibility = async (milestone: Milestone) => {
    try {
      const response = await apiRequest<MilestoneResponse>(`/api/jobs/${job.id}/milestones/${milestone.id}`, { method: 'PUT', body: JSON.stringify({ customerVisible: !milestone.customerVisible }) })
      onJobUpdate({ ...job, milestones: job.milestones.map((m) => (m.id === milestone.id ? response.milestone : m)) })
      void refreshActivity()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update customer visibility.')
    }
  }

  const createProgressLink = async () => {
    try {
      const response = await apiRequest<{ progressUrl: string }>(`/api/jobs/${job.id}/progress-link`, { method: 'POST' })
      setProgressUrl(response.progressUrl)
      onJobUpdate({ ...job, progressEnabled: true })
      void refreshActivity()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create customer progress link.')
    }
  }

  const revokeProgressLink = async () => {
    if (!window.confirm('Revoke the customer progress link? Anyone with the link will lose access.')) return
    try {
      await apiRequest(`/api/jobs/${job.id}/progress-link`, { method: 'DELETE' })
      setProgressUrl(null)
      onJobUpdate({ ...job, progressEnabled: false })
      void refreshActivity()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to revoke customer progress link.')
    }
  }

  const uploadAttachment = async (file: File) => {
    setAttachmentUploading(true)
    try {
      const contentBase64 = await fileToBase64(file)
      const response = await apiRequest<{ attachment: JobAttachment }>(`/api/jobs/${job.id}/attachments`, { method: 'POST', body: JSON.stringify({ filename: file.name, mimeType: file.type, contentBase64 }) })
      onJobUpdate({ ...job, attachments: [response.attachment, ...(job.attachments ?? [])] })
      void refreshActivity()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to upload this attachment.')
    } finally {
      setAttachmentUploading(false)
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
      void refreshActivity()
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
          {[job.status, ...nextJobStatuses[job.status]].map((status) => <option key={status} value={status}>{jobStatusNames[status]}</option>)}
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
          {canManageJobs && <label>Job owner<select className="input-control" value={job.ownerId} onChange={(event) => onOwnerChange(event.target.value)}>{teamMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.teamRole.toLowerCase()}</option>)}</select></label>}
        </div>
        {job.description && <div className="job-description"><span>Description</span><p>{job.description}</p></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading"><div><h2>Customer progress link</h2><p>Only milestones explicitly marked visible are shown. The link can be revoked at any time.</p></div></div>
        <div className="job-info-grid">
          <div><span>Link status</span><strong>{job.progressEnabled ? 'Active' : 'Off'}</strong></div>
          <div><button className="button button-secondary" type="button" onClick={() => void createProgressLink()}>{job.progressEnabled ? 'Rotate link' : 'Create link'}</button></div>
          {job.progressEnabled && <div><button className="quiet-button danger-button" type="button" onClick={() => void revokeProgressLink()}>Revoke link</button></div>}
        </div>
        {progressUrl && <div className="field-row"><input className="input-control" readOnly value={progressUrl} aria-label="Customer progress link" /><button className="quiet-button" type="button" onClick={() => void navigator.clipboard?.writeText(progressUrl)}>Copy link</button></div>}
      </section>

      <section className="workspace-panel">
        <div className="panel-heading"><div><h2>Job history</h2><p>Status, milestone, and cost changes with the team member and time.</p></div></div>
        <div className="milestone-list">
          {activities.length ? activities.map((activity) => (
            <div className="milestone-item" key={activity.id}>
              <div className="milestone-content">
                <strong>{activity.action.replaceAll('_', ' ').toLowerCase()}</strong>
                <small>{activity.actorName} · {new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.createdAt))}{activity.details?.fromStatus && activity.details.toStatus ? ` · ${activity.details.fromStatus} → ${activity.details.toStatus}` : ''}{activity.details?.toOwnerName ? ` · Assigned to ${activity.details.toOwnerName}` : ''}{activity.details?.title ? ` · ${activity.details.title}` : ''}{activity.details?.amount !== undefined ? ` · ${formatMoney(activity.details.amount, activity.details.currency ?? currency)}` : ''}</small>
              </div>
            </div>
          )) : <div className="panel-empty"><p>No history recorded.</p></div>}
        </div>
      </section>

      <section className="workspace-panel">
        <div className="panel-heading"><div><h2>Attachments</h2><p>Private to this workspace · PDF, PNG, JPEG, or WebP · maximum 6 MB each</p></div><label className="button button-secondary">{attachmentUploading ? 'Uploading…' : 'Add file'}<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={attachmentUploading} hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void uploadAttachment(file) }} /></label></div>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>File</th><th>Type</th><th>Added by</th><th>Added</th><th /></tr></thead><tbody>{(job.attachments ?? []).map((attachment) => <tr key={attachment.id}><td><strong>{attachment.originalFilename}</strong><small>{(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB</small></td><td>{attachment.mimeType}</td><td>{attachment.uploaderName}</td><td>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(attachment.createdAt))}</td><td><button type="button" className="dashboard-text-link" onClick={() => void downloadAuthenticatedFile(`/api/jobs/${encodeURIComponent(job.id)}/attachments/${encodeURIComponent(attachment.id)}`, attachment.originalFilename).catch((err) => setError(err instanceof Error ? err.message : 'Unable to download this attachment.'))}>Download</button></td></tr>)}</tbody></table></div>
        {!(job.attachments ?? []).length && <div className="panel-empty"><p>No job attachments yet.</p></div>}
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
              {editMilestoneId !== milestone.id && <label className="workspace-eyebrow"><input type="checkbox" checked={milestone.customerVisible} onChange={() => void toggleMilestoneVisibility(milestone)} /> Show to customer</label>}
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
                      <td>{formatMoney(Number(cost.amount), cost.currency || currency)}</td>
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
            <select className="input-control" value={costForm.category} onChange={(event) => setCostForm((current) => ({ ...current, category: event.target.value }))}><option value="MATERIALS">Materials</option><option value="LABOR">Labor</option><option value="SUPPLIER">Supplier</option><option value="TRANSPORT">Transport</option><option value="OTHER">Other</option></select>
            <input className="input-control" type="date" value={costForm.incurredAt} onChange={(event) => setCostForm((current) => ({ ...current, incurredAt: event.target.value }))} />
            <button className="button button-primary" type="submit">Add cost</button>
          </form>
        )}
        <div className="cost-summary">
          <span>Total costs</span>
          <strong>{formatCostTotals(costs, currency)}</strong>
        </div>
      </section>
    </section>
  )
}
