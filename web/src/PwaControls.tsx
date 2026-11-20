import { useEffect, useState } from 'react'

declare global {
  interface WindowEventMap {
    beforeinstallprompt: Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> }
    'iquote-sw-update': CustomEvent<{ update: () => void }>
  }
}

export default function PwaControls() {
  const [online, setOnline] = useState(navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState<WindowEventMap['beforeinstallprompt'] | null>(null)
  const [update, setUpdate] = useState<(() => void) | null>(null)
  const [installed, setInstalled] = useState(window.matchMedia('(display-mode: standalone)').matches)
  const [iosHelp, setIosHelp] = useState(false)
  const isIosSafari = /iphone|ipad|ipod/i.test(navigator.userAgent) && !('standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone)

  useEffect(() => {
    const onlineNow = () => setOnline(true), offlineNow = () => setOnline(false)
    const beforeInstall = (event: WindowEventMap['beforeinstallprompt']) => { event.preventDefault(); setInstallPrompt(event) }
    const installedNow = () => { setInstalled(true); setInstallPrompt(null) }
    const updateReady = (event: WindowEventMap['iquote-sw-update']) => setUpdate(() => event.detail.update)
    window.addEventListener('online', onlineNow); window.addEventListener('offline', offlineNow)
    window.addEventListener('beforeinstallprompt', beforeInstall); window.addEventListener('appinstalled', installedNow); window.addEventListener('iquote-sw-update', updateReady)
    return () => { window.removeEventListener('online', onlineNow); window.removeEventListener('offline', offlineNow); window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installedNow); window.removeEventListener('iquote-sw-update', updateReady) }
  }, [])

  const install = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  return <div className="pwa-controls" aria-live="polite">
    {!online && <span className="pwa-state pwa-offline"><i /> Offline · changes need a connection to sync</span>}
    {update && <button type="button" className="pwa-update" onClick={update}>Update ready · Reload</button>}
    {!installed && (installPrompt || isIosSafari) && <button type="button" className="pwa-install" onClick={() => installPrompt ? void install() : setIosHelp(true)}>Install iQuote</button>}
    {iosHelp && <div className="pwa-help-backdrop" role="presentation" onClick={() => setIosHelp(false)}><section className="pwa-help-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-help-title" onClick={(event) => event.stopPropagation()}><button type="button" className="pwa-help-close" aria-label="Close" onClick={() => setIosHelp(false)}>×</button><p className="workspace-eyebrow">Install iQuote</p><h2 id="pwa-help-title">Add to your Home Screen</h2><p>In Safari, tap <strong>Share</strong>, then choose <strong>Add to Home Screen</strong>. iQuote will open like an app and keep your workspace one tap away.</p><button className="button button-primary" type="button" onClick={() => setIosHelp(false)}>Got it</button></section></div>}
  </div>
}
