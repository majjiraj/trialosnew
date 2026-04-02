'use client'
import { useState, useEffect, useRef } from 'react'
import { GitBranch, Search, Loader2, ChevronDown, AlertCircle, Network, FileText } from 'lucide-react'
import { clsx } from 'clsx'
import { useOrgId } from '@/components/layout/AuthContext'
import { ContextSearch } from '@/components/context/ContextSearch'
import { DecisionTracePanel } from '@/components/context/DecisionTracePanel'
import { DocumentGraphView } from '@/components/context/DocumentGraphView'
import { AgentReasoningGraph } from '@/components/agent/AgentReasoningGraph'

type Tab = 'search' | 'traces' | 'run-graph' | 'doc-graph'

interface AgentRun {
  id: string
  agentName: string
  status: string
  createdAt: string
}

interface Document {
  id: string
  name: string
  documentType: string
  status: string
}

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

async function gql(query: string) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

function Dropdown({
  value, onChange, options, placeholder, disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find(o => o.value === value)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'w-full flex items-center justify-between gap-2 px-3 py-2 border rounded-lg text-sm bg-white text-left transition-colors',
          disabled ? 'opacity-50 cursor-not-allowed border-slate-200' : 'border-slate-200 hover:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500',
          open && 'border-brand-400 ring-2 ring-brand-500',
        )}
      >
        <span className={clsx('truncate', selected ? 'text-slate-800' : 'text-slate-400')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-slate-400 flex-shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">No options</div>
          ) : (
            options.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={clsx(
                  'w-full text-left px-3 py-2 text-sm hover:bg-brand-50 transition-colors',
                  opt.value === value ? 'bg-brand-50 text-brand-700 font-medium' : 'text-slate-700',
                )}
              >
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default function ContextGraphPage() {
  const orgId = useOrgId()
  const [tab, setTab] = useState<Tab>('search')

  // Shared runs state (used by traces + run-graph tabs)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [runsError, setRunsError] = useState<string | null>(null)

  // Decision traces state
  const [traceAgent, setTraceAgent] = useState('')
  const [traceRunId, setTraceRunId] = useState('')

  // Agent run graph state
  const [graphAgent, setGraphAgent] = useState('')
  const [graphRunId, setGraphRunId] = useState('')

  // Documents state
  const [docs, setDocs] = useState<Document[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [docsError, setDocsError] = useState<string | null>(null)
  const [selectedDocId, setSelectedDocId] = useState('')

  // Load runs when entering traces or run-graph tab
  useEffect(() => {
    if ((tab !== 'traces' && tab !== 'run-graph') || !orgId || runs.length > 0) return
    setLoadingRuns(true)
    setRunsError(null)
    gql(`query { agentRunsForOrg(orgId: "${orgId}", limit: 100) {
      id agentName agentSlug status createdAt
    }}`)
      .then(data => setRuns(data.agentRunsForOrg || []))
      .catch(e => setRunsError(e.message || 'Failed to load runs'))
      .finally(() => setLoadingRuns(false))
  }, [tab, orgId, runs.length])

  // Load documents when entering doc-graph tab
  useEffect(() => {
    if (tab !== 'doc-graph' || !orgId || docs.length > 0) return
    setLoadingDocs(true)
    setDocsError(null)
    gql(`query { documents(orgId: "${orgId}") {
      id name documentType status
    }}`)
      .then(data => setDocs(data.documents || []))
      .catch(e => setDocsError(e.message || 'Failed to load documents'))
      .finally(() => setLoadingDocs(false))
  }, [tab, orgId, docs.length])

  const agentOptions = Array.from(new Set(runs.map(r => r.agentName).filter(Boolean)))
    .sort()
    .map(name => ({ value: name, label: name }))

  const runsForAgent = (agent: string) =>
    runs
      .filter(r => r.agentName === agent)
      .map(r => ({
        value: r.id,
        label: `${new Date(r.createdAt).toLocaleString()} · ${r.status} · ${r.id.slice(0, 8)}…`,
      }))

  const docOptions = docs.map(d => ({
    value: d.id,
    label: `${d.name} (${d.documentType})`,
  }))

  const TABS = [
    { id: 'search' as Tab,    label: 'Context Search',   icon: Search },
    { id: 'traces' as Tab,    label: 'Decision Traces',  icon: GitBranch },
    { id: 'run-graph' as Tab, label: 'Agent Run Graph',  icon: Network },
    { id: 'doc-graph' as Tab, label: 'Document Graph',   icon: FileText },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Context Graph</h1>
        <p className="text-sm text-slate-500 mt-1">
          Search the knowledge graph, inspect decision traces, and visualize agent and document graphs
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === id
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Context Search ──────────────────────────────────────────────────── */}
      {tab === 'search' && (
        <div className="card p-5">
          <ContextSearch orgId={orgId} />
        </div>
      )}

      {/* ── Decision Traces ─────────────────────────────────────────────────── */}
      {tab === 'traces' && (
        <div className="space-y-4">
          <div className="card p-4">
            {loadingRuns ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading runs…
              </div>
            ) : runsError ? (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle className="w-4 h-4" /> {runsError}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Agent</label>
                  <Dropdown value={traceAgent} onChange={v => { setTraceAgent(v); setTraceRunId('') }}
                    options={agentOptions} placeholder="Select an agent…" />
                  {agentOptions.length === 0 && <p className="text-xs text-slate-400 mt-1">No runs found</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Run</label>
                  <Dropdown value={traceRunId} onChange={setTraceRunId}
                    options={runsForAgent(traceAgent)} placeholder="Select a run…" disabled={!traceAgent} />
                </div>
              </div>
            )}
          </div>
          {traceRunId && (
            <div className="card p-5">
              <DecisionTracePanel runId={traceRunId} />
            </div>
          )}
        </div>
      )}

      {/* ── Agent Run Graph ─────────────────────────────────────────────────── */}
      {tab === 'run-graph' && (
        <div className="space-y-4">
          <div className="card p-4">
            {loadingRuns ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading runs…
              </div>
            ) : runsError ? (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle className="w-4 h-4" /> {runsError}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Agent</label>
                  <Dropdown value={graphAgent} onChange={v => { setGraphAgent(v); setGraphRunId('') }}
                    options={agentOptions} placeholder="Select an agent…" />
                  {agentOptions.length === 0 && <p className="text-xs text-slate-400 mt-1">No runs found</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Run</label>
                  <Dropdown value={graphRunId} onChange={setGraphRunId}
                    options={runsForAgent(graphAgent)} placeholder="Select a run…" disabled={!graphAgent} />
                </div>
              </div>
            )}
          </div>
          {graphRunId && (
            <div className="card overflow-hidden" style={{ height: 560 }}>
              <AgentReasoningGraph runId={graphRunId} orgId={orgId} />
            </div>
          )}
        </div>
      )}

      {/* ── Document Graph ──────────────────────────────────────────────────── */}
      {tab === 'doc-graph' && (
        <div className="space-y-4">
          <div className="card p-4">
            {loadingDocs ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading documents…
              </div>
            ) : docsError ? (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle className="w-4 h-4" /> {docsError}
              </div>
            ) : (
              <div className="max-w-lg">
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Document</label>
                <Dropdown value={selectedDocId} onChange={setSelectedDocId}
                  options={docOptions} placeholder="Select a document…" />
                {docOptions.length === 0 && <p className="text-xs text-slate-400 mt-1">No documents found</p>}
              </div>
            )}
          </div>
          {selectedDocId && (
            <div className="card overflow-hidden" style={{ height: 620 }}>
              <DocumentGraphView documentId={selectedDocId} orgId={orgId} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
