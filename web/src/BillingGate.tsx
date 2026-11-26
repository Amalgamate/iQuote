import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest, formatMoney } from './api'
import './BillingGate.css'

type BillingPlan = { plan: string; amount: number | null; currency: string }
type BillingSummary = {
  plan: string
  status: string
  trialEndsAt: string | null
  currentPeriodEndsAt: string | null
  providerConfigured: boolean
  pricesConfigured: boolean
  plans: BillingPlan[]
  latestPayment: BillingPayment | null
}
type BillingPayment = { id: string; status: string; statusDescription: string | null; amount: number; currency: string }

export default function BillingGate({ isOwner, onUnlocked, onLogout, onBack, reason = 'expired' }: { isOwner: boolean; onUnlocked: () => void; onLogout: () => void; onBack?: () => void; reason?: 'expired' | 'manage' | 'trial-cap' }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [plan, setPlan] = useState('STARTER')
  const [phone, setPhone] = useState('')
  const [payment, setPayment] = useState<BillingPayment | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void apiRequest<BillingSummary>('/api/billing/status').then((result) => {
      if (!active) return
      setSummary(result)
      setPlan(result.plan || 'STARTER')
      if (result.latestPayment?.status === 'PENDING') setPayment(result.latestPayment)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load subscription details.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!payment || payment.status !== 'PENDING') return
    let active = true
    const timer = window.setInterval(() => {
      void apiRequest<{ payment: BillingPayment }>(`/api/billing/payments/${encodeURIComponent(payment.id)}`).then((result) => {
        if (!active) return
        setPayment(result.payment)
        if (result.payment.status === 'PAID') onUnlocked()
      }).catch(() => undefined)
    }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [payment?.id, payment?.status, onUnlocked])

  const startPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSending(true)
    setError('')
    setPayment(null)
    try {
      const result = await apiRequest<{ payment: BillingPayment }>('/api/billing/stk', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ plan, phone }),
      })
      setPayment(result.payment)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start the M-Pesa request.')
    } finally {
      setSending(false)
    }
  }

  const selected = summary?.plans.find((item) => item.plan === plan)
  if (loading) return <main className="billing-gate"><div className="billing-card">Loading subscription…</div></main>

  return <main className="billing-gate">
    <section className="billing-card">
      <div className="billing-brand"><span className="billing-mark">iQ<span>.</span></span><b>i<span className="billing-brand-q">Q</span>uote<span className="billing-brand-dot">.</span></b></div>
      <p className="billing-eyebrow">{reason === 'expired' ? 'SUBSCRIPTION REQUIRED' : 'ACCOUNT & BILLING'}</p>
      <h1>{reason === 'expired' ? 'Your trial has ended' : reason === 'trial-cap' ? 'Choose a plan to keep creating' : 'Plans & billing'}</h1>
      <p className="billing-intro">{reason === 'expired' ? 'Choose a plan and complete a secure M-Pesa payment to reopen your workspace. Your customer and quotation data remain saved.' : reason === 'trial-cap' ? 'Your trial document allowance is used. Choose a package and pay securely with M-Pesa to continue creating quotes and invoices.' : 'Review your packages and manage subscription payments for this workspace.'}</p>

      {summary && <div className="billing-summary">
        <div><span>Current plan</span><strong>{summary.plan}</strong></div>
        <div><span>{summary.status === 'TRIALING' ? 'Trial ends' : 'Subscription status'}</span><strong>{summary.status === 'TRIALING' && summary.trialEndsAt ? new Date(summary.trialEndsAt).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : summary.status}</strong></div>
      </div>}

      {isOwner ? <form onSubmit={(event) => void startPayment(event)} className="billing-form">
        <fieldset className="billing-plans" disabled={!summary?.providerConfigured || !summary?.pricesConfigured || sending || payment?.status === 'PENDING'}>
          <legend>Select a monthly plan</legend>
          {summary?.plans.map((item) => <label className={`billing-plan ${plan === item.plan ? 'selected' : ''}`} key={item.plan}>
            <input type="radio" name="plan" value={item.plan} checked={plan === item.plan} disabled={item.amount === null} onChange={() => setPlan(item.plan)} />
            <span>{item.plan.charAt(0) + item.plan.slice(1).toLowerCase()}</span>
            <strong>{item.amount === null ? 'Price not set' : `${formatMoney(item.amount, item.currency)} / month`}</strong>
          </label>)}
        </fieldset>
        <label className="billing-phone">Safaricom number
          <input type="tel" required autoComplete="tel" inputMode="tel" placeholder="0712 345 678" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <button className="billing-submit" disabled={!summary?.providerConfigured || !summary?.pricesConfigured || !selected?.amount || sending || payment?.status === 'PENDING'}>
          {sending ? 'Sending payment request…' : selected?.amount ? `Pay ${formatMoney(selected.amount, selected.currency)} with M-Pesa` : 'Payment setup is incomplete'}
        </button>
        {!summary?.providerConfigured && <p className="billing-note">NCBA merchant credentials are not configured yet. Contact iQuote support to complete setup.</p>}
        {summary?.providerConfigured && !summary.pricesConfigured && <p className="billing-note">Plan prices are not configured yet. Contact iQuote support to complete setup.</p>}
      </form> : <div className="billing-owner-note">Only the workspace owner can renew the subscription. Ask the owner to sign in and complete payment.</div>}

      {payment && <div className={`billing-payment-state ${payment.status.toLowerCase()}`} role="status">
        <strong>{payment.status === 'PAID' ? 'Payment confirmed' : payment.status === 'FAILED' ? 'Payment not completed' : 'Approve the payment on your phone'}</strong>
        <span>{payment.statusDescription || 'We are checking the payment status with NCBA.'}</span>
        {payment.status === 'PAID' && <button type="button" onClick={onUnlocked} className="billing-reopen">Open workspace</button>}
      </div>}
      {error && <p className="billing-error" role="alert">{error}</p>}
      <div className="billing-footer"><span>Payments are processed securely by NCBA.</span><div>{onBack && <button type="button" onClick={onBack}>Back to workspace</button>}<button type="button" onClick={onLogout}>Sign out</button></div></div>
    </section>
  </main>
}
