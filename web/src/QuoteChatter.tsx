import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'

type Message = { id: string; authorType: string; authorName: string; content: string; createdAt: string }

export default function QuoteChatter({ quoteId, token, mode, readOnly = false }: { quoteId?: string; token?: string; mode: 'business' | 'customer'; readOnly?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const base = mode === 'customer' ? `/api/public/quotes/${encodeURIComponent(token ?? '')}` : `/api/quotes/${encodeURIComponent(quoteId ?? '')}`

  const refresh = useCallback(async () => {
    try {
      const result = await apiRequest<{ messages: Message[] }>(`${base}/messages`)
      setMessages(result.messages)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load this conversation.')
    } finally { setLoading(false) }
  }, [base])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, mode === 'customer' ? 30000 : 15000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const value = content.trim()
    if (!value || sending) return
    setSending(true)
    setError('')
    try {
      await apiRequest(`${base}/messages`, { method: 'POST', body: JSON.stringify({ content: value }) })
      setContent('')
      await refresh()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Unable to send your message.') }
    finally { setSending(false) }
  }

  return <section className={`quote-chatter ${mode === 'customer' ? 'quote-chatter-customer' : ''}`} aria-label="Quote conversation">
    <div className="chatter-heading"><div><h2>Conversation</h2><p>Keep quote questions and answers together.</p></div><span className="chatter-live"><i /> Shared thread</span></div>
    <div className="chatter-messages" aria-live="polite">
      {loading && <p className="chatter-empty">Loading conversation…</p>}
      {!loading && messages.length === 0 && <p className="chatter-empty">No messages yet. Start the conversation about this quote.</p>}
      {messages.map((message) => <article className={`chatter-message ${message.authorType === (mode === 'business' ? 'BUSINESS' : 'CUSTOMER') ? 'own-message' : ''}`} key={message.id}>
        <div className="chatter-message-meta"><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.createdAt))}</time></div>
        <p>{message.content}</p>
      </article>)}
    </div>
    {error && <p className="chatter-error" role="alert">{error}</p>}
    {readOnly ? <p className="chatter-closed" role="status">This quote has expired. The conversation is available to read, but messaging is closed.</p> : <form className="chatter-compose" onSubmit={(event) => void send(event)}>
      <label className="sr-only" htmlFor={`chatter-${mode}-${quoteId ?? token}`}>Write a message</label>
      <textarea id={`chatter-${mode}-${quoteId ?? token}`} value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} rows={3} placeholder="Write a message…" />
      <div><small>{content.length}/4000 · Visible to both sides</small><button className="button button-primary" type="submit" disabled={!content.trim() || sending}>{sending ? 'Sending…' : 'Send message'}</button></div>
    </form>}
  </section>
}
