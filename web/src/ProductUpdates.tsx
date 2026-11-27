import { useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'

type ProductUpdate = { id: string; title: string; body: string; readAt: string | null; createdAt: string }

export default function ProductUpdates() {
  const [updates, setUpdates] = useState<ProductUpdate[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const refresh = async () => {
    try {
      const result = await apiRequest<{ updates: ProductUpdate[]; unreadCount: number }>('/api/product-updates')
      setUpdates(result.updates)
      setUnread(result.unreadCount)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60000)
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const markRead = async (item: ProductUpdate) => {
    if (item.readAt) return
    await apiRequest(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' })
    setUpdates((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry))
    setUnread((current) => Math.max(0, current - 1))
  }

  return <div className="product-updates" ref={root}>
    <button type="button" className="product-updates-trigger" aria-label={`What's new${unread ? `, ${unread} unread` : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) void refresh() }}>
      <span aria-hidden="true">✦</span><span>What’s new</span>{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}
    </button>
    {open && <section className="product-updates-popover" role="dialog" aria-label="Product updates">
      <header><div><strong>What’s new</strong><span>Product changes for your workspace</span></div>{unread > 0 && <button type="button" className="notification-read-all" onClick={async () => {
        try {
          await apiRequest('/api/product-updates/read-all', { method: 'POST' })
          setUpdates((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })))
          setUnread(0)
        } catch { setFailed(true) }
      }}>Mark all read</button>}</header>
      {failed && <p className="notification-empty">Updates could not be loaded. Check your connection and try again.</p>}
      {!failed && updates.length === 0 && <p className="notification-empty">There are no product updates yet.</p>}
      <div className="product-updates-list">{updates.map((item) => <article className={`product-update-item ${item.readAt ? '' : 'unread'}`} key={item.id}>
        <span className="product-update-icon" aria-hidden="true">✦</span>
        <div className="product-update-copy"><strong>{item.title.replace(/^Feature update · /, '')}</strong><small>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date(item.createdAt))}</small><p>{item.body}</p>{!item.readAt && <button type="button" onClick={() => void markRead(item).catch(() => setFailed(true))}>Mark as read</button>}</div>
        {!item.readAt && <i className="notification-unread-dot" />}
      </article>)}</div>
    </section>}
  </div>
}
