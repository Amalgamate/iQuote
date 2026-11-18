import { useState, useRef, useEffect, type FormEvent } from 'react'
import './ChatbotWidget.css'

interface Message {
  id: string
  sender: 'ai' | 'user'
  text: string
  action?: {
    label: string
    onClick: () => void
  }
}

interface ChatbotWidgetProps {
  onStartTrial?: () => void
}

const FAQ_DATABASE: Array<{ keywords: string[]; answer: string; actionLabel?: string }> = [
  {
    keywords: ['how', 'work', 'create', 'quote', 'quotation', 'make'],
    answer: "Creating a quote in iQuote takes under 2 minutes: add your client details, list your services or products with line items, configure taxes/VAT, and hit preview. You get a clean A4 presentation ready to share via one secure link.",
    actionLabel: 'Try the interactive quote preview'
  },
  {
    keywords: ['approve', 'client', 'customer', 'sign', 'accept', 'link', 'share'],
    answer: "No more messy PDF attachments! You send your customer a single secure web link. They open it on any device without needing an account, review the scope and total, and tap 'Review & Approve' in 1 click.",
  },
  {
    keywords: ['price', 'pricing', 'cost', 'plan', 'plans', 'starter', 'growth', 'team', 'free', 'trial'],
    answer: "We offer three plans: Starter (for independent freelancers), Growth (for active sales desks), and Team (for collaborative quoting). Every new workspace includes a 14-day local preview with full features and no credit card required.",
    actionLabel: 'Start your 14-day trial'
  },
  {
    keywords: ['track', 'tracking', 'view', 'opened', 'notify', 'notification', 'radar'],
    answer: "iQuote features real-time client radar: you can see the exact moment a client opens your link, how many times they viewed it, and when they approved or signed off.",
  },
  {
    keywords: ['currency', 'vat', 'tax', 'ksh', 'usd', 'eur', 'shilling', 'money'],
    answer: "iQuote supports international currencies including KSh (Kenyan Shilling), USD, EUR, GBP, UGX, TZS, and RWF. You can set default tax and VAT percentages per quotation with auto-calculated totals.",
  },
  {
    keywords: ['brand', 'logo', 'custom', 'customization', 'pdf'],
    answer: "Yes! You can add your business name, company logo, address, contact phone, and payment instructions. You can also export high-resolution A4 PDFs for traditional printing.",
    actionLabel: 'Set up your business profile'
  },
  {
    keywords: ['whatsapp', 'message', 'phone', 'mobile'],
    answer: "iQuote is designed mobile-first like WhatsApp. You can copy the quote link and paste it directly into WhatsApp, SMS, or email so clients can open it immediately on their phones.",
  }
]

export default function ChatbotWidget({ onStartTrial }: ChatbotWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hasUnread, setHasUnread] = useState(true)
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome-1',
      sender: 'ai',
      text: "👋 Hi! I'm iQ Assistant, your quoting specialist. Ask me anything about creating quotes, 1-click approvals, or our 14-day trial!"
    }
  ])

  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    if (isOpen) {
      scrollToBottom()
      setHasUnread(false)
    }
  }, [isOpen, messages, isTyping])

  const findAnswer = (query: string): { answer: string; actionLabel?: string } => {
    const q = query.toLowerCase()
    for (const item of FAQ_DATABASE) {
      const match = item.keywords.some(k => q.includes(k))
      if (match) {
        return { answer: item.answer, actionLabel: item.actionLabel }
      }
    }
    return {
      answer: "Good work deserves a clear quote! iQuote helps studios, trades, consultants, and growing businesses create beautiful quotes, share them with a link, and get approved fast. Would you like to explore a workspace?",
      actionLabel: 'Create your workspace'
    }
  }

  const handleSend = (textToSend?: string) => {
    const query = (textToSend ?? input).trim()
    if (!query) return

    const userMsg: Message = {
      id: 'user-' + Date.now(),
      sender: 'user',
      text: query
    }

    setMessages(prev => [...prev, userMsg])
    if (!textToSend) setInput('')
    setIsTyping(true)

    // Simulate intelligent AI thinking delay
    setTimeout(() => {
      const { answer, actionLabel } = findAnswer(query)
      const aiMsg: Message = {
        id: 'ai-' + Date.now(),
        sender: 'ai',
        text: answer,
        action: actionLabel && onStartTrial ? {
          label: actionLabel,
          onClick: onStartTrial
        } : undefined
      }
      setMessages(prev => [...prev, aiMsg])
      setIsTyping(false)
    }, 700)
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    handleSend()
  }

  const quickPrompts = [
    'How do clients approve quotes?',
    'What is included in the trial?',
    'Can I customize currencies & VAT?',
    'How does quote tracking work?'
  ]

  return (
    <div className="iq-chatbot-root">
      {/* Pop-up Greeting Teaser when closed */}
      {!isOpen && hasUnread && (
        <div className="iq-chat-teaser" onClick={() => setIsOpen(true)}>
          <span className="teaser-dot" />
          <p>Questions about iQuote? <b>Ask AI Assistant</b></p>
          <button 
            type="button" 
            className="teaser-close" 
            aria-label="Dismiss teaser"
            onClick={(e) => { e.stopPropagation(); setHasUnread(false); }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Floating Toggle Button */}
      <button 
        type="button" 
        className={`iq-chat-launcher ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? "Close iQ Assistant" : "Open iQ Assistant"}
      >
        {isOpen ? (
          <span className="launcher-close-icon">✕</span>
        ) : (
          <div className="launcher-icon-wrap">
            <span className="launcher-icon" aria-hidden="true">iQ</span>
          </div>
        )}
      </button>

      {/* Chat Window Panel */}
      {isOpen && (
        <section className="iq-chat-window" aria-label="iQ Assistant Chatbot">
          {/* Header */}
          <header className="iq-chat-header">
            <div className="iq-chat-bot-info">
              <div className="iq-chat-avatar">
                <span>iQ</span>
                <span className="iq-avatar-online" />
              </div>
              <div>
                <b>iQ Assistant</b>
                <small><span className="status-live-dot" /> AI Quoting Specialist · Online</small>
              </div>
            </div>
            <button 
              type="button" 
              className="iq-chat-close-btn" 
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
            >
              ✕
            </button>
          </header>

          {/* Messages Area */}
          <div className="iq-chat-messages">
            {messages.map(msg => (
              <div key={msg.id} className={`iq-chat-row ${msg.sender}`}>
                {msg.sender === 'ai' && (
                  <div className="iq-msg-avatar">✨</div>
                )}
                <div className="iq-chat-bubble">
                  <p>{msg.text}</p>
                  {msg.action && (
                    <button 
                      type="button" 
                      className="iq-bubble-action-btn"
                      onClick={() => {
                        msg.action?.onClick()
                        setIsOpen(false)
                      }}
                    >
                      {msg.action.label} <span>↗</span>
                    </button>
                  )}
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="iq-chat-row ai">
                <div className="iq-msg-avatar">✨</div>
                <div className="iq-chat-bubble iq-typing-bubble">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts */}
          <div className="iq-chat-quick-prompts">
            {quickPrompts.map(prompt => (
              <button 
                key={prompt} 
                type="button" 
                className="iq-prompt-chip"
                onClick={() => handleSend(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Input Form */}
          <form className="iq-chat-input-bar" onSubmit={handleSubmit}>
            <input 
              type="text" 
              value={input} 
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about quotes, sharing, pricing..."
              aria-label="Message input"
            />
            <button 
              type="submit" 
              className="iq-chat-send-btn" 
              disabled={!input.trim()}
              aria-label="Send message"
            >
              <span>↑</span>
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
