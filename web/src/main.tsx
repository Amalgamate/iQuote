import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      const publishWaitingWorker = () => {
        if (!registration.waiting) return
        window.dispatchEvent(new CustomEvent('iquote-sw-update', { detail: { update: () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' }) } }))
      }
      publishWaitingWorker()
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) publishWaitingWorker()
        })
      })
      window.setInterval(() => { if (document.visibilityState === 'visible') void registration.update() }, 60 * 60 * 1000)
      let reloaded = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return
        reloaded = true
        window.location.reload()
      })
    }).catch((error) => console.warn('iQuote offline support could not start.', error))
  })
}
