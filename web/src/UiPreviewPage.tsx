import { useState } from 'react'
import './UiPreviewPage.css'

const mockups = [
  { id: 'front', label: 'Public website', description: 'Public-facing homepage concept', src: '/__ui_preview/public-site.html' },
  { id: 'business', label: 'Business dashboard', description: 'Customer workspace concept', src: '/__ui_preview/business-dashboard.html' },
  { id: 'admin', label: 'Platform admin', description: 'Super-admin workspace concept', src: '/__ui_preview/admin-dashboard.html' },
] as const

type MockupId = typeof mockups[number]['id']
type Viewport = 'desktop' | 'tablet' | 'mobile'

export default function UiPreviewPage() {
  const [activeId, setActiveId] = useState<MockupId>('front')
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const activeMockup = mockups.find((item) => item.id === activeId) ?? mockups[0]

  return <main className="ui-preview-page">
    <header className="ui-preview-header">
      <a href="/" className="ui-preview-brand"><span>iQ</span><b>iQuote</b><small>UI review</small></a>
      <nav className="ui-preview-tabs" aria-label="Choose a product mockup">
        {mockups.map((item) => <button type="button" key={item.id} className={activeId === item.id ? 'active' : ''} onClick={() => setActiveId(item.id)} aria-pressed={activeId === item.id}>{item.label}</button>)}
      </nav>
      <div className="ui-preview-actions"><span>Static preview · sample data</span><a href="/market">Open Market ↗</a></div>
    </header>
    <section className="ui-preview-toolbar">
      <div><b>{activeMockup.label}</b><span>{activeMockup.description}</span></div>
      <div className="ui-preview-sizes" aria-label="Preview size">
        {(['desktop', 'tablet', 'mobile'] as const).map((size) => <button type="button" key={size} className={viewport === size ? 'active' : ''} onClick={() => setViewport(size)} aria-pressed={viewport === size}>{size}</button>)}
      </div>
    </section>
    <section className="ui-preview-stage" aria-label={activeMockup.label + ' preview'}>
      <div className={'ui-preview-frame ' + viewport}>
        <iframe key={activeMockup.src} title={activeMockup.label + ' mockup'} src={activeMockup.src} />
      </div>
    </section>
  </main>
}
