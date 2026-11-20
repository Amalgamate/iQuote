import { useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'

type Notification = { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string; quote: { id: string; documentNumber: string } | null }

export default function NotificationCenter({ onOpenQuote }: { onOpenQuote: (quoteId: string) => void }) {
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const refresh = async () => {
    try {
      const result = await apiRequest<{ notifications: Notification[]; unreadCount: number }>('/api/notifications')
      setItems(result.notifications); setUnread(result.unreadCount); setFailed(false)
    } catch { setFailed(true) }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('visibilitychange', onVisibility); document.addEventListener('mousedown', onPointer)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); document.removeEventListener('mousedown', onPointer) }
  }, [])

  const markRead = async (item: Notification) => {
    if (item.readAt) return
    await apiRequest(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' })
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry))
    setUnread((count) => Math.max(0, count - 1))
  }

  return <div className="notification-center" ref={root}>
    <button type="button" className="topbar-icon-btn notification-trigger" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) void refresh() }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
      {unread > 0 && <span className="topbar-badge">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <section className="notification-popover" aria-label="Notifications">
      <header><div><strong>Notifications</strong><span>{unread ? `${unread} unread` : 'You’re all caught up'}</span></div>{unread > 0 && <button type="button" className="notification-read-all" onClick={async () => { await apiRequest('/api/notifications/read-all', { method: 'POST' }); setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }))); setUnread(0) }}>Mark all read</button>}</header>
      {failed && <p className="notification-empty">Notifications could not be refreshed. Check your connection.</p>}
      {!failed && items.length === 0 && <p className="notification-empty">New quote views, decisions, and customer messages will appear here.</p>}
      <div className="notification-list">{items.map((item) => <button type="button" className={`notification-item ${item.readAt ? '' : 'unread'}`} key={item.id} onClick={() => { void markRead(item).catch(() => setFailed(true)).finally(() => { setOpen(false); if (item.quote) onOpenQuote(item.quote.id) }) }}>
        <span className={`notification-kind kind-${item.type.toLowerCase()}`}>{item.type === 'QUOTE_MESSAGE' ? '↔' : item.type === 'QUOTE_DECISION' ? '✓' : '◷'}</span><span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><small>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</small></span><i className="notification-unread-dot" />
      </button>)}</div>
    </section>}
  </div>
}
