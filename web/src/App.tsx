import { useEffect, useMemo, useState, type FormEvent } from 'react'
import './App.css'
import { apiRequest, setSessionExpiredHandler } from './api'
import MarketingSite from './MarketingSite'
import QuoteWorkspace from './QuoteWorkspace'
import SuperadminDashboard from './SuperadminDashboard'
import PublicQuote from './PublicQuote'

type Mode = 'login' | 'register'
type Section = 'dashboard' | 'customers'

type User = {
  id: string
  name: string
  email: string
  role: string
}

type BusinessProfile = {
  id: string
  name: string
  email: string | null
  phone: string | null
  country: string | null
  businessType: string | null
  currency: string
  defaultTaxRate: number | string | null
  quotePrefix: string | null
  subdomain?: string | null
  subscription?: { plan: string; status: string; trialEndsAt: string; simulated: boolean } | null
}

type Customer = {
  id: string
  name: string
  phone: string
  email: string
}

const stats = [
  { label: 'Quotes sent', value: '124', change: '+18%' },
  { label: 'Approval rate', value: '89%', change: '+4%' },
  { label: 'Avg. turnaround', value: '2.4d', change: '-0.7d' },
]

const quoteRows = [
  { id: 'QT-2026-0013', customer: 'Capri Foods', total: 'KSh 28,000', status: 'Viewed' },
  { id: 'QT-2026-0012', customer: 'Boma Studio', total: 'KSh 16,500', status: 'Draft' },
  { id: 'QT-2026-0011', customer: 'Kilimani Traders', total: 'KSh 42,400', status: 'Approved' },
]

const actions = ['Add customer', 'Create quote', 'Upload logo', 'Review settings']

function App() {
  const publicMatch = window.location.pathname.match(/^\/quote\/([^/]+)\/?$/)
  const [mode, setMode] = useState<Mode>('login')
  const [user, setUser] = useState<User | null>(null)
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null)
  const [activeSection, setActiveSection] = useState<Section>('dashboard')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [businessSaving, setBusinessSaving] = useState(false)
  const [error, setError] = useState('')
  const [businessError, setBusinessError] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerDraft, setCustomerDraft] = useState<Customer>({
    id: '',
    name: '',
    phone: '',
    email: '',
  })
  const [customerFormOpen, setCustomerFormOpen] = useState(false)
  const [customerError, setCustomerError] = useState('')
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
  })
  const [businessForm, setBusinessForm] = useState({
    name: '',
    email: '',
    phone: '',
    country: 'Kenya',
    businessType: '',
    currency: 'KES',
    defaultTaxRate: '16',
    quotePrefix: 'QT',
  })

  // Global session expiry handler — clears user state when the API returns 401
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
      setBusinessProfile(null)
      setError('Your session has expired. Please sign in again.')
    })
    return () => setSessionExpiredHandler(null)
  }, [])

  const loadCustomers = async () => {
    try {
      const response = await apiRequest<{ customers?: Customer[] }>('/api/customers')
      setCustomers(response.customers ?? [])
    } catch {
      setCustomers([])
    }
  }

  const loadBusinessProfile = async () => {
    try {
      const response = await apiRequest<{ organisation?: BusinessProfile | null }>(
        '/api/business/me',
      )
      const nextProfile = response.organisation ?? null
      setBusinessProfile(nextProfile)

      if (nextProfile) {
        setBusinessForm({
          name: nextProfile.name ?? '',
          email: nextProfile.email ?? '',
          phone: nextProfile.phone ?? '',
          country: nextProfile.country ?? 'Kenya',
          businessType: nextProfile.businessType ?? '',
          currency: nextProfile.currency ?? 'KES',
          defaultTaxRate: nextProfile.defaultTaxRate == null ? '16' : String(nextProfile.defaultTaxRate),
          quotePrefix: nextProfile.quotePrefix ?? 'QT',
        })
      }
    } catch {
      setBusinessProfile(null)
    }
  }

  useEffect(() => {
    if (publicMatch) {
      setLoading(false)
      return
    }

    const loadSession = async () => {
      try {
        const response = await apiRequest<{ user?: User }>('/api/auth/me')
        const nextUser = response.user ?? null
        setUser(nextUser)

        if (nextUser) {
          await loadBusinessProfile()
          await loadCustomers()
        } else {
          setBusinessProfile(null)
          setCustomers([])
        }
      } catch {
        setUser(null)
        setBusinessProfile(null)
        setCustomers([])
      } finally {
        setLoading(false)
      }
    }

    void loadSession()
  }, [])

  const handleChange = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const handleBusinessChange = (field: keyof typeof businessForm, value: string) => {
    setBusinessForm((current) => ({ ...current, [field]: value }))
  }

  const filteredCustomers = useMemo(
    () =>
      customers.filter(({ name, phone, email }) => {
        const query = customerSearch.trim().toLowerCase()
        if (!query) return true

        return [name, phone, email].some((value) => value.toLowerCase().includes(query))
      }),
    [customerSearch, customers],
  )

  const openCustomerEditor = (customer?: Customer) => {
    setCustomerDraft(
      customer ?? {
        id: '',
        name: '',
        phone: '',
        email: '',
      },
    )
    setCustomerError('')
    setCustomerFormOpen(true)
  }

  const handleCustomerSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const name = customerDraft.name.trim()
    const phone = customerDraft.phone.trim()
    const email = customerDraft.email.trim().toLowerCase()

    if (!name || (!phone && !email)) {
      setCustomerError('Customer name and at least one contact method are required.')
      return
    }

    const nextCustomer: Customer = {
      id: customerDraft.id || `customer-${Date.now()}`,
      name,
      phone,
      email,
    }

    try {
      const isUpdate = Boolean(customerDraft.id)
      const response = await apiRequest<{ customer: Customer }>(
        isUpdate ? `/api/customers/${nextCustomer.id}` : '/api/customers',
        {
          method: isUpdate ? 'PUT' : 'POST',
          body: JSON.stringify({ name, phone, email }),
        },
      )

      const savedCustomer = response.customer
      setCustomers((current) => {
        const matches = current.some((customer) => customer.id === savedCustomer.id)
        if (matches) {
          return current.map((customer) => (customer.id === savedCustomer.id ? savedCustomer : customer))
        }

        return [savedCustomer, ...current]
      })
    } catch {
      setCustomers((current) => {
        const matches = current.some((customer) => customer.id === nextCustomer.id)
        if (matches) {
          return current.map((customer) => (customer.id === nextCustomer.id ? nextCustomer : customer))
        }

        return [nextCustomer, ...current]
      })
    }

    setCustomerDraft({ id: '', name: '', phone: '', email: '' })
    setCustomerFormOpen(false)
    setCustomerError('')
  }

  const handleCustomerDelete = async (customerId: string) => {
    try {
      await apiRequest(`/api/customers/${customerId}`, { method: 'DELETE' })
    } catch {
      // Keep the UI resilient when the API is temporarily unavailable.
    }

    setCustomers((current) => current.filter((customer) => customer.id !== customerId))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')

    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login'
      const payload =
        mode === 'register'
          ? { name: form.name, email: form.email, password: form.password }
          : { email: form.email, password: form.password }

      const response = await apiRequest<{ user: User }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      setUser(response.user)
      await loadBusinessProfile()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to continue.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleBusinessSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusinessSaving(true)
    setBusinessError('')

    try {
      const payload = {
        ...businessForm,
        defaultTaxRate: businessForm.defaultTaxRate || null,
      }

      const response = await apiRequest<{ organisation: BusinessProfile }>('/api/business/setup', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      setBusinessProfile(response.organisation)
      setBusinessForm({
        name: response.organisation.name ?? '',
        email: response.organisation.email ?? '',
        phone: response.organisation.phone ?? '',
        country: response.organisation.country ?? 'Kenya',
        businessType: response.organisation.businessType ?? '',
        currency: response.organisation.currency ?? 'KES',
        defaultTaxRate: response.organisation.defaultTaxRate == null ? '16' : String(response.organisation.defaultTaxRate),
        quotePrefix: response.organisation.quotePrefix ?? 'QT',
      })
    } catch (requestError) {
      setBusinessError(requestError instanceof Error ? requestError.message : 'Unable to save your business profile.')
    } finally {
      setBusinessSaving(false)
    }
  }

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore logout request issues and clear the UI. This keeps the flow resilient.
    } finally {
      setUser(null)
      setBusinessProfile(null)
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

  if (!businessProfile) {
    return (
      <div className="page-shell">
        <section className="marketing-shell">
          <header className="public-header">
            <div className="brand" aria-label="iQuote home">
              <span className="brand-mark">iQ</span>
              <span>iQuote</span>
            </div>

            <nav className="public-nav" aria-label="Main navigation">
              <a href="#features">Features</a>
              <a href="#pricing">Pricing</a>
              <a href="#customers">Customers</a>
            </nav>

            <button type="button" className="secondary-button" onClick={() => setMode('login')}>
              Sign in
            </button>
          </header>

          <main className="marketing-main">
            <div className="marketing-copy">
              <p className="eyebrow">Simple quotes. Faster approvals.</p>
              <h1>Send polished quotes in minutes.</h1>
              <p className="lede">
                Build a clean quote, share a public link, and track decision status without
                extra admin overhead.
              </p>

              <div className="cta-row">
                <button type="button" className="primary-button" onClick={() => setMode('register')}>
                  Start free
                </button>
                <button type="button" className="secondary-button" onClick={() => setMode('login')}>
                  See demo
                </button>
              </div>

              <ul className="mini-list" aria-label="Key platform benefits">
                <li>Single organisation dashboard</li>
                <li>Quote PDF and public link</li>
                <li>Approval tracking built in</li>
              </ul>
            </div>

            <form className="auth-card" onSubmit={handleSubmit}>
              <div className="auth-header">
                <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
                >
                  {mode === 'login' ? 'New here? Create account' : 'Already have an account? Sign in'}
                </button>
              </div>

              {mode === 'register' && (
                <label>
                  Full name
                  <input
                    type="text"
                    value={form.name}
                    onChange={(event) => handleChange('name', event.target.value)}
                    placeholder="Asha Njeri"
                  />
                </label>
              )}

              <label>
                Work email
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => handleChange('email', event.target.value)}
                  placeholder="hello@kampala.studio"
                />
              </label>

              <label>
                Password
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => handleChange('password', event.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>

              {error && <p className="form-error">{error}</p>}

              <button type="submit" className="primary-button full-width" disabled={submitting}>
                {submitting ? 'Please wait…' : mode === 'login' ? 'Continue' : 'Create account'}
              </button>
            </form>
          </main>
        </section>
      </div>
    )
  }

  if (!businessProfile) {
    return (
      <div className="page-shell">
        <section className="workspace-shell" aria-label="Business onboarding preview">
          <aside className="sidebar">
            <div className="brand brand-inline" aria-label="iQuote workspace">
              <span className="brand-mark">iQ</span>
              <span>iQuote</span>
            </div>

            <nav className="sidebar-nav" aria-label="Sidebar navigation">
              <button type="button" className="nav-item active">
                Setup
              </button>
            </nav>
          </aside>

          <div className="main-panel">
            <header className="topbar">
              <div>
                <p className="eyebrow">Business profile</p>
                <h2>Set up your organisation</h2>
              </div>

              <div className="topbar-actions">
                <button type="button" className="secondary-button small-button" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            </header>

            <main className="dashboard-main onboarding-main">
              <section className="onboarding-panel">
                <p className="eyebrow">Required before quotes</p>
                <h3>Tell us who you are selling for.</h3>

                <form className="business-form" onSubmit={handleBusinessSubmit}>
                  <div className="form-grid">
                    <label>
                      Business name
                      <input
                        type="text"
                        value={businessForm.name}
                        onChange={(event) => handleBusinessChange('name', event.target.value)}
                        placeholder="Luna Creative Studio"
                      />
                    </label>

                    <label>
                      Business email
                      <input
                        type="email"
                        value={businessForm.email}
                        onChange={(event) => handleBusinessChange('email', event.target.value)}
                        placeholder="hello@lunacreative.co"
                      />
                    </label>

                    <label>
                      Phone
                      <input
                        type="tel"
                        value={businessForm.phone}
                        onChange={(event) => handleBusinessChange('phone', event.target.value)}
                        placeholder="+254 712 345 678"
                      />
                    </label>

                    <label>
                      Country
                      <input
                        type="text"
                        value={businessForm.country}
                        onChange={(event) => handleBusinessChange('country', event.target.value)}
                        placeholder="Kenya"
                      />
                    </label>

                    <label>
                      Business type
                      <select
                        value={businessForm.businessType}
                        onChange={(event) => handleBusinessChange('businessType', event.target.value)}
                      >
                        <option value="">General service business</option>
                        <option>Handyman / home repair</option>
                        <option>Plumbing</option>
                        <option>Electrical</option>
                        <option>Cleaning &amp; maintenance</option>
                        <option>Construction &amp; contracting</option>
                        <option>Consulting &amp; professional services</option>
                        <option>Creative studio</option>
                        <option>Retail &amp; product sales</option>
                        <option>Other service business</option>
                      </select>
                    </label>

                    <label>
                      Currency
                      <input
                        type="text"
                        value={businessForm.currency}
                        onChange={(event) => handleBusinessChange('currency', event.target.value)}
                        placeholder="KES"
                      />
                    </label>

                    <label>
                      Default tax rate (%)
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={businessForm.defaultTaxRate}
                        onChange={(event) => handleBusinessChange('defaultTaxRate', event.target.value)}
                      />
                    </label>

                    <label className="full-span">
                      Quote prefix
                      <input
                        type="text"
                        value={businessForm.quotePrefix}
                        onChange={(event) => handleBusinessChange('quotePrefix', event.target.value)}
                        placeholder="QT"
                      />
                    </label>
                  </div>

                  {businessError && <p className="form-error">{businessError}</p>}

                  <div className="form-actions">
                    <button type="submit" className="primary-button" disabled={businessSaving}>
                      {businessSaving ? 'Saving…' : 'Save business profile'}
                    </button>
                  </div>
                </form>
              </section>
            </main>
          </div>
        </section>
      </div>
    )
  }

  return <QuoteWorkspace user={user} onLogout={handleLogout} />

  return (
    <div className="page-shell">
      <section className="workspace-shell" aria-label="Dashboard preview">
        <aside className="sidebar">
          <div className="brand brand-inline" aria-label="iQuote workspace">
            <span className="brand-mark">iQ</span>
            <span>iQuote</span>
          </div>

          <nav className="sidebar-nav" aria-label="Sidebar navigation">
            <button
              type="button"
              className={`nav-item ${activeSection === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveSection('dashboard')}
            >
              Dashboard
            </button>
            <button type="button" className="nav-item">
              Quotes
            </button>
            <button
              type="button"
              className={`nav-item ${activeSection === 'customers' ? 'active' : ''}`}
              onClick={() => setActiveSection('customers')}
            >
              Customers
            </button>
            <button type="button" className="nav-item">
              Settings
            </button>
          </nav>
        </aside>

        <div className="main-panel">
          {activeSection === 'customers' ? (
            <>
              <header className="topbar">
                <div>
                  <p className="eyebrow">CRM</p>
                  <h2>Customers</h2>
                </div>

                <div className="topbar-actions">
                  <button
                    type="button"
                    className="primary-button small-button"
                    onClick={() => openCustomerEditor()}
                  >
                    Add customer
                  </button>
                  <button type="button" className="secondary-button small-button" onClick={handleLogout}>
                    Logout
                  </button>
                </div>
              </header>

              <main className="dashboard-main">
                <section className="panel customer-panel">
                  <div className="panel-header customer-header">
                    <h3>Customer directory</h3>
                    <button type="button" className="text-button" onClick={() => openCustomerEditor()}>
                      New customer
                    </button>
                  </div>

                  <div className="customer-tools">
                    <input
                      className="search-input"
                      type="search"
                      value={customerSearch}
                      onChange={(event) => setCustomerSearch(event.target.value)}
                      placeholder="Search customers"
                    />
                    <button type="button" className="primary-button small-button" onClick={() => openCustomerEditor()}>
                      Add customer
                    </button>
                  </div>

                  {customerFormOpen && (
                    <form className="customer-form" onSubmit={handleCustomerSubmit}>
                      <div className="form-grid customer-grid">
                        <label>
                          Name
                          <input
                            type="text"
                            value={customerDraft.name}
                            onChange={(event) =>
                              setCustomerDraft((current) => ({ ...current, name: event.target.value }))
                            }
                            placeholder="Nairobi Print House"
                          />
                        </label>

                        <label>
                          Phone
                          <input
                            type="tel"
                            value={customerDraft.phone}
                            onChange={(event) =>
                              setCustomerDraft((current) => ({ ...current, phone: event.target.value }))
                            }
                            placeholder="+254 712 345 000"
                          />
                        </label>

                        <label className="full-span">
                          Email
                          <input
                            type="email"
                            value={customerDraft.email}
                            onChange={(event) =>
                              setCustomerDraft((current) => ({ ...current, email: event.target.value }))
                            }
                            placeholder="hello@nairobiprint.co"
                          />
                        </label>
                      </div>

                      {customerError && <p className="form-error">{customerError}</p>}

                      <div className="form-actions customer-actions">
                        <button type="submit" className="primary-button">
                          {customerDraft.id ? 'Save changes' : 'Add customer'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setCustomerFormOpen(false)
                            setCustomerError('')
                            setCustomerDraft({ id: '', name: '', phone: '', email: '' })
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}

                  {filteredCustomers.length === 0 ? (
                    <div className="empty-state">
                      <h4>No customers yet</h4>
                      <p>Add your first customer to start creating quotes faster.</p>
                      <button type="button" className="primary-button" onClick={() => openCustomerEditor()}>
                        Create customer
                      </button>
                    </div>
                  ) : (
                    <table className="customer-table">
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Phone</th>
                          <th>Email</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredCustomers.map((customer) => (
                          <tr key={customer.id}>
                            <td>{customer.name}</td>
                            <td>{customer.phone || '—'}</td>
                            <td>{customer.email || '—'}</td>
                            <td>
                              <div className="table-actions">
                                <button type="button" className="text-button" onClick={() => openCustomerEditor(customer)}>
                                  Edit
                                </button>
                                <button type="button" className="text-button danger-text" onClick={() => handleCustomerDelete(customer.id)}>
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </main>
            </>
          ) : (
            <>
              <header className="topbar">
                <div>
                  <p className="eyebrow">Overview</p>
                  <h2>Quote dashboard</h2>
                </div>

                <div className="topbar-actions">
                  {businessProfile!.subscription && <span className="subscription-chip">{businessProfile!.subscription?.plan} · trial ends {new Date(businessProfile!.subscription?.trialEndsAt ?? '').toLocaleDateString()}</span>}
                  <span className="status-badge">Saved</span>
                  <button type="button" className="primary-button small-button">
                    New quote
                  </button>
                  <button type="button" className="secondary-button small-button" onClick={handleLogout}>
                    Logout
                  </button>
                </div>
              </header>

              <main className="dashboard-main">
                <section className="hero-panel">
                  <div>
                    <p className="eyebrow">Welcome</p>
                    <h3>{user!.name}</h3>
                  </div>
                  <span className="trend-tag">{businessProfile!.name}</span>
                </section>

                <section className="stats-grid" aria-label="Sales stats">
                  {stats.map((stat) => (
                    <article key={stat.label} className="stat-card">
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                      <small>{stat.change}</small>
                    </article>
                  ))}
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header">
                      <h3>Recent quotes</h3>
                      <button type="button" className="text-button">
                        View all
                      </button>
                    </div>

                    <table>
                      <thead>
                        <tr>
                          <th>Quote</th>
                          <th>Customer</th>
                          <th>Total</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quoteRows.map((row) => (
                          <tr key={row.id}>
                            <td>{row.id}</td>
                            <td>{row.customer}</td>
                            <td>{row.total}</td>
                            <td>
                              <span className="status-pill">{row.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </article>

                  <article className="panel">
                    <div className="panel-header">
                      <h3>Quick actions</h3>
                    </div>

                    <ul className="action-list">
                      {actions.map((action) => (
                        <li key={action}>
                          <button type="button" className="action-item">
                            {action}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </article>
                </section>
              </main>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
