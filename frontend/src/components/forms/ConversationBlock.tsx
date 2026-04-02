'use client'
import { useState, useRef } from 'react'
import { ChevronDown, ChevronRight, Loader2, Send } from 'lucide-react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ConversationBlockProps {
  label: string
  agentInstallationId: string
  agentName: string
  placeholder?: string
  contextHint?: string
  orgId: string
  studyId?: string
}

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

async function gql(query: string, variables = {}) {
  const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

const ACTIVE_STATUSES = new Set(['running', 'pending'])

export default function ConversationBlock({
  label, agentInstallationId, agentName, placeholder, contextHint, orgId, studyId,
}: ConversationBlockProps) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [polling, setPolling] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleSend = async () => {
    const text = input.trim()
    if (!text || polling) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setPolling(true)

    try {
      const query = contextHint ? `${contextHint}\n\n${text}` : text
      const runData = await gql(`
        mutation($installationId: String!, $studyId: String!, $orgId: String!, $ctx: JSON) {
          startAgentRun(installationId: $installationId, studyId: $studyId, orgId: $orgId, inputContext: $ctx) {
            id status
          }
        }
      `, { installationId: agentInstallationId, studyId: studyId || '', orgId, ctx: { query } })

      const runId = runData.startAgentRun?.id
      if (!runId) throw new Error('Failed to start agent run')

      pollRef.current = setInterval(async () => {
        try {
          const pollData = await gql(`
            query($runId: String!) {
              agentRunDetail(runId: $runId) { id status outputSummary errorMessage }
            }
          `, { runId })
          const run = pollData.agentRunDetail
          if (!ACTIVE_STATUSES.has(run.status)) {
            clearInterval(pollRef.current!)
            setPolling(false)
            const reply = run.status === 'completed'
              ? (run.outputSummary || 'Task completed.')
              : `Error: ${run.errorMessage || 'Agent run failed'}`
            setMessages(prev => [...prev, { role: 'assistant', content: reply }])
          }
        } catch (e) {
          clearInterval(pollRef.current!)
          setPolling(false)
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e instanceof Error ? e.message : 'Unknown error'}` }])
        }
      }, 2000)
    } catch (e) {
      setPolling(false)
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e instanceof Error ? e.message : 'Unknown error'}` }])
    }
  }

  return (
    <div className="border border-violet-200 rounded-xl overflow-hidden" style={{ borderLeftWidth: 4, borderLeftColor: '#8b5cf6' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-violet-50 hover:bg-violet-100 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-violet-600" /> : <ChevronRight className="w-4 h-4 text-violet-600" />}
        <span className="text-sm font-semibold text-violet-800">Chat with {agentName}</span>
        <span className="ml-auto text-xs text-violet-500">{label}</span>
      </button>

      {open && (
        <div className="bg-white">
          <div className="h-48 overflow-y-auto p-3 space-y-2 border-b border-slate-100">
            {messages.length === 0 && (
              <p className="text-xs text-slate-400 text-center mt-8">Start a conversation with the agent</p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-xl text-xs ${
                  msg.role === 'user'
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-100 text-slate-700'
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {polling && (
              <div className="flex justify-start">
                <div className="px-3 py-2 bg-slate-100 rounded-xl">
                  <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 p-3">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={placeholder || 'Ask the agent...'}
              disabled={polling}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || polling}
              className="px-3 py-2 bg-violet-500 text-white rounded-lg hover:bg-violet-600 disabled:opacity-40 transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
