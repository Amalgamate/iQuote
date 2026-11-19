import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'

type Business = { id: string; name: string }

type TeamRole = 'OWNER' | 'ADMIN' | 'MEMBER'

type TeamMember = {
  id: string
  name: string
  email: string
  teamRole: TeamRole
  createdAt: string
}

type TeamInvitation = {
  id: string
  email: string
  role: TeamRole
  expiresAt: string
  createdAt: string
}

type TeamResponse = {
  members: TeamMember[]
  invitations: TeamInvitation[]
}

const roleNames: Record<TeamRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
}

function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  try {
    return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(date))
  } catch {
    return '—'
  }
}

export default function TeamPanel({ }: { business: Business }) {
  const [members, setMembers] = useState<TeamMember[]>([])
  const [invitations, setInvitations] = useState<TeamInvitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviteModal, setInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('MEMBER')
  const [inviteError, setInviteError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadTeam()
  }, [])

  const loadTeam = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<TeamResponse>('/api/team')
      setMembers(response.members)
      setInvitations(response.invitations)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load team.')
    } finally {
      setLoading(false)
    }
  }

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setInviteError('')
    setSaving(true)
    try {
      const response = await apiRequest<{ invitation: TeamInvitation }>('/api/team/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      setInvitations((current) => [response.invitation, ...current])
      setInviteModal(false)
      setInviteEmail('')
      setInviteRole('MEMBER')
    } catch (requestError) {
      setInviteError(requestError instanceof Error ? requestError.message : 'Unable to send invitation.')
    } finally {
      setSaving(false)
    }
  }

  const revokeInvitation = async (invitation: TeamInvitation) => {
    if (!window.confirm(`Revoke invitation to ${invitation.email}?`)) return
    try {
      await apiRequest(`/api/team/invitations/${invitation.id}/revoke`, { method: 'POST' })
      setInvitations((current) => current.filter((inv) => inv.id !== invitation.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to revoke invitation.')
    }
  }

  const changeRole = async (member: TeamMember, role: string) => {
    try {
      const response = await apiRequest<{ member: TeamMember }>(`/api/team/members/${member.id}/role`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      })
      setMembers((current) => current.map((m) => m.id === response.member.id ? response.member : m))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to change role.')
    }
  }

  const removeMember = async (member: TeamMember) => {
    if (!window.confirm(`Remove ${member.name} from your workspace?`)) return
    try {
      await apiRequest(`/api/team/members/${member.id}`, { method: 'DELETE' })
      setMembers((current) => current.filter((m) => m.id !== member.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to remove member.')
    }
  }

  return (
    <section className="workspace-content">
      <div className="list-toolbar">
        <div>
          <p className="workspace-eyebrow">Account</p>
          <h2>Team</h2>
        </div>
        <button className="button button-primary" type="button" onClick={() => { setInviteError(''); setInviteModal(true) }}>Invite member</button>
      </div>

      {error && <div className="workspace-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

      {loading ? (
        <div className="panel-empty"><p>Loading team…</p></div>
      ) : (
        <>
          <section className="workspace-panel">
            <div className="panel-heading">
              <div>
                <h2>Members</h2>
                <p>People with access to your workspace</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th /></tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.id}>
                      <td><strong>{member.name}</strong></td>
                      <td>{member.email}</td>
                      <td>
                        {member.teamRole === 'OWNER' ? (
                          <span className="status-badge status-completed">{roleNames[member.teamRole]}</span>
                        ) : (
                          <select className="input-control filter-control" value={member.teamRole} onChange={(event) => void changeRole(member, event.target.value)}>
                            <option value="ADMIN">Admin</option>
                            <option value="MEMBER">Member</option>
                          </select>
                        )}
                      </td>
                      <td>{formatDate(member.createdAt)}</td>
                      <td>{member.teamRole !== 'OWNER' && <button className="quiet-button danger-button" type="button" onClick={() => void removeMember(member)}>Remove</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {invitations.length > 0 && (
            <section className="workspace-panel">
              <div className="panel-heading">
                <div>
                  <h2>Pending invitations</h2>
                  <p>Sent but not yet accepted</p>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th><th /></tr>
                  </thead>
                  <tbody>
                    {invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td><strong>{invitation.email}</strong></td>
                        <td>{roleNames[invitation.role]}</td>
                        <td>{formatDate(invitation.createdAt)}</td>
                        <td>{formatDate(invitation.expiresAt)}</td>
                        <td><button className="quiet-button danger-button" type="button" onClick={() => void revokeInvitation(invitation)}>Revoke</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {inviteModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteModal(false) }}>
          <form className="customer-modal" onSubmit={(event) => void submitInvite(event)}>
            <div className="modal-heading">
              <div>
                <p className="workspace-eyebrow">Account</p>
                <h2>Invite team member</h2>
              </div>
              <button className="quiet-button" type="button" onClick={() => setInviteModal(false)} aria-label="Close">×</button>
            </div>
            <label className="field-label">Email address<input className="input-control" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="colleague@example.com" /></label>
            <label className="field-label">Role<select className="input-control" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="MEMBER">Member — can create quotes and customers</option><option value="ADMIN">Admin — can also manage team and settings</option></select></label>
            <p className="field-hint">An invitation link will be sent to this email. The invitation expires in 7 days.</p>
            {inviteError && <p className="form-error" role="alert">{inviteError}</p>}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={() => setInviteModal(false)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Sending…' : 'Send invitation'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
