'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/layout/AuthContext'
import {
  Plus, Loader2, Search, Filter, Download,
  CheckCircle2, XCircle, Clock, AlertCircle,
  ChevronLeft, ChevronRight, Eye, Play,
  Terminal, RefreshCw, X, ChevronDown, Columns,
} from 'lucide-react'
import { clsx } from 'clsx'

const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const STUDY_GRAPH_URL = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL || 'http://localhost:8013'
const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID || '00000000-0000-0000-0000-000000000000'
const PAGE_SIZE = 10

type Study = {
  id: string
  name: string
  protocol_number: string
  phase?: string
  therapeutic_area?: string
  status: string
}

type Conversion = {
  id: string
  study_id?: string
  protocol_doc_id?: string
  protocol_filename?: string
  name: string
  status: string
  run_id?: string
  plan_id?: string
  approval_id?: string
  confidence?: number
  eval_accuracy?: number
  eval_completeness?: number
  eval_standards?: number
  created_at: string
  updated_at?: string
}

type EnrichedConversion = Conversion & {
  study?: Study
}

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  waiting_approval:     { label: 'In Review',     cls: 'bg-amber-50 text-amber-700 border-amber-200',     icon: AlertCircle },
  waiting_cro_approval: { label: 'CRO Review',    cls: 'bg-orange-50 text-orange-700 border-orange-200',  icon: AlertCircle },
  completed:            { label: 'Completed',      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
  approved:             { label: 'Completed',      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
  failed:               { label: 'Failed',         cls: 'bg-red-50 text-red-700 border-red-200',           icon: XCircle },
  rejected:             { label: 'Rejected',       cls: 'bg-red-50 text-red-700 border-red-200',           icon: XCircle },
  running:              { label: 'Running',        cls: 'bg-blue-50 text-blue-700 border-blue-200',         icon: Loader2 },
  pending:              { label: 'Queued',         cls: 'bg-slate-50 text-slate-600 border-slate-200',      icon: Clock },
  selecting_document:   { label: 'Select Doc',     cls: 'bg-brand-50 text-brand-600 border-brand-200',     icon: Clock },
}

function statusBadge(status: string) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, cls: 'bg-slate-50 text-slate-600 border-slate-200', icon: Clock }
  const Icon = cfg.icon
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border', cfg.cls)}>
      <Icon className={clsx('w-3 h-3', status === 'running' ? 'animate-spin' : '')} />
      {cfg.label}
    </span>
  )
}

function formatDuration(createdAt: string, updatedAt?: string, status?: string): string {
  const start = new Date(createdAt).getTime()
  const end = (updatedAt && status !== 'running') ? new Date(updatedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

export default function ConversionsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID

  const [studies, setStudies] = useState<Study[]>([])
  const [conversions, setConversions] = useState<Conversion[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [showFilter, setShowFilter] = useState(false)
  const [page, setPage] = useState(1)

  const [showNew, setShowNew] = useState(false)
  const [convName, setConvName] = useState('')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => { load() }, [orgId])

  async function load() {
    setLoading(true)
    try {
      const [studiesRes, convsRes] = await Promise.all([
        fetch(`${STUDY_GRAPH_URL}/studies?org_id=${orgId}`).then(r => r.json()).catch(() => ({ studies: [] })),
        fetch(`${AGENT_RUNTIME_URL}/usdm?org_id=${orgId}`).then(r => r.json()).catch(() => []),
      ])
      setStudies(studiesRes.studies || [])
      setConversions(Array.isArray(convsRes) ? convsRes : [])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  const studyMap = useMemo(() => {
    const m: Record<string, Study> = {}
    studies.forEach(s => { m[s.id] = s })
    return m
  }, [studies])

  const enriched: EnrichedConversion[] = useMemo(() =>
    conversions.map(c => ({ ...c, study: c.study_id ? studyMap[c.study_id] : undefined })),
    [conversions, studyMap]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return enriched.filter(c => {
      if (statusFilter && c.status !== statusFilter) return false
      if (!q) return true
      const study = c.study
      return (
        (study?.protocol_number ?? '').toLowerCase().includes(q) ||
        (study?.name ?? '').toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.status.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      )
    })
  }, [enriched, search, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function showToast(msg: string) {
    setToast(msg); setTimeout(() => setToast(''), 3000)
  }

  async function createDraft() {
    if (!convName.trim()) return
    setCreating(true)
    try {
      const data = await gql(`
        mutation($orgId: String!, $name: String!, $createdBy: String) {
          createUsdmDraft(orgId: $orgId, name: $name, createdBy: $createdBy) { id }
        }
      `, { orgId, name: convName.trim(), createdBy: user?.id })
      setShowNew(false)
      setConvName('')
      router.push(`/usdm/${data.createUsdmDraft.id}`)
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setCreating(false)
    }
  }

  const isQueued = (status: string) => ['pending', 'selecting_document'].includes(status)
  const isActive = (status: string) => ['waiting_approval', 'waiting_cro_approval', 'running'].includes(status)
  const isDone = (status: string) => ['completed', 'approved'].includes(status)
  const isFailed = (status: string) => ['failed', 'rejected'].includes(status)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Conversions</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Protocol → USDM v4 conversion runs, quality scores, and review status
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Conversion
          </button>
        </div>
      </div>

      {/* Table card */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Search by study ID, title, status…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-300 bg-slate-50"
            />
          </div>

          {/* Status filter */}
          <div className="relative">
            <button
              onClick={() => setShowFilter(v => !v)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors',
                statusFilter
                  ? 'border-brand-300 bg-brand-50 text-brand-600'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              <Filter className="w-3.5 h-3.5" />
              Filter
              {statusFilter && <span className="text-xs bg-brand-500 text-white rounded-full px-1.5">1</span>}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showFilter && (
              <div className="absolute top-full left-0 mt-1 w-44 bg-white border border-slate-200 rounded-xl shadow-lg z-20 py-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-3 pt-1 pb-0.5">Status</p>
                {[
                  { value: '', label: 'All statuses' },
                  { value: 'waiting_approval', label: 'In Review' },
                  { value: 'running', label: 'Running' },
                  { value: 'completed', label: 'Completed' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'pending', label: 'Queued' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setStatusFilter(opt.value); setShowFilter(false); setPage(1) }}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50',
                      statusFilter === opt.value ? 'text-brand-600 font-medium' : 'text-slate-700',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>

          {statusFilter && (
            <button
              onClick={() => setStatusFilter('')}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center h-48 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading conversions…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <p className="text-sm font-medium">{search || statusFilter ? 'No matching conversions' : 'No conversions yet'}</p>
            {!search && !statusFilter && (
              <button onClick={() => setShowNew(true)} className="mt-2 text-sm text-brand-500 hover:text-brand-700 font-medium">
                Start your first conversion →
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/60">
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-4 py-2.5">Study ID</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Title</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Phase · TA</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Status</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Conversion ID</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Duration</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Model</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Score</th>
                  <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {pageItems.map(c => {
                  const study = c.study
                  const queued = isQueued(c.status)
                  const confidence = c.confidence != null ? Math.round(c.confidence * 100) : null

                  return (
                    <tr
                      key={c.id}
                      onClick={() => router.push(`/usdm/${c.id}`)}
                      className="hover:bg-slate-50/70 cursor-pointer transition-colors group"
                    >
                      {/* Study ID */}
                      <td className="px-4 py-3 align-middle">
                        {study?.protocol_number ? (
                          <span className="font-mono text-xs bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                            {study.protocol_number}
                          </span>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>

                      {/* Title */}
                      <td className="px-3 py-3 align-middle max-w-[220px]">
                        <p className="text-slate-800 font-medium text-[13px] truncate" title={study?.name ?? c.name}>
                          {study?.name ?? c.name}
                        </p>
                        {study?.name && c.name !== study.name && (
                          <p className="text-[11px] text-slate-400 truncate mt-0.5">{c.name}</p>
                        )}
                      </td>

                      {/* Phase · TA */}
                      <td className="px-3 py-3 align-middle">
                        <div className="flex flex-wrap gap-1">
                          {study?.phase ? (
                            <span className="text-[11px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                              {study.phase}
                            </span>
                          ) : null}
                          {study?.therapeutic_area ? (
                            <span className="text-[11px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded font-medium">
                              {study.therapeutic_area}
                            </span>
                          ) : null}
                          {!study?.phase && !study?.therapeutic_area && (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-3 py-3 align-middle">
                        {statusBadge(c.status)}
                      </td>

                      {/* Conversion ID */}
                      <td className="px-3 py-3 align-middle">
                        {queued ? (
                          <span className="text-slate-300 text-xs">—</span>
                        ) : (
                          <span className="font-mono text-[11px] text-slate-500">{shortId(c.id)}</span>
                        )}
                      </td>

                      {/* Duration */}
                      <td className="px-3 py-3 align-middle text-[12px] text-slate-600 tabular-nums">
                        {queued ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          formatDuration(c.created_at, c.updated_at, c.status)
                        )}
                      </td>

                      {/* Model */}
                      <td className="px-3 py-3 align-middle">
                        {queued ? (
                          <span className="text-slate-300 text-xs">—</span>
                        ) : (
                          <span className="font-mono text-[11px] text-slate-500">Sonnet 4.6</span>
                        )}
                      </td>

                      {/* Score / Fields */}
                      <td className="px-3 py-3 align-middle text-[12px]">
                        {confidence != null ? (
                          <span className={clsx(
                            'font-semibold tabular-nums',
                            confidence >= 85 ? 'text-emerald-600' :
                            confidence >= 70 ? 'text-amber-600' : 'text-red-600',
                          )}>
                            {confidence}%
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3 align-middle" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          {isActive(c.status) && (
                            <button
                              onClick={() => router.push(`/usdm/${c.id}/workbench`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              Review
                            </button>
                          )}
                          {isDone(c.status) && (
                            <button
                              onClick={() => router.push(`/usdm/${c.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              View
                            </button>
                          )}
                          {isFailed(c.status) && (
                            <button
                              onClick={() => router.push(`/usdm/${c.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              Investigate
                            </button>
                          )}
                          {queued && (
                            <button
                              onClick={() => router.push(`/usdm/${c.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-brand-500 text-white hover:bg-brand-600 transition-colors"
                            >
                              <Play className="w-3 h-3" />
                              Start
                            </button>
                          )}
                          {c.run_id && (
                            <button
                              onClick={() => router.push(`/protocols/observe/${c.run_id}`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
                              title="Observe run"
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
                            </button>
                          )}
                          {c.plan_id && (
                            <button
                              onClick={() => router.push(`/orchestrator?plan_id=${c.plan_id}`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
                              title="Agent console"
                            >
                              <Terminal className="w-3 h-3" />
                            </button>
                          )}
                          {c.run_id && !isQueued(c.status) && (
                            <button
                              onClick={() => router.push(`/usdm/${c.id}/workbench`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
                              title="Open Workbench"
                            >
                              <Columns className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && filtered.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500">
            <span>
              {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} conversion{filtered.length !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).filter(n =>
                n === 1 || n === totalPages || Math.abs(n - currentPage) <= 1
              ).map((n, idx, arr) => (
                <>
                  {idx > 0 && arr[idx - 1] !== n - 1 && (
                    <span key={`ellipsis-${n}`} className="px-1 text-slate-300">…</span>
                  )}
                  <button
                    key={n}
                    onClick={() => setPage(n)}
                    className={clsx(
                      'w-7 h-7 flex items-center justify-center rounded border text-xs font-medium transition-colors',
                      n === currentPage
                        ? 'border-brand-500 bg-brand-500 text-white'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                    )}
                  >
                    {n}
                  </button>
                </>
              ))}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* New conversion modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h3 className="font-semibold text-slate-800">New USDM Conversion</h3>
                <p className="text-xs text-slate-500 mt-0.5">Give it a name — you'll choose the protocol document next</p>
              </div>
              <button onClick={() => setShowNew(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-medium text-slate-700 mb-1">Conversion Name</label>
              <input
                value={convName}
                onChange={e => setConvName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createDraft()}
                placeholder="e.g. TRIAL-001 Phase 3 Protocol"
                autoFocus
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
              <p className="text-xs text-slate-400 mt-2">
                Next step: select an existing uploaded document or upload a new protocol file.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
                Cancel
              </button>
              <button
                onClick={createDraft}
                disabled={!convName.trim() || creating}
                className="flex items-center gap-2 px-5 py-2 text-sm bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-40 transition-colors"
              >
                {creating ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</> : <>Continue <ChevronRight className="w-4 h-4" /></>}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-slate-800 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
