import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest, assetUrl } from './api'
import './DocumentDesignSettings.css'

type TemplateKey = 'classic' | 'modern' | 'minimal' | 'bold' | 'compact'
type DocumentDesign = {
  version: 1; template: TemplateKey; brandColor: string; typeface: 'sans' | 'serif'; header: 'plain' | 'band' | 'dark'
  table: 'lined' | 'striped' | 'boxed' | 'minimal'; total: 'wash' | 'solid' | 'rule'; spacing: 'comfortable' | 'compact'
  logo: { scale: number }
  show: { tax: boolean; unit: boolean; totalInWords: boolean; kraPin: boolean; paymentBox: boolean; qr: boolean; terms: boolean; acceptance: boolean }
  text: { quoteTitle: string; invoiceTitle: string; receiptTitle: string; footer: string; terms: string }
  payment: { paybill: string; till: string }; email: { attachPdf: boolean }
}
type Identity = { kraPin: string; vatNumber: string; address: string }
type TemplateOption = { key: TemplateKey; allowed: boolean }
type SettingsResponse = { design: DocumentDesign; saved: DocumentDesign; templateLocked: boolean; templates: TemplateOption[]; identity: Identity }
type Props = { logoUrl: string | null; name: string; onDirtyChange: (dirty: boolean) => void }

const templateNames: Record<TemplateKey, string> = { modern: 'Modern', classic: 'Classic', minimal: 'Minimal', compact: 'Compact', bold: 'Bold' }
const unlockPlan: Record<TemplateKey, string> = { modern: 'Starter', classic: 'Starter', minimal: 'Growth', compact: 'Growth', bold: 'Team' }
const templateOrder: TemplateKey[] = ['modern', 'classic', 'minimal', 'compact', 'bold']
const presets: Record<TemplateKey, Pick<DocumentDesign, 'typeface' | 'header' | 'table' | 'total' | 'spacing'>> = {
  classic: { typeface: 'serif', header: 'plain', table: 'boxed', total: 'rule', spacing: 'comfortable' },
  modern: { typeface: 'sans', header: 'band', table: 'striped', total: 'solid', spacing: 'comfortable' },
  minimal: { typeface: 'sans', header: 'plain', table: 'minimal', total: 'rule', spacing: 'comfortable' },
  bold: { typeface: 'sans', header: 'dark', table: 'striped', total: 'solid', spacing: 'comfortable' },
  compact: { typeface: 'sans', header: 'plain', table: 'lined', total: 'wash', spacing: 'compact' },
}
const labels: Array<{ key: keyof DocumentDesign['show']; label: string }> = [
  { key: 'tax', label: 'Show tax columns and totals' }, { key: 'unit', label: 'Show item units' },
  { key: 'totalInWords', label: 'Spell out the total in words' }, { key: 'kraPin', label: 'Show KRA PIN' },
  { key: 'paymentBox', label: 'Show payment instructions' }, { key: 'qr', label: 'Show quote QR code' },
  { key: 'terms', label: 'Show terms and conditions' }, { key: 'acceptance', label: 'Show quote acceptance section' },
]

function readableContrast(color: string) {
  const values = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
  return 1.05 / (luminance + 0.05) >= 3
}

export default function DocumentDesignSettings({ logoUrl, name, onDirtyChange }: Props) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [draft, setDraft] = useState<DocumentDesign | null>(null)
  const [identity, setIdentity] = useState<Identity>({ kraPin: '', vatNumber: '', address: '' })
  const [savedIdentity, setSavedIdentity] = useState<Identity>({ kraPin: '', vatNumber: '', address: '' })
  const [kind, setKind] = useState<'quote' | 'invoice' | 'receipt'>('quote')
  const [previewUrl, setPreviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(true)
  const previewTimer = useRef<number | undefined>(undefined)
  const previewController = useRef<AbortController | null>(null)
  const dirty = useMemo(() => Boolean(draft && settings && (JSON.stringify(draft) !== JSON.stringify(settings.design) || JSON.stringify(identity) !== JSON.stringify(savedIdentity))), [draft, settings, identity, savedIdentity])
  const colorSafe = draft ? readableContrast(draft.brandColor) : true

  async function load() {
    try {
      const response = await apiRequest<SettingsResponse>('/api/settings/document-design')
      setSettings(response); setDraft(response.design); setIdentity(response.identity); setSavedIdentity(response.identity); setAvailable(true)
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Document design settings could not be loaded.'
      if (text.includes('not available on this deployment')) setAvailable(false)
      else setError(text)
    } finally { setLoading(false) }
  }

  useEffect(() => { void load(); return () => { if (previewTimer.current) window.clearTimeout(previewTimer.current); previewController.current?.abort() } }, [])

  useEffect(() => {
    if (!draft || !available || loading) return
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(async () => {
      previewController.current?.abort()
      const controller = new AbortController(); previewController.current = controller
      setPreviewLoading(true)
      try {
        const response = await fetch(assetUrl('/api/settings/document-design/preview') ?? '/api/settings/document-design/preview', {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, design: draft, identity }),
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.message ?? 'The document preview could not be rendered.')
        }
        const blob = await response.blob()
        const nextUrl = URL.createObjectURL(blob)
        setPreviewUrl((oldUrl) => { if (oldUrl) URL.revokeObjectURL(oldUrl); return nextUrl })
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'The document preview could not be rendered.')
      } finally { if (!controller.signal.aborted) setPreviewLoading(false) }
    }, 450)
    return () => { if (previewTimer.current) window.clearTimeout(previewTimer.current) }
  }, [draft, identity, kind, available, loading])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  function update<K extends keyof DocumentDesign>(key: K, value: DocumentDesign[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setMessage(''); setError('')
  }

  function selectTemplate(template: TemplateKey) {
    if (!settings?.templates.find((item) => item.key === template)?.allowed || !draft) return
    setDraft({ ...draft, template, ...presets[template] }); setMessage(''); setError('')
  }

  async function save() {
    if (!draft) return
    setSaving(true); setMessage(''); setError('')
    try {
      const response = await apiRequest<SettingsResponse>('/api/settings/document-design', { method: 'PUT', body: JSON.stringify({ design: draft, identity }) })
      setSettings(response); setDraft(response.design); setIdentity(response.identity); setSavedIdentity(response.identity); setMessage('Document design saved.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save document design.') }
    finally { setSaving(false) }
  }

  function discard() {
    if (!settings) return
    setDraft(settings.design); setIdentity(settings.identity); setSavedIdentity(settings.identity); setMessage('Unsaved changes discarded.'); setError('')
  }

  async function reset() {
    if (!draft || !window.confirm(`Reset the ${templateNames[draft.template]} template and all document options to its defaults?`)) return
    setSaving(true); setError(''); setMessage('')
    try {
      const response = await apiRequest<SettingsResponse>('/api/settings/document-design/reset', { method: 'POST', body: JSON.stringify({ template: draft.template }) })
      setSettings(response); setDraft(response.design); setIdentity(response.identity); setSavedIdentity(response.identity); setMessage('Template defaults restored.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reset the template.') }
    finally { setSaving(false) }
  }

  if (!available) return null
  if (loading) return <section className="workspace-panel document-design-panel"><p className="document-design-muted">Loading document design…</p></section>
  if (!draft || !settings) return <section className="workspace-panel document-design-panel"><p className="form-error" role="alert">{error || 'Document design settings could not be loaded.'}</p></section>

  return <section className="workspace-panel document-design-panel" aria-labelledby="document-design-title">
    <header className="document-design-heading"><div><p className="workspace-eyebrow">Documents and branding</p><h2 id="document-design-title">Design your customer documents</h2><p>Choose one consistent look for quotations, invoices and receipts.</p></div><div className="document-design-status" role="status">{dirty ? 'Unsaved changes' : message || 'Saved'}</div></header>

    {settings.templateLocked && <div className="document-design-notice" role="status">Your saved template is locked on this plan. Documents currently use Modern; your saved design is retained.</div>}

    <div className="document-design-layout">
      <div className="document-design-controls">
        <section className="document-design-section"><h3>Choose a template</h3><p>Templates change the layout, while your colour and wording stay yours.</p><div className="document-template-gallery">
          {templateOrder.map((key) => {
            const option = settings.templates.find((item) => item.key === key)
            const locked = !option?.allowed
            return <button type="button" className={`document-template-card ${draft.template === key ? 'selected' : ''} ${locked ? 'locked' : ''}`} key={key} onClick={() => selectTemplate(key)} disabled={locked} aria-pressed={draft.template === key} aria-label={`${templateNames[key]} template${locked ? `, available on ${unlockPlan[key]} plan` : ''}`}>
              <span className={`template-mini template-mini-${key}`} aria-hidden="true"><i /><i /><b /><em /></span><strong>{templateNames[key]}</strong><small>{locked ? `Unlocks on ${unlockPlan[key]}` : key === 'modern' ? 'Clean, balanced layout' : key === 'classic' ? 'Formal, traditional style' : key === 'minimal' ? 'Quiet, spacious layout' : key === 'compact' ? 'More detail per page' : 'Strong, high contrast'}</small>
            </button>
          })}
        </div></section>

        <section className="document-design-section"><h3>Brand</h3><div className="document-design-fields">
          <label>Brand colour<div className="document-color-control"><input type="color" aria-label="Choose brand colour" value={draft.brandColor} onChange={(event) => update('brandColor', event.target.value)} /><input className="input-control" value={draft.brandColor} maxLength={7} onChange={(event) => /^#[0-9a-f]{0,6}$/i.test(event.target.value) && update('brandColor', event.target.value)} /></div>{!colorSafe && <small className="document-design-warning">This colour is too light for white text in the document. The PDF will use the safe green accent.</small>}</label>
          <label>Logo size <output>{draft.logo.scale}%</output><input type="range" min="50" max="150" step="5" value={draft.logo.scale} onChange={(event) => update('logo', { scale: Number(event.target.value) })} /><small className="document-design-hint">The image keeps its proportions. Upload or change your logo in Business profile below.</small></label>
          <label>Business address<input className="input-control" maxLength={200} value={identity.address} onChange={(event) => setIdentity((current) => ({ ...current, address: event.target.value }))} /></label>
          <label>KRA PIN<input className="input-control" maxLength={20} value={identity.kraPin} onChange={(event) => setIdentity((current) => ({ ...current, kraPin: event.target.value.toUpperCase() }))} placeholder="A123456789Z" /></label>
          <label>VAT number<input className="input-control" maxLength={20} value={identity.vatNumber} onChange={(event) => setIdentity((current) => ({ ...current, vatNumber: event.target.value }))} /></label>
          {logoUrl && <div className="document-logo-current"><img src={assetUrl(logoUrl) ?? undefined} alt={`${name} logo preview`} /><span>Current business logo</span></div>}
        </div></section>

        <section className="document-design-section"><h3>Layout details</h3><div className="document-design-fields">
          <label>Header<select className="input-control" value={draft.header} onChange={(event) => update('header', event.target.value as DocumentDesign['header'])}><option value="plain">Plain</option><option value="band">Brand colour band</option><option value="dark">Dark band</option></select></label>
          <label>Table style<select className="input-control" value={draft.table} onChange={(event) => update('table', event.target.value as DocumentDesign['table'])}><option value="lined">Lined</option><option value="striped">Striped</option><option value="boxed">Boxed</option><option value="minimal">Minimal</option></select></label>
          <label>Totals style<select className="input-control" value={draft.total} onChange={(event) => update('total', event.target.value as DocumentDesign['total'])}><option value="wash">Soft highlight</option><option value="solid">Solid brand colour</option><option value="rule">Simple rules</option></select></label>
          <label>Type style<select className="input-control" value={draft.typeface} onChange={(event) => update('typeface', event.target.value as DocumentDesign['typeface'])}><option value="sans">Sans serif</option><option value="serif">Serif</option></select></label>
          <label>Document spacing<select className="input-control" value={draft.spacing} onChange={(event) => update('spacing', event.target.value as DocumentDesign['spacing'])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        </div></section>

        <section className="document-design-section"><h3>What to show</h3><div className="document-design-checks">{labels.map(({ key, label }) => <label key={key}><input type="checkbox" checked={draft.show[key]} onChange={(event) => update('show', { ...draft.show, [key]: event.target.checked })} />{label}</label>)}</div></section>

        <section className="document-design-section"><h3>Wording and payment details</h3><div className="document-design-fields">
          <label>Quotation title<input className="input-control" maxLength={40} value={draft.text.quoteTitle} onChange={(event) => update('text', { ...draft.text, quoteTitle: event.target.value })} /></label>
          <label>Invoice title<input className="input-control" maxLength={40} value={draft.text.invoiceTitle} onChange={(event) => update('text', { ...draft.text, invoiceTitle: event.target.value })} /></label>
          <label>Receipt title<input className="input-control" maxLength={40} value={draft.text.receiptTitle} onChange={(event) => update('text', { ...draft.text, receiptTitle: event.target.value })} /></label>
          <label>Footer message<input className="input-control" maxLength={200} value={draft.text.footer} onChange={(event) => update('text', { ...draft.text, footer: event.target.value })} /></label>
          <label className="document-full-field">Default terms<textarea className="input-control" rows={3} maxLength={2000} value={draft.text.terms} onChange={(event) => update('text', { ...draft.text, terms: event.target.value })} /></label>
          <label>Paybill number<input className="input-control" inputMode="numeric" maxLength={7} value={draft.payment.paybill} onChange={(event) => update('payment', { ...draft.payment, paybill: event.target.value.replace(/\D/g, '') })} /></label>
          <label>Till number<input className="input-control" inputMode="numeric" maxLength={7} value={draft.payment.till} onChange={(event) => update('payment', { ...draft.payment, till: event.target.value.replace(/\D/g, '') })} /></label>
        </div><label className="document-attach-option"><input type="checkbox" checked={draft.email.attachPdf} onChange={(event) => update('email', { attachPdf: event.target.checked })} />Default to attaching the PDF when emailing documents <span>You can override this for each quote or receipt email. Attachments may be omitted if the PDF cannot be generated or is too large.</span></label></section>
      </div>

      <aside className="document-design-preview" aria-label="Document preview">
        <div className="document-preview-tabs" role="tablist" aria-label="Preview document type">{(['quote', 'invoice', 'receipt'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
        <div className="document-preview-frame">{previewUrl ? <iframe title={`${kind} PDF preview`} src={previewUrl} /> : <div className="document-preview-placeholder">{previewLoading ? 'Rendering preview…' : 'Preview will appear here.'}</div>}{previewLoading && previewUrl && <span className="document-preview-loading">Updating preview…</span>}</div>
        <p className="document-design-hint">This is the server-rendered PDF customers will receive or download.</p>
      </aside>
    </div>

    {error && <p className="document-design-error" role="alert">{error}</p>}
    <footer className="document-design-actions"><span className="document-design-result" role="status">{message}</span><button type="button" className="button button-secondary" onClick={discard} disabled={!dirty || saving}>Discard</button><button type="button" className="button button-secondary" onClick={() => void reset()} disabled={saving}>Reset this template</button><button type="button" className="button button-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save document design'}</button></footer>
  </section>
}
