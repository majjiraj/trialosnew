'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, CheckCircle, XCircle, Plus, Trash2, Edit2, Save, X,
  AlertTriangle, Info, Database, Loader2, Copy, Check, RefreshCw, Square,
} from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'
import { AgentInsightTabs } from '@/components/agent/AgentInsightTabs'

// ── Types ────────────────────────────────────────────────────────────────────

interface MappingEntry {
  source_file: string
  source_column: string
  sdtm_variable: string
  sdtm_label: string
  derivation_type: 'direct_copy' | 'derived' | 'constant' | 'algorithm' | 'computed'
  derivation_rule: string
  formula: string
  confidence: number
  notes: string
}

interface DomainSpec {
  mappings: MappingEntry[]
  unmapped_columns: string[]
  missing_required_vars: string[]
  suggested_constants: Record<string, string>
}

interface ValidationIssue {
  domain: string
  level: 'error' | 'warning'
  type: string
  message: string
}

interface ValidationReport {
  issues: ValidationIssue[]
  domain_summaries: Record<string, {
    total_mappings: number
    required_vars_total: number
    required_vars_mapped: number
    required_vars_missing: number
    completeness_pct: number
    low_confidence_mappings: string[]
  }>
  error_count: number
  warning_count: number
  validation_passed: boolean
  overall_completeness_pct: number
}

interface CombinedSpec {
  domains: Record<string, DomainSpec>
  source_files?: (string | { filename: string; doc_id?: string; s3_key?: string })[]
  validation_report?: ValidationReport
}

interface ApprovalRequest {
  id: string
  runId: string
  orgId: string
  studyId?: string
  title: string
  description?: string
  proposedAction: CombinedSpec
  status: string
  createdAt: string
}

function isCombinedSpecPayload(payload: unknown): payload is CombinedSpec {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as { domains?: unknown }
  return !!candidate.domains && typeof candidate.domains === 'object' && !Array.isArray(candidate.domains)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const getToken = () =>
  decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const url = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

function confidenceColor(conf: number) {
  if (conf >= 90) return 'bg-green-100 text-green-700'
  if (conf >= 70) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

const DERIVATION_TYPES = ['direct_copy', 'derived', 'constant', 'algorithm', 'computed'] as const

// ── Blank row factory ─────────────────────────────────────────────────────────

function blankRow(): MappingEntry {
  return {
    source_file: '', source_column: '', sdtm_variable: '', sdtm_label: '',
    derivation_type: 'direct_copy', derivation_rule: '', formula: '', confidence: 70, notes: '',
  }
}

// ── Inline edit row ───────────────────────────────────────────────────────────

function EditRow({
  row, onSave, onCancel,
}: { row: MappingEntry; onSave: (r: MappingEntry) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<MappingEntry>({ ...row })
  const set = (k: keyof MappingEntry, v: unknown) => setDraft(prev => ({ ...prev, [k]: v }))
  return (
    <tr className="bg-brand-50 border-t border-brand-200">
      {(['source_file', 'source_column', 'sdtm_variable', 'sdtm_label'] as const).map(field => (
        <td key={field} className="px-3 py-2">
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
            value={draft[field]}
            onChange={e => set(field, e.target.value)}
            placeholder={field.replace(/_/g, ' ')}
          />
        </td>
      ))}
      <td className="px-3 py-2">
        <select
          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
          value={draft.derivation_type}
          onChange={e => set('derivation_type', e.target.value)}
        >
          {DERIVATION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td className="px-3 py-2">
        {draft.derivation_type === 'computed' ? (
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-400"
            value={draft.formula}
            onChange={e => set('formula', e.target.value)}
            placeholder="=CONCAT(A, &quot;-&quot;, B)"
          />
        ) : (
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
            value={draft.derivation_rule}
            onChange={e => set('derivation_rule', e.target.value)}
            placeholder="Rule description"
          />
        )}
      </td>
      <td className="px-3 py-2">
        <input
          type="number" min={0} max={100}
          className="w-16 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
          value={draft.confidence}
          onChange={e => set('confidence', parseInt(e.target.value) || 0)}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          <button onClick={() => onSave(draft)} className="p-1 rounded text-green-600 hover:bg-green-100">
            <Save className="w-3.5 h-3.5" />
          </button>
          <button onClick={onCancel} className="p-1 rounded text-slate-400 hover:bg-slate-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Domain tab content ────────────────────────────────────────────────────────

function DomainPanel({
  domain, spec, onChange,
}: { domain: string; spec: DomainSpec; onChange: (s: DomainSpec) => void }) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [addingNew, setAddingNew] = useState(false)

  const updateRow = (idx: number, row: MappingEntry) => {
    const next = [...spec.mappings]
    next[idx] = row
    onChange({ ...spec, mappings: next })
    setEditingIdx(null)
  }

  const deleteRow = (idx: number) => {
    const next = spec.mappings.filter((_, i) => i !== idx)
    // Move deleted variable to unmapped if it had a source column
    const deleted = spec.mappings[idx]
    const unmapped = deleted.source_column
      ? [...spec.unmapped_columns, deleted.source_column]
      : spec.unmapped_columns
    onChange({ ...spec, mappings: next, unmapped_columns: unmapped })
  }

  const addRow = (row: MappingEntry) => {
    onChange({ ...spec, mappings: [...spec.mappings, row] })
    setAddingNew(false)
  }

  return (
    <div className="space-y-6">
      {/* Mapped Variables */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Mapped Variables ({spec.mappings.length})</h3>
          <button
            onClick={() => { setAddingNew(true); setEditingIdx(null) }}
            className="flex items-center gap-1 px-2.5 py-1 bg-brand-50 text-brand-700 border border-brand-200 rounded-lg text-xs hover:bg-brand-100"
          >
            <Plus className="w-3 h-3" /> Add Mapping
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <th className="px-3 py-2 text-left font-medium">Source File</th>
                <th className="px-3 py-2 text-left font-medium">Source Column</th>
                <th className="px-3 py-2 text-left font-medium">SDTM Variable</th>
                <th className="px-3 py-2 text-left font-medium">Label</th>
                <th className="px-3 py-2 text-left font-medium">Derivation</th>
                <th className="px-3 py-2 text-left font-medium">Formula / Rule</th>
                <th className="px-3 py-2 text-left font-medium">Conf.</th>
                <th className="px-3 py-2 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {spec.mappings.map((m, idx) => (
                editingIdx === idx ? (
                  <EditRow key={idx} row={m} onSave={r => updateRow(idx, r)} onCancel={() => setEditingIdx(null)} />
                ) : (
                  <tr key={idx} className="hover:bg-slate-50 transition-colors">
                    <td className="px-3 py-2 text-slate-500">{m.source_file || '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-700">{m.source_column || '—'}</td>
                    <td className="px-3 py-2 font-semibold text-brand-700">{m.sdtm_variable}</td>
                    <td className="px-3 py-2 text-slate-600">{m.sdtm_label}</td>
                    <td className="px-3 py-2">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{m.derivation_type}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-500 max-w-xs truncate font-mono text-xs">
                      {m.derivation_type === 'computed' && m.formula ? m.formula : m.derivation_rule || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${confidenceColor(m.confidence)}`}>
                        {m.confidence}%
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button onClick={() => { setEditingIdx(idx); setAddingNew(false) }}
                          className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteRow(idx)}
                          className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
              {addingNew && (
                <EditRow row={blankRow()} onSave={addRow} onCancel={() => setAddingNew(false)} />
              )}
              {spec.mappings.length === 0 && !addingNew && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No mappings — click &quot;Add Mapping&quot; to begin</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Unmapped Columns */}
      {spec.unmapped_columns.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Info className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-slate-700">Unmapped Source Columns ({spec.unmapped_columns.length})</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {spec.unmapped_columns.map(col => (
              <span key={col} className="px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-mono">{col}</span>
            ))}
          </div>
        </div>
      )}

      {/* Missing Required Variables */}
      {spec.missing_required_vars.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-700">Missing Required Variables ({spec.missing_required_vars.length})</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {spec.missing_required_vars.map(v => (
              <span key={v} className="px-2 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded text-xs font-semibold">{v}</span>
            ))}
          </div>
        </div>
      )}

      {/* Constants */}
      {Object.keys(spec.suggested_constants).length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Constants</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Object.entries(spec.suggested_constants).map(([k, v]) => (
              <div key={k} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-xs">
                <span className="font-semibold text-slate-600">{k}</span>
                <span className="text-slate-400 mx-1">=</span>
                <span className="font-mono text-slate-700">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function MappingReviewContent() {
  const { approvalId } = useParams<{ approvalId: string }>()
  const router = useRouter()
  const { user } = useAuth()
  const orgId = useOrgId()

  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [spec, setSpec] = useState<CombinedSpec | null>(null)
  const [rawApprovedPayload, setRawApprovedPayload] = useState<Record<string, unknown> | null>(null)
  const [isDomainSpec, setIsDomainSpec] = useState(true)
  const [activeDomain, setActiveDomain] = useState<string>('')
  const [showValidation, setShowValidation] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRejectDialog, setShowRejectDialog] = useState(false)
  const [rejectNote, setRejectNote] = useState('')

  useEffect(() => {
    if (!approvalId) return
    gql(`query($id: ID!) {
      approvalRequest(id: $id) {
        id runId orgId studyId title description proposedAction status createdAt
      }
    }`, { id: approvalId })
      .then(data => {
        const a = data?.approvalRequest
        if (!a) { setError('Approval request not found'); return }
        setApproval(a)
        // Normalise to multi-domain format
        // proposedAction may come back as a JSON string if stored double-encoded in DB
        const parsed = typeof a.proposedAction === 'string'
          ? JSON.parse(a.proposedAction)
          : a.proposedAction
        const payload = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}

        let combinedSpec: CombinedSpec | null = null

        if (isCombinedSpecPayload(payload)) {
          combinedSpec = payload
        } else if ((payload as { mappings?: unknown }).mappings) {
          const legacy = payload as unknown as { domain?: string; mappings: MappingEntry[]; unmapped_columns?: string[]; missing_required_vars?: string[]; suggested_constants?: Record<string, string> }
          const domain = legacy.domain || 'XX'
          combinedSpec = {
            domains: {
              [domain]: {
                mappings: legacy.mappings,
                unmapped_columns: legacy.unmapped_columns ?? [],
                missing_required_vars: legacy.missing_required_vars ?? [],
                suggested_constants: legacy.suggested_constants ?? {},
              }
            },
            source_files: [],
          }
        }

        if (combinedSpec) {
          setIsDomainSpec(true)
          setRawApprovedPayload(null)
          setSpec(combinedSpec)
          setActiveDomain(Object.keys(combinedSpec.domains || {})[0] || '')
        } else {
          // Some approvals (e.g., USDM JSON reviews) are not domain-mapping payloads.
          // Keep payload for approve/reject submission and render a read-only JSON view.
          setIsDomainSpec(false)
          setRawApprovedPayload(payload)
          setSpec({ domains: {}, source_files: [] })
          setActiveDomain('')
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [approvalId])

  const updateDomainSpec = useCallback((domain: string, domainSpec: DomainSpec) => {
    setSpec(prev => prev ? { ...prev, domains: { ...prev.domains, [domain]: domainSpec } } : prev)
  }, [])

  const totalMappings = spec?.domains ? Object.values(spec.domains).reduce((s, d) => s + (d.mappings?.length ?? 0), 0) : 0
  const totalMissing = spec?.domains ? Object.values(spec.domains).reduce((s, d) => s + (d.missing_required_vars?.length ?? 0), 0) : 0

  const handleDecision = async (decision: 'approved' | 'rejected', restart = false) => {
    if (!approval || !spec || !user) return
    setSubmitting(true)
    setShowRejectDialog(false)
    try {
      await gql(`mutation($runId: String!, $approvalId: String!, $decision: String!, $modifiedSpec: JSON, $decidedBy: String!, $note: String, $restart: Boolean) {
        resumeAgentRun(runId: $runId, approvalId: $approvalId, decision: $decision, modifiedSpec: $modifiedSpec, decidedBy: $decidedBy, note: $note, restart: $restart)
      }`, {
        runId: approval.runId,
        approvalId: approval.id,
        decision,
        modifiedSpec: decision === 'approved'
          ? (isDomainSpec ? spec : (rawApprovedPayload || spec))
          : null,
        decidedBy: user.id,
        note: rejectNote,
        restart,
      })
      if (decision === 'approved' || restart) {
        router.push(`/agents/runs/${approval.runId}`)
      } else {
        router.push('/tasks')
      }
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  const copyRunId = () => {
    if (!approval) return
    navigator.clipboard.writeText(approval.runId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
      </div>
    )
  }

  if (error || !approval || !spec) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
          {error || 'Failed to load mapping review'}
        </div>
      </div>
    )
  }

  const domains = Object.keys(spec?.domains || {})

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button onClick={() => router.push('/tasks')}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
            <ArrowLeft className="w-4 h-4" /> Back to Tasks
          </button>
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-brand-500" />
            <h1 className="text-2xl font-bold text-slate-900">{approval.title}</h1>
          </div>
          {approval.description && (
            <p className="text-slate-500 text-sm mt-1">{approval.description}</p>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => setShowRejectDialog(true)}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>
          <button
            onClick={() => handleDecision('approved')}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Approve & Generate
          </button>
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
        <span className="font-medium text-slate-700">Domains: <span className="text-brand-600">{domains.join(', ')}</span></span>
        <span>Total mappings: <span className="font-semibold text-slate-700">{totalMappings}</span></span>
        {totalMissing > 0 && (
          <span className="text-amber-600 font-medium flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> {totalMissing} missing required vars
          </span>
        )}
        {spec.source_files?.length ? (
          <span>Source files: {spec.source_files.map(f => typeof f === 'string' ? f : f.filename).join(', ')}</span>
        ) : null}
        <button onClick={copyRunId} className="flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-slate-600">
          Run: {approval.runId.slice(0, 8)}...
          {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>

      {/* Domain tabs + Validation tab */}
      <div>
        <div className="flex gap-1 border-b border-slate-200 mb-6">
          {domains.map(domain => {
            const domainSpec = spec.domains[domain]
            const hasMissing = domainSpec.missing_required_vars.length > 0
            return (
              <button
                key={domain}
                onClick={() => { setActiveDomain(domain); setShowValidation(false) }}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                  activeDomain === domain && !showValidation
                    ? 'border-brand-500 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {domain}
                <span className="text-xs bg-slate-100 text-slate-500 rounded px-1.5">
                  {domainSpec.mappings.length}
                </span>
                {hasMissing && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
              </button>
            )
          })}
          {spec.validation_report && (
            <button
              onClick={() => setShowValidation(v => !v)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ml-auto ${
                showValidation
                  ? 'border-brand-500 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              Validation
              {spec.validation_report.error_count > 0 ? (
                <span className="text-xs bg-red-100 text-red-600 rounded px-1.5 font-semibold">
                  {spec.validation_report.error_count} error{spec.validation_report.error_count !== 1 ? 's' : ''}
                </span>
              ) : spec.validation_report.warning_count > 0 ? (
                <span className="text-xs bg-amber-100 text-amber-600 rounded px-1.5">
                  {spec.validation_report.warning_count} warn
                </span>
              ) : (
                <span className="text-xs bg-green-100 text-green-600 rounded px-1.5">✓ passed</span>
              )}
            </button>
          )}
        </div>

        {showValidation && spec.validation_report ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className={`rounded-xl border px-4 py-3 ${spec.validation_report.validation_passed ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                <div className="text-xs text-slate-500 mb-1">Status</div>
                <div className={`text-sm font-semibold ${spec.validation_report.validation_passed ? 'text-green-700' : 'text-red-700'}`}>
                  {spec.validation_report.validation_passed ? '✓ Passed' : '✗ Has Errors'}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500 mb-1">Completeness</div>
                <div className="text-sm font-semibold text-slate-700">{spec.validation_report.overall_completeness_pct}%</div>
              </div>
              <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                <div className="text-xs text-slate-500 mb-1">Errors</div>
                <div className="text-sm font-semibold text-red-700">{spec.validation_report.error_count}</div>
              </div>
              <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3">
                <div className="text-xs text-slate-500 mb-1">Warnings</div>
                <div className="text-sm font-semibold text-amber-700">{spec.validation_report.warning_count}</div>
              </div>
            </div>
            {/* Per-domain summaries */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {Object.entries(spec.validation_report.domain_summaries || {}).map(([domain, ds]) => (
                <div key={domain} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  <div className="font-semibold text-slate-700 mb-2">{domain}</div>
                  <div className="flex justify-between text-xs text-slate-500"><span>Mappings</span><span className="font-medium text-slate-700">{ds.total_mappings}</span></div>
                  <div className="flex justify-between text-xs text-slate-500"><span>Required vars covered</span><span className="font-medium text-slate-700">{ds.required_vars_mapped}/{ds.required_vars_total}</span></div>
                  <div className="flex justify-between text-xs text-slate-500"><span>Completeness</span><span className={`font-medium ${ds.completeness_pct >= 80 ? 'text-green-600' : ds.completeness_pct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{ds.completeness_pct}%</span></div>
                  {ds.low_confidence_mappings.length > 0 && (
                    <div className="mt-2 text-xs text-amber-600">⚠ Low confidence: {ds.low_confidence_mappings.join(', ')}</div>
                  )}
                </div>
              ))}
            </div>
            {/* Issues list */}
            {spec.validation_report.issues.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-sm font-medium text-slate-700">
                  Issues ({spec.validation_report.issues.length})
                </div>
                <ul className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                  {spec.validation_report.issues.map((issue, i) => (
                    <li key={i} className="px-4 py-2.5 flex gap-3 items-start">
                      <span className={`mt-0.5 text-xs font-semibold px-2 py-0.5 rounded ${issue.level === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {issue.level}
                      </span>
                      <span className="text-xs text-slate-600">{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : !isDomainSpec ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-700 font-medium">Review Payload</p>
              <p className="text-xs text-slate-500 mt-1">This approval contains structured JSON (not SDTM domain mappings). You can still approve or reject from this page.</p>
            </div>
            <pre className="text-xs bg-slate-900 text-slate-100 rounded-xl p-4 overflow-auto max-h-[32rem] border border-slate-700">
              {JSON.stringify(rawApprovedPayload || {}, null, 2)}
            </pre>
          </div>
        ) : (
          activeDomain && spec.domains[activeDomain] && (
            <DomainPanel
              domain={activeDomain}
              spec={spec.domains[activeDomain]}
              onChange={ds => updateDomainSpec(activeDomain, ds)}
            />
          )
        )}
      </div>

      {/* Agent Insights: Evaluation / Decision Traces / Audit Log */}
      <AgentInsightTabs
        runId={approval.runId}
        orgId={orgId || approval.orgId}
        userId={user?.id || ''}
      />

      {/* Reject dialog */}
      {showRejectDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-500" />
                <h2 className="font-semibold text-slate-900">Reject Mapping</h2>
              </div>
              <button onClick={() => setShowRejectDialog(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-600">
                What would you like to do after rejecting this mapping?
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Rejection note <span className="text-slate-400">(optional)</span>
                </label>
                <textarea
                  value={rejectNote}
                  onChange={e => setRejectNote(e.target.value)}
                  placeholder="e.g. Only one variable was mapped per domain — needs more complete coverage"
                  rows={3}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
                />
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => handleDecision('rejected', true)}
                  disabled={submitting}
                  className="flex items-center gap-3 px-4 py-3 bg-brand-50 border border-brand-200 text-brand-700 rounded-xl hover:bg-brand-100 disabled:opacity-50 text-left"
                >
                  <RefreshCw className="w-5 h-5 text-brand-500 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold">Re-generate Mapping</p>
                    <p className="text-xs text-brand-500 mt-0.5">Restart the agent from Step 1 with the same files and domains</p>
                  </div>
                </button>
                <button
                  onClick={() => handleDecision('rejected', false)}
                  disabled={submitting}
                  className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-xl hover:bg-red-100 disabled:opacity-50 text-left"
                >
                  <Square className="w-5 h-5 text-red-500 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold">Stop Task</p>
                    <p className="text-xs text-red-500 mt-0.5">Cancel this run permanently and return to the task list</p>
                  </div>
                </button>
              </div>
            </div>
            {submitting && (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Processing…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function MappingReviewPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading...</div>}>
      <MappingReviewContent />
    </Suspense>
  )
}
