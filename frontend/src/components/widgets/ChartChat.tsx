'use client'
import { useState, useRef, useEffect } from 'react'
import { Send, Sparkles } from 'lucide-react'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

async function gql(query: string, variables: any) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

const SUGGESTIONS = [
  'Highlight the highest values',
  'Add a mean reference line',
  'Show minimum and maximum points',
  'Highlight the first quarter of data',
]

interface Message {
  role: 'user' | 'assistant'
  text: string
}

interface Props {
  widgetId: string
  orgId: string
  onOptionPatch: (patch: any) => void
}

export default function ChartChat({ widgetId, orgId, onOptionPatch }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send(text: string) {
    if (!text.trim() || loading) return
    const userMsg = text.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setLoading(true)
    try {
      const data = await gql(`
        mutation Chat($widgetId: ID!, $orgId: String!, $message: String!) {
          chatWithWidget(widgetId: $widgetId, orgId: $orgId, message: $message) {
            message
            optionPatch
          }
        }
      `, { widgetId, orgId, message: userMsg })
      const reply = data.chatWithWidget
      setMessages(prev => [...prev, { role: 'assistant', text: reply.message }])
      if (reply.optionPatch) onOptionPatch(reply.optionPatch)
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="pt-1">
            <p className="text-[11px] text-slate-400 mb-2">Ask me to highlight, annotate, or explain the chart.</p>
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  className="text-[10px] bg-brand-50 text-brand-600 border border-brand-100 rounded-full px-2 py-0.5 hover:bg-brand-100 transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
              m.role === 'user'
                ? 'bg-brand-500 text-white'
                : 'bg-slate-100 text-slate-700'
            }`}>
              {m.role === 'assistant' && (
                <Sparkles className="w-3 h-3 inline mr-1 text-brand-400" />
              )}
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 rounded-lg px-2.5 py-1.5">
              <div className="flex gap-1">
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-2 py-1.5 border-t border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-slate-50 rounded-lg border border-slate-200 px-2 py-1">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send(input)}
            placeholder="Ask about the chart…"
            className="flex-1 bg-transparent text-[11px] text-slate-700 placeholder-slate-400 outline-none"
          />
          <button onClick={() => send(input)} disabled={!input.trim() || loading}
            className="text-brand-500 hover:text-brand-700 disabled:opacity-30 transition-colors flex-shrink-0">
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
