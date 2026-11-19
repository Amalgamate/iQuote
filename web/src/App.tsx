import { useEffect, useState } from 'react'
import './App.css'
import { apiRequest, setSessionExpiredHandler } from './api'
import MarketingSite from './MarketingSite'
import QuoteWorkspace from './QuoteWorkspace'
import SuperadminDashboard from './SuperadminDashboard'
import PublicQuote from './PublicQuote'

type User = {
  id: string
  name: string
  email: string
  role: string
}

function App() {
  const publicMatch = window.location.pathname.match(/^\/quote\/([^/]+)\/?$/)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Global session expiry handler — clears user state when the API returns 401
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
    })
    return () => setSessionExpiredHandler(null)
  }, [])

  useEffect(() => {
    if (publicMatch) {
      setLoading(false)
      return
    }

    const loadSession = async () => {
      try {
        const response = await apiRequest<{ user?: User }>('/api/auth/me')
        setUser(response.user ?? null)
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
    }
  }

  if (publicMatch) {
    return <PublicQuote token={decodeURIComponent(publicMatch[1])} />
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="loading-state">Loading your workspace…</div>
      </div>
    )
  }

  if (!user) return <MarketingSite />

  if (user.role === 'SUPERADMIN') {
    return <SuperadminDashboard user={user} onLogout={handleLogout} />
  }

  // QuoteWorkspace handles business profile loading, settings, and all workspace pages.
  // If businessProfile is missing (edge case after registration), QuoteWorkspace's
  // settings page provides the business setup form.
  return <QuoteWorkspace user={user} onLogout={handleLogout} />
}

export default App
