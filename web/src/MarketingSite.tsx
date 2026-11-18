import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'
import './MarketingSite.css'
import ChatbotWidget from './ChatbotWidget'
import heroMockup from './assets/hero-mockup.jpg'
import featConsidered from './assets/feat-considered.jpg'
import featLink from './assets/feat-link.jpg'
import featTracking from './assets/feat-tracking.jpg'
import personaStudio from './assets/persona-studio.jpg'
import personaTrades from './assets/persona-trades.jpg'

// Real face photos via Unsplash CDN (royalty-free)
const FACES = {
  amina:     'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=120&h=120&fit=crop&crop=face&auto=format',
  david:     'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=120&fit=crop&crop=face&auto=format',
  siti:      'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&h=120&fit=crop&crop=face&auto=format',
  badgeAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&h=80&fit=crop&crop=face&auto=format',
  editorialDesk: 'https://images.unsplash.com/photo-1664575262619-b28fef7a40a4?w=1200&h=700&fit=crop&auto=format',
  personaConsultant: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=120&h=120&fit=crop&crop=face&auto=format',
}

const testimonials = [
  {
    quote: "Before iQuote I was sending PDFs that clients couldn't even open on their phones. Now they approve on the same day — sometimes within the hour.",
    name: "Amina Waweru",
    role: "Creative Director, North Studio · Nairobi",
    avatar: FACES.amina,
  },
  {
    quote: "I do electrical installs and my quotes used to be a WhatsApp message. Now I look like a proper business. Clients take me seriously and I win more jobs.",
    name: "David Otieno",
    role: "Independent Electrician · Mombasa",
    avatar: FACES.david,
  },
  {
    quote: "The one-link share is a game changer. No back-and-forth, no attachments. The client just clicks, reads, and approves. It's exactly what I needed.",
    name: "Siti Mwangi",
    role: "Strategy Consultant · Kampala",
    avatar: FACES.siti,
  },
]

type Step = 1 | 2 | 3 | 4 | 5
type Plan = 'STARTER' | 'GROWTH' | 'TEAM'

const planCards: Array<{ id: Plan; name: string; detail: string; features: string[] }> = [
  { id: 'STARTER', name: 'Starter', detail: 'For independent businesses', features: ['Send and track quotes', 'Customer directory', 'One business workspace'] },
  { id: 'GROWTH', name: 'Growth', detail: 'For a growing sales desk', features: ['Everything in Starter', 'Higher quote volume (planned)', 'Follow-up activity (planned)'] },
  { id: 'TEAM', name: 'Team', detail: 'For a team quoting together', features: ['Everything in Growth', 'Team members (coming soon)', 'Role controls (coming soon)'] },
]

export default function MarketingSite() {
  const [screen, setScreen] = useState<'landing' | 'signup' | 'login' | 'market'>(() => window.location.pathname === '/market' ? 'market' : 'landing')
  const [step, setStep] = useState<Step>(1)
  const [resendWait, setResendWait] = useState(0)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [localCode, setLocalCode] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [country, setCountry] = useState('Kenya')
  const [phone, setPhone] = useState('')
  const [plan, setPlan] = useState<Plan>('GROWTH')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [stageView, setStageView] = useState<'paper' | 'mockup'>('paper')
  const [quoteApproved, setQuoteApproved] = useState(false)

  useEffect(() => {
    if (resendWait <= 0) return
    const timer = window.setTimeout(() => setResendWait((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resendWait])

  useEffect(() => {
    const selector = '.site-page .site-hero, .site-page .site-intro, .site-page .site-testimonials, .site-page .site-features, .site-page .site-market, .site-page .site-steps, .site-page .site-plans, .site-page .site-final-cta, .site-page .site-footer, .site-page .market-page-hero, .site-page .market-opportunity-board'
    const reset = () => document.querySelectorAll<HTMLElement>(selector).forEach((section) => {
      section.style.removeProperty('--pointer-x')
      section.style.removeProperty('--pointer-y')
    })
    const trackPointer = (event: PointerEvent) => {
      const section = (event.target as Element | null)?.closest<HTMLElement>(selector)
      if (!section) return
      const bounds = section.getBoundingClientRect()
      section.style.setProperty('--pointer-x', String((event.clientX - bounds.left) / bounds.width - 0.5))
      section.style.setProperty('--pointer-y', String((event.clientY - bounds.top) / bounds.height - 0.5))
    }
    document.addEventListener('pointermove', trackPointer, { passive: true })
    document.addEventListener('pointerleave', reset)
    return () => {
      document.removeEventListener('pointermove', trackPointer)
      document.removeEventListener('pointerleave', reset)
      reset()
    }
  }, [])

  const startSignup = () => {
    setError('')
    setNotice('')
    setScreen('signup')
    setStep(1)
    setCode('')
    setLocalCode('')
    setResendWait(0)
    setName('')
    setEmail('')
    setPassword('')
    setBusinessName('')
    setBusinessType('')
    setCountry('Kenya')
    setPhone('')
    setPlan('GROWTH')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const requestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (step === 2 && resendWait > 0) {
      setError(`You can request another code in ${resendWait} seconds.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ delivery: string; devCode?: string }>('/api/auth/verification/send', {
        method: 'POST', body: JSON.stringify({ email }),
      })
      setLocalCode(response.devCode ?? '')
      setResendWait(30)
      setStep(2)
      setNotice(response.delivery === 'sent' ? 'A verification code is on its way to your inbox.' : 'Local simulation: use the code shown below to continue.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'We could not send a verification code.')
    } finally { setBusy(false) }
  }

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/auth/verification/verify', { method: 'POST', body: JSON.stringify({ email, code }) })
      setStep(3)
      setNotice('Email verified. Now tell us a little about your business.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'We could not verify that code.')
    } finally { setBusy(false) }
  }

  const completeSignup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ welcomeEmailSent: boolean }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, businessName, businessType, country, phone, plan }),
      })
      setStep(5)
      setNotice(response.welcomeEmailSent ? 'Your welcome and getting started email has been sent.' : 'Your workspace was created in local simulation mode. Email delivery is ready to activate with Resend.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'We could not create your workspace.')
    } finally { setBusy(false) }
  }

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: loginEmail, password: loginPassword }) })
      window.location.reload()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to sign in.')
      setBusy(false)
    }
  }

  if (screen === 'market') return <MarketLanding />

  if (screen === 'landing') {
    return <div className="site-page">
      <header className="site-header">
        <a href="#top" className="site-brand" aria-label="iQuote home"><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></a>
        <nav className="site-nav"><a href="#how">How it works</a><a href="#features">Features</a><a href="/market">Market <span className="market-nav-badge">Preview</span></a><a href="#plans">Plans</a></nav>
        <div className="site-header-actions"><button className="site-login" onClick={() => { setScreen('login'); setError('') }}>Sign in</button><button className="site-cta site-cta-small" onClick={startSignup}>Start your trial <span>↗</span></button></div>
      </header>
      <main id="top">
        <section className="site-hero">
          <div className="hero-copy">
            <p className="site-kicker"><span className="kicker-rule" /> QUOTING, WITH ROOM TO GROW</p>
            <h1>Good work deserves a <em>clear</em> quote.</h1>
            <p className="hero-lede">Create thoughtful quotes, share them in one link, and know exactly when a customer is ready to move forward.</p>
            <div className="hero-actions"><button className="site-cta" onClick={startSignup}>Create your workspace <span>↗</span></button><a className="hero-secondary" href="#how">See how it works <span>↓</span></a></div>
            <div className="hero-reassurance"><span className="reassurance-icon">✓</span><span>14 days to explore · no card details · no charge in this preview</span></div>
          </div>
          <div className="quote-stage" aria-label="Quote document preview">
            <div className="stage-controls">
              <button 
                type="button" 
                className={stageView === 'paper' ? 'stage-toggle active' : 'stage-toggle'} 
                onClick={() => setStageView('paper')}
              >
                📄 Interactive Quote
              </button>
              <button 
                type="button" 
                className={stageView === 'mockup' ? 'stage-toggle active' : 'stage-toggle'} 
                onClick={() => setStageView('mockup')}
              >
                ✨ 3D Device View
              </button>
            </div>

            {/* Floating WhatsApp-Style Badges */}
            <div className="floating-badge badge-top">
              <img src={FACES.badgeAvatar} alt="Amina" className="badge-face-avatar" />
              <div className="badge-content">
                <b>{quoteApproved ? 'Accepted & Signed!' : 'Quote Approved!'}</b>
                <small>Amina W. · Horizon House · 2m ago</small>
              </div>
              <span className="badge-tick">✓</span>
            </div>

            <div className="floating-badge badge-bottom">
              <span className="badge-avatar">💳</span>
              <div className="badge-content">
                <b>KSh 181,440</b>
                <small>Ready to invoice</small>
              </div>
              <span className="badge-tag">Paid</span>
            </div>

            <div className="floating-badge badge-side">
              <span className="radar-ping-dot"><span className="radar-ping-ring" /></span>
              <span>Client viewing now</span>
            </div>

            {stageView === 'mockup' ? (
              <div className="hero-mockup-frame">
                <img src={heroMockup} alt="iQuote 3D preview on tablet" className="hero-mockup-img" />
              </div>
            ) : (
              <article className="quote-paper">
                <div className="paper-top"><span className="paper-logo">NORTH<span> / </span>STUDIO</span><span className="paper-label">QUOTATION<br /><b>QT-2026-0048</b></span></div>
                <div className="paper-rule" />
                <div className="paper-meta"><div><small>PREPARED FOR</small><b>Horizon House</b><span>Westlands, Nairobi</span></div><div><small>VALID UNTIL</small><b>18 Dec 2026</b><span>Prepared 18 Nov 2026</span></div></div>
                <div className="paper-title"><small>PROJECT</small><h2>Brand identity<br />& launch kit</h2></div>
                <div className="paper-table"><div className="paper-table-head"><span>DESCRIPTION</span><span>AMOUNT</span></div><div><span>Brand strategy & direction</span><b>KSh 48,000</b></div><div><span>Visual identity system</span><b>KSh 72,000</b></div><div><span>Launch assets & guidelines</span><b>KSh 36,000</b></div></div>
                <div className="paper-total"><span>Total <small>incl. VAT</small></span><b>KSh 181,440</b></div>
                <div className="paper-sign">
                  <span>{quoteApproved ? '✓ Approved by customer on 18 Nov 2026' : 'One link to review, approve, and get started.'}</span>
                  <button 
                    type="button" 
                    className={quoteApproved ? 'approved-button' : ''}
                    onClick={() => setQuoteApproved(!quoteApproved)}
                  >
                    {quoteApproved ? 'Approved ✓' : 'Review quote ↗'}
                  </button>
                </div>
              </article>
            )}

            <div className="stage-note"><span>01</span><span>From first draft<br />to clear next step.</span></div>
          </div>
          <div className="hero-bottom">
            <span>MADE FOR INDEPENDENT TEAMS</span>
            <div className="hero-personas">
              <div className="persona-chip">
                <img src={personaStudio} alt="Creative Studios" className="persona-chip-img" />
                <span>Studios</span>
              </div>
              <i />
              <div className="persona-chip">
                <img src={personaTrades} alt="Trades & Contractors" className="persona-chip-img" />
                <span>Trades &amp; Contracting</span>
              </div>
              <i />
              <div className="persona-chip">
                <img src={FACES.personaConsultant} alt="Consultants" className="persona-chip-img" />
                <span>Consultants</span>
              </div>
              <i />
              <span>Growing businesses</span>
            </div>
          </div>
        </section>
        <section className="site-intro" id="how">
          <div className="intro-copy">
            <p className="site-kicker">THE WHOLE CONVERSATION, IN ONE PLACE</p>
            <h2>From “how much?”<br />to <em>“let’s do it.”</em></h2>
            <p>A quote should make the decision easier for your customer and the follow-through easier for you. iQuote gives your work a polished home, then keeps the next step visible.</p>
            <div className="intro-stats">
              <div className="intro-stat"><span className="stat-number">3x</span><span className="stat-label">faster quote approval</span></div>
              <div className="intro-stat-divider" />
              <div className="intro-stat"><span className="stat-number">1</span><span className="stat-label">link, no attachments</span></div>
              <div className="intro-stat-divider" />
              <div className="intro-stat"><span className="stat-number">14d</span><span className="stat-label">free to explore</span></div>
            </div>
          </div>
          <div className="intro-visual">
            <div className="intro-photo-frame">
              <img src={FACES.editorialDesk} alt="Business owner reviewing a quote at her desk" className="intro-photo" />
              <div className="intro-photo-badge">
                <span className="radar-ping-dot"><span className="radar-ping-ring" /></span>
                <div><b>Quote sent</b><small>Awaiting customer review</small></div>
              </div>
            </div>
          </div>
        </section>
        <section className="site-testimonials">
          <div className="testimonials-header">
            <p className="site-kicker"><span className="kicker-rule" /> TRUSTED BY INDEPENDENT BUSINESSES</p>
            <h2>What our users are saying.</h2>
          </div>
          <div className="testimonials-grid">
            {testimonials.map((t) => (
              <article className="testimonial-card" key={t.name}>
                <div className="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
                <blockquote className="testimonial-quote">{t.quote}</blockquote>
                <div className="testimonial-person">
                  <img src={t.avatar} alt={t.name} className="testimonial-avatar" />
                  <div className="testimonial-meta"><b>{t.name}</b><small>{t.role}</small></div>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="site-features" id="features">
          <div className="feature-heading">
            <p className="site-kicker">LESS CHASING. MORE MOMENTUM.</p>
            <h2>Small details. A more confident sale.</h2>
          </div>
          <div className="feature-grid">
            <article className="feature-card">
              <div className="feature-image-container">
                <img src={featConsidered} alt="Quotes that feel considered" className="feature-img" />
                <span className="feature-card-tag">Polished</span>
              </div>
              <span className="feature-number">01</span>
              <h3>Quotes that feel considered</h3>
              <p>Present scope, line items, tax, terms, and your brand in a clean document customers can understand.</p>
              <a href="#plans">Explore the workspace <span>↗</span></a>
            </article>
            <article className="feature-card">
              <div className="feature-image-container">
                <img src={featLink} alt="One clear link to share" className="feature-img" />
                <span className="feature-card-tag">1-Click</span>
              </div>
              <span className="feature-number">02</span>
              <h3>One clear link to share</h3>
              <p>Send a secure customer view. They can review the detail and respond without an account or attachment hunt.</p>
              <a href="#plans">See the customer view <span>↗</span></a>
            </article>
            <article className="feature-card">
              <div className="feature-image-container">
                <img src={featTracking} alt="Know what happens next" className="feature-img" />
                <span className="feature-card-tag">Real-Time</span>
              </div>
              <span className="feature-number">03</span>
              <h3>Know what happens next</h3>
              <p>See when a quote is opened, approved, or declined, then keep your customer list and follow-up in reach.</p>
              <a href="#plans">See quote tracking <span>↗</span></a>
            </article>
          </div>
        </section>
        <section className="site-market" id="market">
          <div className="market-heading">
            <div>
              <p className="site-kicker"><span className="kicker-rule" /> A NEW WAY TO FIND WORK</p>
              <h2>Good work should<br /><em>find its way to you.</em></h2>
            </div>
            <p className="market-intro-copy">iQuote Market is our next product direction: customers post what they need, and relevant businesses can be invited to send a proposal. Explore the idea behind iQuote Market, see how customers and providers could work together, and learn how vendor participation is planned.</p>
          </div>
          <div className="market-demo-layout">
            <article className="market-request-window" aria-label="Illustrative marketplace request">
              <div className="market-window-bar"><div className="market-window-dots"><i /><i /><i /></div><span>iQuote Market <b>CONCEPT PREVIEW</b></span><span className="market-window-lock">Private invitations</span></div>
              <div className="market-request-body">
                <div className="market-request-label"><span>NEW OPPORTUNITY</span><span className="market-sample-tag">SAMPLE REQUEST</span></div>
                <div className="market-request-title-row"><div><span className="market-category-pill">Branding &amp; print</span><h3>Branded launch kit</h3><p>A Nairobi wellness brand is preparing for a new studio opening.</p></div><div className="market-request-amount"><small>ESTIMATED BUDGET</small><b>KSh 120k–180k</b></div></div>
                <div className="market-request-details"><div><small>WHAT THEY NEED</small><b>1,000 branded T-shirts<br />3 roll-up banners</b></div><div><small>DELIVERY AREA</small><b>Westlands, Nairobi</b></div><div><small>RESPONSE BY</small><b>28 November</b></div></div>
                <div className="market-matched-row"><div className="market-avatar-stack"><span>ST</span><span>MK</span><span>+6</span></div><div><b>Invited businesses</b><small>Matched by service and delivery area</small></div><span className="market-invite-count">8 invited</span></div>
                <div className="market-request-footer"><span>Illustrative flow · not a live request</span><button type="button" disabled>Preview opportunity <span>↗</span></button></div>
              </div>
            </article>
            <aside className="market-side-note">
              <div className="market-direction-chip"><span>↗</span> PLANNED PRODUCT DIRECTION</div>
              <h3>New work can flow into the tools you already use.</h3>
              <p>A selected proposal could become a regular quote in your iQuote workspace, keeping the customer, pricing, and next steps connected.</p>
              <div className="market-flow-list">
                <div><span>01</span><div><b>Customer shares a request</b><small>Clear scope, location, timing, and budget.</small></div></div>
                <div><span>02</span><div><b>Relevant businesses are invited</b><small>Private invitations keep each proposal confidential.</small></div></div>
                <div><span>03</span><div><b>Chosen proposal moves forward</b><small>Continue the conversation in the provider workspace.</small></div></div>
              </div>
              <p className="market-status-note"><span /> Market is a concept preview. It is not available for customer or provider sign-up yet.</p><a className="market-explore-link" href="/market">Explore Market and how to join <span>↗</span></a>
            </aside>
          </div>
        </section>
        <section className="site-steps"><div className="steps-intro"><p className="site-kicker">A SHORTER WAY TO GET STARTED</p><h2>Your workspace,<br /><em>your way of working.</em></h2><p>Set up the essentials first. You can refine your profile, quote defaults, and team access as your business grows.</p><button className="site-cta" onClick={startSignup}>Start with your email <span>↗</span></button></div><div className="step-list"><div><span>01</span><section><h3>Verify your email</h3><p>Keep your account yours from the beginning. We send one short code and you can request a fresh one if needed.</p></section></div><div><span>02</span><section><h3>Add your business</h3><p>Choose a name, country, and contact number. We set a sensible starting currency for your region.</p></section></div><div><span>03</span><section><h3>Explore a trial plan</h3><p>Choose a setup for your business. Billing is simulated locally; no payment details are collected in this preview.</p></section></div></div></section>
        <section className="site-plans" id="plans"><div><p className="site-kicker">A PLAN FOR YOUR NEXT CHAPTER</p><h2>Start simple.<br /><em>Grow when ready.</em></h2><p className="plan-note">Every plan begins with a 14-day local preview. Pick the workspace shape you want to explore; billing can be connected later.</p></div><div className="plan-tiles">{planCards.map((item, index) => <article key={item.id} className={index === 1 ? 'plan-tile plan-featured' : 'plan-tile'}><div className="plan-tile-top"><span>{item.name}</span>{index === 1 && <small>GOOD PLACE TO START</small>}</div><p>{item.detail}</p><ul>{item.features.map(feature => <li key={feature}><span>✓</span>{feature}</li>)}</ul><button className={index === 1 ? 'site-cta' : 'site-plan-link'} onClick={startSignup}>Explore this plan <span>↗</span></button></article>)}</div></section>
        <section className="site-final-cta"><div><p className="site-kicker">A CALMER QUOTING DESK STARTS HERE</p><h2>Make your next quote<br />your best one yet.</h2></div><button className="site-cta site-cta-light" onClick={startSignup}>Set up iQuote <span>↗</span></button></section>
      </main>
      <footer className="site-footer"><a href="#top" className="site-brand"><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></a><span>Thoughtful quoting for growing businesses.</span><span>© iQuote · Local preview</span></footer>
      <ChatbotWidget onStartTrial={startSignup} />
    </div>
  }

  if (screen === 'login') return <div className="onboarding-page"><header className="onboarding-header"><button className="site-brand" onClick={() => setScreen('landing')}><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></button><span>New to iQuote? <button className="inline-action" onClick={startSignup}>Create an account</button></span></header><div className="onboarding-layout login-layout"><section className="onboarding-form-side"><div className="onboarding-form-wrap"><p className="site-kicker">YOUR WORKSPACE IS WAITING</p><h1>Welcome back.</h1><p className="onboarding-copy">Sign in to pick up where your business left off.</p><form onSubmit={login} className="onboarding-form"><label>Email address<input type="email" required autoComplete="email" value={loginEmail} onChange={event => setLoginEmail(event.target.value)} placeholder="you@yourbusiness.com" /></label><label>Password<input type="password" required autoComplete="current-password" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} placeholder="Your password" /></label>{error && <p className="onboarding-error">{error}</p>}<button className="site-cta onboarding-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span>↗</span></button></form></div></section><OnboardingAside /></div></div>

  const labels = ['Account', 'Verify email', 'Business', 'Plan']
  const back = () => { setError(''); setNotice(''); setStep((current) => Math.max(1, current - 1) as Step) }
  return <div className="onboarding-page"><header className="onboarding-header"><button className="site-brand" onClick={() => setScreen('landing')}><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></button><span>Already have an account? <button className="inline-action" onClick={() => { setScreen('login'); setError('') }}>Sign in</button></span></header><div className="onboarding-layout"><section className="onboarding-form-side">
    {step < 4 ? <div className="onboarding-form-wrap"><div className="step-progress" aria-label={`Step ${step} of 4`}>{labels.map((label, index) => <div key={label} className={step === index + 1 ? 'progress-item current' : step > index + 1 ? 'progress-item complete' : 'progress-item'}><span>{step > index + 1 ? '✓' : `0${index + 1}`}</span><small>{label}</small></div>)}</div>
      {step === 1 && <><p className="site-kicker">STEP 01 · YOUR ACCOUNT</p><h1>Let’s get your<br />workspace started.</h1><p className="onboarding-copy">Create your sign-in. We’ll verify your email before setting up your business.</p><form onSubmit={requestCode} className="onboarding-form"><label>Full name<input required autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Asha Njeri" /></label><label>Work email<input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@yourbusiness.com" /></label><label>Password<input required type="password" autoComplete="new-password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>{error && <p className="onboarding-error">{error}</p>}<button className="site-cta onboarding-submit" disabled={busy}>{busy ? 'Sending code…' : 'Continue with email'} <span>↗</span></button><small className="terms-note">By continuing, you agree to iQuote’s terms and privacy policy.</small></form></>}
      {step === 2 && <><p className="site-kicker">STEP 02 · EMAIL VERIFICATION</p><h1>Check your<br />inbox.</h1><p className="onboarding-copy">We sent a six-digit code to <b>{email}</b>. Enter it below to keep going.</p>{notice && <p className="onboarding-notice">{notice}</p>}{localCode && <div className="simulation-code"><span>LOCAL PREVIEW CODE</span><b>{localCode}</b></div>}<form onSubmit={verifyCode} className="onboarding-form"><label>Six-digit code<input className="code-input" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /></label>{error && <p className="onboarding-error">{error}</p>}<button className="site-cta onboarding-submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify and continue'} <span>↗</span></button><button type="button" className="resend-code" disabled={busy} onClick={() => { setError(''); void requestCode(new Event('submit') as unknown as FormEvent<HTMLFormElement>) }}>Resend code</button></form><button className="back-link" onClick={back}>← Change email address</button></>}
      {step === 3 && <><p className="site-kicker">STEP 03 · YOUR BUSINESS</p><h1>Tell us about<br />your business.</h1><p className="onboarding-copy">Choose what you do. We’ll start your workspace with relevant service categories and quote templates. You can change everything later.</p><form onSubmit={event => { event.preventDefault(); setStep(4); setError('') }} className="onboarding-form"><label>Business name<input required autoComplete="organization" value={businessName} onChange={event => setBusinessName(event.target.value)} placeholder="e.g. North Studio" /></label><label>Business type<select required value={businessType} onChange={event => setBusinessType(event.target.value)}><option value="" disabled>Choose a business type</option><option>Handyman / home repair</option><option>Plumbing</option><option>Electrical</option><option>Cleaning &amp; maintenance</option><option>Construction &amp; contracting</option><option>Consulting &amp; professional services</option><option>Creative studio</option><option>Retail &amp; product sales</option><option>Other service business</option></select></label><div className="onboarding-two"><label>Country<select value={country} onChange={event => setCountry(event.target.value)}><option>Kenya</option><option>Uganda</option><option>Tanzania</option><option>Rwanda</option><option>United States</option><option>United Kingdom</option><option>Other</option></select></label><label>Phone number <span className="optional-label">optional</span><input type="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+254 700 000 000" /></label></div>{notice && <p className="onboarding-notice">{notice}</p>}<button className="site-cta onboarding-submit">Continue to plans <span>↗</span></button></form><button className="back-link" onClick={back}>← Back</button></>}
    </div> : <div className="onboarding-form-wrap completion-wrap"><div className="completion-check">✓</div><p className="site-kicker">YOUR TRIAL WORKSPACE IS READY</p><h1>Welcome to<br />{businessName}.</h1><p className="onboarding-copy">Your <b>{planCards.find(item => item.id === plan)?.name}</b> plan is active in local preview for 14 days. No payment details were collected.</p>{notice && <p className="onboarding-notice">{notice}</p>}<div className="completion-summary"><span>Business</span><b>{businessName}</b><span>Plan</span><b>{planCards.find(item => item.id === plan)?.name} · 14-day trial</b><span>Account</span><b>{email}</b></div><button className="site-cta onboarding-submit" onClick={() => window.location.reload()}>Open your workspace <span>↗</span></button></div>}
  </section><OnboardingAside />{step === 4 && <div className="plan-picker" role="dialog" aria-label="Choose a trial plan"><div className="plan-picker-inner"><p className="site-kicker">STEP 04 · CHOOSE A TRIAL PLAN</p><h2>Choose your workspace shape.</h2><p className="plan-picker-copy">No card. No charge. This local plan selection is simulated while billing is built.</p><div className="signup-plan-list">{planCards.map(item => <button type="button" key={item.id} onClick={() => setPlan(item.id)} className={plan === item.id ? 'signup-plan selected' : 'signup-plan'}><span className="radio-dot">{plan === item.id && <i />}</span><span className="signup-plan-text"><b>{item.name}</b><small>{item.detail}</small><em>{item.features.join(' · ')}</em></span><span className="trial-pill">14-day trial</span></button>)}</div>{error && <p className="onboarding-error">{error}</p>}<div className="plan-picker-actions"><button className="back-link" onClick={back}>← Back</button><button className="site-cta" disabled={busy} onClick={event => { event.preventDefault(); void completeSignup(new Event('submit') as unknown as FormEvent<HTMLFormElement>) }}>{busy ? 'Creating workspace…' : 'Create trial workspace'} <span>↗</span></button></div></div></div>}</div></div>
}

function MarketLanding() {
  const [selectedOpportunityType, setSelectedOpportunityType] = useState<'ALL' | 'RFQ' | 'RFS' | 'RFP'>('ALL')
  const opportunityTypes = ['ALL', 'RFQ', 'RFS', 'RFP'] as const
  const opportunities = [
    { id: 'RFQ-2048', type: 'RFQ' as const, category: 'Print & promotional', title: 'Branded tote bags and aprons', scope: '500 tote bags · 120 aprons', place: 'Nairobi · Westlands', budget: 'KSh 95k–140k', closes: 'Closes in 4 days', art: 'print' },
    { id: 'RFS-1172', type: 'RFS' as const, category: 'Security & installation', title: 'CCTV setup across two offices', scope: 'Site visit · installation · handover', place: 'Mombasa · Nyali', budget: 'KSh 180k–260k', closes: 'Closes in 6 days', art: 'install' },
    { id: 'RFP-0831', type: 'RFP' as const, category: 'Creative services', title: 'Brand refresh and launch campaign', scope: 'Identity · launch assets · guidelines', place: 'Nairobi · Hybrid', budget: 'KSh 300k–500k', closes: 'Closes in 8 days', art: 'creative' },
  ]
  const visibleOpportunities = selectedOpportunityType === 'ALL' ? opportunities : opportunities.filter(item => item.type === selectedOpportunityType)

  return <div className="site-page market-page">
    <header className="site-header">
      <a href="/" className="site-brand" aria-label="iQuote home"><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></a>
      <nav className="site-nav" aria-label="Market navigation"><a href="/">Home</a><a href="#how-market">How it works</a><a href="#vendor-steps">Become a vendor</a></nav>
      <div className="site-header-actions"><span className="market-preview-label">Concept preview</span><a className="site-cta site-cta-small" href="#vendor-steps">Vendor guide <span>↓</span></a></div>
    </header>
    <main id="market-top">
      <section className="market-page-hero">
        <div className="market-page-copy">
          <p className="site-kicker"><span className="kicker-rule" /> IQUOTE MARKET · PRODUCT PREVIEW</p>
          <h1>Find work that fits <em>what you do.</em></h1>
          <p>Market is being designed to help customers describe a real need and connect with relevant businesses. Providers can learn about opportunities, send a proposal, and continue in their iQuote workspace.</p>
          <div className="market-page-actions"><a className="site-cta" href="#how-market">See how it works <span>↓</span></a><a className="market-text-link" href="#vendor-steps">How to become a vendor <span>↗</span></a></div>
          <div className="market-page-note"><span /> Market is not open for customer requests or vendor applications yet.</div>
        </div>
        <div className="market-page-card">
          <div className="market-window-bar"><div className="market-window-dots"><i /><i /><i /></div><span>Opportunity preview</span><span className="market-sample-tag">SAMPLE</span></div>
          <div className="market-request-body">
            <span className="market-category-pill">Branding &amp; print</span>
            <h2>Branded launch kit</h2>
            <p className="market-page-card-copy">A sample customer request for a new wellness studio in Nairobi.</p>
            <div className="market-request-details"><div><small>SCOPE</small><b>1,000 T-shirts<br />3 roll-up banners</b></div><div><small>AREA</small><b>Westlands</b></div><div><small>BUDGET GUIDE</small><b>KSh 120k–180k</b></div></div>
            <div className="market-matched-row"><div className="market-avatar-stack"><span>ST</span><span>MK</span><span>+6</span></div><div><b>Private provider invitations</b><small>Illustrative matching by service and area</small></div></div>
            <div className="market-page-card-foot">This is sample content for a planned marketplace flow.</div>
          </div>
        </div>
      </section>
      <section className="market-opportunity-board" id="opportunities">
        <div className="market-board-heading"><div><p className="site-kicker">A SAMPLE MARKET FEED</p><h2>Different requests.<br /><em>Real work to explore.</em></h2><p>Illustrative RFQs, service requests, and project briefs show how opportunities could appear in Market.</p></div><div className="market-feed-status"><span /> SAMPLE DATA ONLY<br /><small>No live buyer requests</small></div></div>
        <div className="market-type-filters" role="group" aria-label="Filter sample opportunities">{opportunityTypes.map(type => <button key={type} type="button" className={selectedOpportunityType === type ? 'active' : ''} onClick={() => setSelectedOpportunityType(type)}>{type === 'ALL' ? 'All requests' : type}</button>)}</div>
        <div className="market-opportunity-grid">{visibleOpportunities.map(item => <article className="market-opportunity-card" key={item.id}>
          <div className={`market-opportunity-art market-art-${item.art}`} aria-hidden="true">
            <span className="market-art-sun" />
            {item.art === 'print' && <><span className="market-art-tote" /><span className="market-art-apron" /><span className="market-art-print-roll" /><span className="market-art-plant" /></>}
            {item.art === 'install' && <><span className="market-art-building"><i /><i /><i /></span><span className="market-art-ladder" /><span className="market-art-installer"><i /></span><span className="market-art-toolbox" /></>}
            {item.art === 'creative' && <><span className="market-art-board"><i /><i /><i /><b>BRAND<br />STUDIO</b></span><span className="market-art-cup" /><span className="market-art-pencil" /></>}
            <span className="market-art-ticket">{item.type}</span>
          </div>
          <div className="market-opportunity-content"><div className="market-opportunity-meta"><span className={`market-type-badge badge-${item.type.toLowerCase()}`}>{item.type} <i>{item.type === 'RFQ' ? 'Request for quotation' : item.type === 'RFS' ? 'Request for services' : 'Request for proposal'}</i></span><span className="market-sample-id">{item.id} · SAMPLE</span></div>
            <p className="market-opportunity-category">{item.category}</p><h3>{item.title}</h3><p className="market-opportunity-scope">{item.scope}</p>
            <div className="market-opportunity-facts"><div><small>LOCATION</small><b>{item.place}</b></div><div><small>BUDGET GUIDE</small><b>{item.budget}</b></div></div>
            <div className="market-opportunity-footer"><span>◷ &nbsp;{item.closes}</span><span>Invite-only concept</span></div>
          </div>
        </article>)}</div>
        <p className="market-feed-footnote">Request types and example details are mock data for product discussion. No application, invitation, or proposal is sent from this page.</p>
      </section>
      <section className="market-audience" id="how-market">
        <div className="market-audience-heading"><p className="site-kicker">HOW IT WORKS</p><h2>One marketplace.<br /><em>Two clear paths.</em></h2><p>The pilot concept is designed to make the next step simple for both the customer asking and the business responding.</p></div>
        <div className="market-audience-cards">
          <article><span className="market-audience-icon">⌕</span><p className="market-audience-kicker">FOR CUSTOMERS</p><h3>Describe the work you need.</h3><p>Share the scope, location, timing, and budget guide. Review proposals from businesses invited for the request, then choose who to work with.</p><a href="#customer-steps">Customer journey <span>↓</span></a></article>
          <article className="vendor-card"><span className="market-audience-icon">↗</span><p className="market-audience-kicker">FOR SERVICE BUSINESSES</p><h3>Get invited to work that fits.</h3><p>Show what your business does and where you work. Review private opportunities that match, then submit a clear proposal when you’re interested.</p><a href="#vendor-steps">Vendor journey <span>↓</span></a></article>
        </div>
      </section>
      <section className="market-journeys" id="vendor-steps">
        <div className="market-journey-heading"><p className="site-kicker">HOW TO BECOME A VENDOR</p><h2>Set up your profile.<br /><em>Be ready for the right invite.</em></h2><p>When the pilot opens, joining is expected to build on an iQuote business workspace. Here’s the proposed onboarding path.</p></div>
        <div className="market-vendor-steps">
          <article><span>01</span><h3>Create your business workspace</h3><p>Register for iQuote and add your business name and contact details.</p></article>
          <article><span>02</span><h3>Tell us what you offer</h3><p>Select services, categories, delivery areas, and the kind of work you can take on.</p></article>
          <article><span>03</span><h3>Review private invitations</h3><p>See the request scope and deadline before deciding whether to respond.</p></article>
          <article><span>04</span><h3>Send a clear proposal</h3><p>Share your price, timing, and approach. If selected, continue with the customer through iQuote.</p></article>
        </div>
        <div className="market-vendor-callout"><div><span className="market-direction-chip"><span>iQ</span> PILOT ACCESS IS PLANNED</span><h3>Vendor applications are not open yet.</h3><p>We’re validating the first categories and invite model. No application is submitted from this preview; the steps above show the direction under consideration.</p></div><a className="market-back-link" href="/">Back to iQuote <span>↗</span></a></div>
      </section>
      <section className="market-customer-steps" id="customer-steps"><div><p className="site-kicker">FOR CUSTOMERS</p><h2>From a request to a confident choice.</h2></div><div className="market-customer-flow"><div><span>01</span><b>Post the essentials</b><small>Scope, location, budget guide, and deadline.</small></div><div><span>02</span><b>Compare proposals</b><small>Invited businesses respond privately.</small></div><div><span>03</span><b>Choose who to work with</b><small>Continue into a quote and delivery workflow.</small></div></div></section>
    </main>
    <footer className="site-footer"><a href="/" className="site-brand"><span className="site-brand-mark">iQ</span><span>iQuote<span className="site-brand-dot">.</span></span></a><span>iQuote Market · Concept preview</span><a href="/">Return to iQuote</a></footer>
  </div>
}

function OnboardingAside() {
  return <aside className="onboarding-aside"><div className="aside-orbit orbit-one"/><div className="aside-orbit orbit-two"/><div className="aside-content"><div className="aside-quote-mark">“</div><p className="aside-quote">A clear quote turns good work into a confident yes.</p><p className="aside-caption">YOUR WORK, PRESENTED WELL.</p><div className="aside-card"><span className="aside-card-icon">✓</span><div><b>One link. A clear next step.</b><small>Your customer can review, respond, and keep things moving.</small></div><span className="aside-arrow">↗</span></div></div><div className="aside-bottom"><span>iQ</span><p>Thoughtful quoting for<br />businesses on the move.</p><small>BUILT FOR THE WAY YOU WORK</small></div></aside>
}
