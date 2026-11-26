import { useEffect, useState } from 'react'
import './App.css'
import { apiRequest, setSessionExpiredHandler, setSubscriptionPaymentRequiredHandler } from './api'
import MarketingSite from './MarketingSite'
import QuoteWorkspace from './QuoteWorkspace'
import SuperadminDashboard from './SuperadminDashboard'
import PublicQuote from './PublicQuote'
import PublicJobProgress from './PublicJobProgress'
import BillingGate from './BillingGate'

type User = {
  id: string
  name: string
  email: string
  role: string
  teamRole?: string
}

function App() {
  const publicMatch = window.location.pathname.match(/^\/quote\/([^/]+)\/?$/)
  const publicJobMatch = window.location.pathname.match(/^\/job-progress\/([^/]+)\/?$/)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [adminMfaLogin, setAdminMfaLogin] = useState(false)
  const [billingLocked, setBillingLocked] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingReason, setBillingReason] = useState<'manage' | 'trial-cap'>('manage')

  // Global session expiry handler — clears user state when the API returns 401
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
    })
    setSubscriptionPaymentRequiredHandler(() => setBillingLocked(true))
    return () => {
      setSessionExpiredHandler(null)
      setSubscriptionPaymentRequiredHandler(null)
    }
  }, [])

  useEffect(() => {
    if (publicMatch || publicJobMatch) {
      setLoading(false)
      return
    }

    const loadSession = async () => {
      try {
        const response = await apiRequest<{ user?: User; mfaRequired?: boolean; mfaSetupRequired?: boolean }>('/api/auth/me')
        if (response.mfaRequired || response.mfaSetupRequired) {
          setAdminMfaLogin(true)
          setUser(null)
        } else {
          const activeUser = response.user ?? null
          setUser(activeUser)
          if (activeUser && activeUser.role !== 'SUPERADMIN') {
            try {
              const billing = await apiRequest<{ locked: boolean }>('/api/billing/status')
              setBillingLocked(billing.locked)
            } catch {
              setBillingLocked(false)
            }
          }
        }
      } catch {
        setUser(null)
      } finally {
        setLoading(false)
      }
    }

    void loadSession()
  }, [])

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore logout request issues and clear the UI.
    } finally {
      setUser(null)
      setBillingLocked(false)
    }
  }

  if (publicMatch) {
    return <PublicQuote token={decodeURIComponent(publicMatch[1])} />
  }
  if (publicJobMatch) {
    return <PublicJobProgress token={decodeURIComponent(publicJobMatch[1])} />
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="loading-state">Loading your workspace…</div>
      </div>
    )
  }

  if (!user) return <MarketingSite initialScreen={adminMfaLogin ? 'login' : undefined} />

  if (user.role === 'SUPERADMIN') {
    return <SuperadminDashboard user={user} onLogout={handleLogout} />
  }

  if (billingLocked || billingOpen) {
    return <BillingGate isOwner={user.teamRole === 'OWNER'} reason={billingLocked ? 'expired' : billingReason} onBack={billingLocked ? undefined : () => setBillingOpen(false)} onUnlocked={() => { setBillingLocked(false); setBillingOpen(false) }} onLogout={handleLogout} />
  }

  // QuoteWorkspace handles business profile loading, settings, and all workspace pages.
  // If businessProfile is missing (edge case after registration), QuoteWorkspace's
  // settings page provides the business setup form.
  return <QuoteWorkspace user={user} onLogout={handleLogout} onOpenBilling={(reason) => { setBillingReason(reason); setBillingOpen(true) }} />
}

export default App
