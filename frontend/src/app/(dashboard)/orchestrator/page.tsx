'use client'
import {
  Cpu, Send, RefreshCw, CheckCircle, Clock, XCircle, AlertTriangle,
  ChevronRight, ShieldCheck, Zap, TrendingUp, DollarSign, Brain,
  BarChart2, RotateCcw, Activity, Info, ArrowRight,
} from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { clsx } from 'clsx'

// ─── Types ────────────────────────────────────────────────────────────────────

interface IntentAnalysis {
  intent_type: string
  scope: string
  tone_level: string
  complexity: string
  raw_class: string
}

interface PreExecutionGate {
  context_valid: boolean
  cost_within_budget: boolean
  predicted_confidence: number
  passed: boolean
  reason?: string
}

interface ConfidenceGate {
  confidence: number
  threshold: number
  outcome: 'auto_approved' | 'partial_review' | 'hitl_required'
}

interface RetryRecord {
  attempt: number
  action: string
  model_used?: string
  agent_used?: string
  outcome: string
}

interface PlanStep {
  step_id: string
  agent_slug: string
  agent_run_id?: string
  status: string
  depends_on: string[]
  complexity?: string
  model_selected?: string
  estimated_cost?: number
  confidence?: number
  cost_usd?: number
  tokens_used?: number
  output_summary?: string
  confidence_gate?: ConfidenceGate
  retry_history?: RetryRecord[]
}

interface EngineState {
  state: 'completed' | 'running' | 'warning' | 'failed' | 'pending' | 'idle'
  [key: string]: any
}

interface Plan {
  plan_id?: string
  id?: string
  intent_text?: string
  intent_class?: string
  status: string
  risk_level?: string
  confidence_threshold?: number
  estimated_cost_usd?: number
  total_cost_usd?: number
  model_strategy?: string
  intent_analysis?: IntentAnalysis
  pre_execution_gate?: PreExecutionGate
  steps?: PlanStep[]
  step_results?: PlanStep[]
  requires_approval?: boolean
  memory_episodes_used?: number
  created_at?: string
  engines_state?: Record<string, EngineState>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_SUPER_AGENT_URL || 'http://localhost:8015'
const RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

const COMPLEXITY_COLOR: Record<string, string> = {
  low:    'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  high:   'bg-red-100 text-red-700',
}

const RISK_COLOR: Record<string, string> = {
  low:    'text-green-700 bg-green-50 border-green-200',
  medium: 'text-amber-700 bg-amber-50 border-amber-200',
  high:   'text-red-700 bg-red-50 border-red-200',
}

const TONE_COLOR: Record<string, string> = {
  standard: 'bg-slate-100 text-slate-600',
  urgent:   'bg-red-100 text-red-700',
  formal:   'bg-indigo-100 text-indigo-700',
}

const ENGINE_META = [
  { key: 'E1_intent',     label: 'L4.E1 Intent',      icon: Brain },
  { key: 'E2_decompose',  label: 'L4.E2 Decompose',    icon: Activity },
  { key: 'E3_routing',    label: 'L4.E3 Routing',      icon: ArrowRight },
  { key: 'E4_risk',       label: 'L4.E4 Risk',         icon: ShieldCheck },
  { key: 'E5_cost',       label: 'L4.E5 Cost',         icon: DollarSign },
  { key: 'E6_confidence', label: 'L4.E6 Confidence',   icon: BarChart2 },
  { key: 'E7_retry',      label: 'L4.E7 Retry',        icon: RotateCcw },
  { key: 'E8_gate',       label: 'L4.E8 Gate',         icon: Zap },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle className="w-4 h-4 text-green-500" />
  if (status === 'running')   return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
  if (status === 'failed')    return <XCircle className="w-4 h-4 text-red-500" />
  if (status === 'awaiting_approval' || status === 'awaiting_confidence_review')
    return <AlertTriangle className="w-4 h-4 text-yellow-500" />
  if (status === 'skipped')   return <ChevronRight className="w-4 h-4 text-slate-400" />
  return <Clock className="w-4 h-4 text-slate-400" />
}

function EngineStateBadge({ state }: { state: string }) {
  const cls = {
    completed: 'bg-green-100 text-green-700',
    running:   'bg-blue-100 text-blue-700',
    warning:   'bg-amber-100 text-amber-700',
    failed:    'bg-red-100 text-red-700',
    idle:      'bg-slate-100 text-slate-400',
    pending:   'bg-slate-100 text-slate-400',
  }[state] || 'bg-slate-100 text-slate-400'
  const label = state === 'completed' ? '✓' : state === 'running' ? '⟳' :
    state === 'failed' ? '✗' : state === 'warning' ? '⚠' : '—'
  return <span className={clsx('text-xs font-bold px-1 rounded', cls)}>{label}</span>
}

function ConfidenceBadge({ gate }: { gate?: ConfidenceGate }) {
  if (!gate) return null
  const cls = {
    auto_approved:  'bg-green-100 text-green-700 border-green-200',
    partial_review: 'bg-amber-100 text-amber-700 border-amber-200',
    hitl_required:  'bg-red-100 text-red-700 border-red-200',
  }[gate.outcome] || 'bg-slate-100 text-slate-500'
  const label = {
    auto_approved:  'AUTO',
    partial_review: 'PARTIAL',
    hitl_required:  'HITL',
  }[gate.outcome] || gate.outcome.toUpperCase()
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border', cls)}>
      {(gate.confidence * 100).toFixed(0)}% ≥{(gate.threshold * 100).toFixed(0)}% <b>{label}</b>
    </span>
  )
}

function ModelBadge({ model, cost }: { model?: string; cost?: number }) {
  if (!model) return null
  const cls = model === 'gpt-4' ? 'bg-purple-100 text-purple-700' :
    model === 'gpt-3.5-turbo' ? 'bg-blue-100 text-blue-700' :
    'bg-slate-100 text-slate-600'
  return (
    <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', cls)}>
      {model}{cost !== undefined && cost > 0 ? ` $${cost.toFixed(3)}` : model === 'deterministic' ? ' $0' : ''}
    </span>
  )
}

function IntentAnalysisPanel({ analysis }: { analysis?: IntentAnalysis }) {
  if (!analysis) return (
    <div className="text-xs text-slate-400 italic">Awaiting intent analysis…</div>
  )
  return (
    <div className="grid grid-cols-2 gap-3">
      {[
        { label: 'Intent Type',  value: analysis.intent_type,  cls: 'bg-brand-50 text-brand-700' },
        { label: 'Scope',        value: analysis.scope.replace('_', ' '), cls: analysis.scope === 'full_study' ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-50 text-slate-600' },
        { label: 'Urgency',      value: analysis.tone_level,   cls: TONE_COLOR[analysis.tone_level] || 'bg-slate-50 text-slate-600' },
        { label: 'Complexity',   value: analysis.complexity,   cls: COMPLEXITY_COLOR[analysis.complexity] || 'bg-slate-50 text-slate-600' },
      ].map(({ label, value, cls }) => (
        <div key={label} className="bg-slate-50 rounded-lg p-2.5">
          <p className="text-xs text-slate-400 mb-0.5">{label}</p>
          <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded capitalize', cls)}>{value}</span>
        </div>
      ))}
    </div>
  )
}

function PreGatePanel({ gate }: { gate?: PreExecutionGate }) {
  if (!gate) return <div className="text-xs text-slate-400 italic">Gate not yet evaluated…</div>
  const checks = [
    { label: 'Context valid (agents + study found)', ok: gate.context_valid },
    { label: 'Cost within daily budget',             ok: gate.cost_within_budget },
    { label: `Predicted confidence ${gate.predicted_confidence ? (gate.predicted_confidence * 100).toFixed(0) + '%' : '—'} meets threshold`, ok: gate.passed },
  ]
  return (
    <div className="space-y-1.5">
      {checks.map(c => (
        <div key={c.label} className="flex items-center gap-2 text-xs">
          {c.ok
            ? <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
            : <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
          <span className={c.ok ? 'text-slate-700' : 'text-red-600'}>{c.label}</span>
        </div>
      ))}
      {gate.reason && (
        <p className="text-xs text-red-600 mt-1 pl-5">Reason: {gate.reason}</p>
      )}
    </div>
  )
}

function StepCard({ step, i, total }: { step: PlanStep; i: number; total: number }) {
  const [open, setOpen] = useState(false)
  const retries = step.retry_history || []
  return (
    <div className={clsx('rounded-lg border p-3 text-sm',
      step.status === 'completed' ? 'border-green-200 bg-green-50/40' :
      step.status === 'running'   ? 'border-blue-200 bg-blue-50/40' :
      step.status === 'failed'    ? 'border-red-200 bg-red-50/40' :
      'border-slate-200 bg-white')}>
      <div className="flex items-start gap-3">
        {/* Step number */}
        <div className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
          {i + 1}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusIcon status={step.status} />
            <span className="font-medium text-slate-800">{step.agent_slug}</span>
            {step.complexity && (
              <span className={clsx('text-xs px-1.5 py-0.5 rounded', COMPLEXITY_COLOR[step.complexity])}>
                {step.complexity}
              </span>
            )}
            <ModelBadge model={step.model_selected} cost={step.cost_usd ?? step.estimated_cost} />
            {step.confidence_gate && <ConfidenceBadge gate={step.confidence_gate} />}
            {retries.length > 0 && (
              <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">
                ↺ {retries.length} retr{retries.length === 1 ? 'y' : 'ies'}
              </span>
            )}
          </div>

          {/* Depends on */}
          {step.depends_on?.length > 0 && (
            <p className="text-xs text-slate-400 mt-0.5">
              depends on: {step.depends_on.join(', ')}
            </p>
          )}

          {/* Output summary */}
          {step.output_summary && (
            <p className="text-xs text-slate-500 mt-1 truncate">{step.output_summary}</p>
          )}

          {/* Retry details (expandable) */}
          {retries.length > 0 && (
            <div className="mt-1.5">
              <button onClick={() => setOpen(o => !o)} className="text-xs text-orange-600 hover:underline">
                {open ? '▲ hide retries' : '▼ show retries'}
              </button>
              {open && (
                <div className="mt-1 space-y-1 pl-2 border-l-2 border-orange-200">
                  {retries.map(r => (
                    <div key={r.attempt} className="text-xs text-slate-600">
                      <b>Attempt {r.attempt}:</b> {r.action}
                      {r.model_used && ` → model: ${r.model_used}`}
                      {r.agent_used && ` → agent: ${r.agent_used}`}
                      {' '}
                      <span className={r.outcome === 'succeeded' ? 'text-green-600' : 'text-red-600'}>
                        [{r.outcome}]
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tokens + cost */}
        {step.tokens_used !== undefined && step.tokens_used > 0 && (
          <div className="text-right shrink-0">
            <p className="text-xs text-slate-400">{step.tokens_used?.toLocaleString()} tok</p>
            {step.cost_usd !== undefined && (
              <p className="text-xs font-medium text-slate-700">${step.cost_usd.toFixed(4)}</p>
            )}
          </div>
        )}
      </div>

      {/* Arrow between steps */}
      {i < total - 1 && (
        <div className="flex justify-center mt-2">
          <ChevronRight className="w-3 h-3 text-slate-300 rotate-90" />
        </div>
      )}
    </div>
  )
}

function CostBreakdownTable({ steps }: { steps: PlanStep[] }) {
  if (!steps.length) return null
  const total = steps.reduce((s, st) => s + (st.cost_usd ?? st.estimated_cost ?? 0), 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 border-b border-slate-100">
            <th className="text-left py-1.5 pr-3">Step</th>
            <th className="text-left py-1.5 pr-3">Agent</th>
            <th className="text-left py-1.5 pr-3">Model</th>
            <th className="text-right py-1.5 pr-3">Est.</th>
            <th className="text-right py-1.5 pr-3">Actual</th>
            <th className="text-right py-1.5">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={s.step_id} className="border-b border-slate-50">
              <td className="py-1.5 pr-3 text-slate-500">{i + 1}</td>
              <td className="py-1.5 pr-3 font-medium text-slate-700">{s.agent_slug}</td>
              <td className="py-1.5 pr-3">
                <ModelBadge model={s.model_selected} />
              </td>
              <td className="py-1.5 pr-3 text-right text-slate-500">
                ${(s.estimated_cost ?? 0).toFixed(3)}
              </td>
              <td className="py-1.5 pr-3 text-right font-medium text-slate-700">
                {s.cost_usd !== undefined ? `$${s.cost_usd.toFixed(4)}` : '—'}
              </td>
              <td className="py-1.5 text-right text-slate-500">
                {s.tokens_used ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={4} className="pt-2 text-right text-slate-700">Total</td>
            <td className="pt-2 text-right text-slate-900">${total.toFixed(4)}</td>
            <td className="pt-2 text-right text-slate-500">
              {steps.reduce((s, st) => s + (st.tokens_used ?? 0), 0).toLocaleString()}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function OrchestratorPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [plans, setPlans] = useState<Plan[]>([])
  const [intent, setIntent] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'plan' | 'cost'>('plan')
  const [hitlApprovalId, setHitlApprovalId] = useState<string | null>(null)
  const [findingHitl, setFindingHitl] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const orgId = typeof window !== 'undefined'
    ? (localStorage.getItem('org_id') || '00000000-0000-0000-0000-000000000000')
    : '00000000-0000-0000-0000-000000000000'

  const fetchPlans = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${BASE_URL}/plans?org_id=${orgId}&limit=20`)
      if (res.ok) {
        const data = await res.json()
        setPlans(data.plans || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const fetchPlan = async (planId: string) => {
    const res = await fetch(`${BASE_URL}/plans/${planId}`)
    if (res.ok) {
      const data = await res.json()
      const pid = data.id || data.plan_id
      setSelectedPlan({ ...data, plan_id: pid, steps: data.step_results || data.steps || [] })
      setError(null)
    } else {
      if (res.status === 404) {
        setSelectedPlan(null)
        setError(`Plan ${planId} was not found. It may have been deleted during cleanup.`)
      }
    }
  }

  const resolveHitlApprovalForPlan = async (p: Plan | null) => {
    if (!p) {
      setHitlApprovalId(null)
      return
    }
    const awaiting = p.status === 'awaiting_approval' || p.status === 'awaiting_confidence_review'
    if (!awaiting) {
      setHitlApprovalId(null)
      return
    }
    const runIds = (p.steps || p.step_results || [])
      .map(s => s.agent_run_id)
      .filter((id): id is string => !!id)
    if (runIds.length === 0) {
      setHitlApprovalId(null)
      return
    }
    try {
      setFindingHitl(true)
      const statusOrder = ['pending', 'approved', 'rejected']
      for (const status of statusOrder) {
        const res = await fetch(`${RUNTIME_URL}/approvals/org/${orgId}?status=${status}`)
        if (!res.ok) continue
        const data = await res.json()
        const approvals = Array.isArray(data?.approvals) ? data.approvals : []
        const match = approvals.find((a: any) => runIds.includes(a?.run_id))
        if (match?.id) {
          setHitlApprovalId(match.id)
          return
        }
      }
      setHitlApprovalId(null)
    } catch {
      setHitlApprovalId(null)
    } finally {
      setFindingHitl(false)
    }
  }

  // Auto-load a specific plan when navigated to from the Protocols page (or just fetch all)
  useEffect(() => {
    const planId = searchParams.get('plan_id')
    if (planId) {
      fetchPlans()
      fetchPlan(planId)
    } else {
      fetchPlans()
    }
  }, [])

  // Poll selected plan if running
  useEffect(() => {
    if (!selectedPlan) return
    const planId = selectedPlan.plan_id || selectedPlan.id
    if (!planId) return
    const ACTIVE = ['running', 'pending', 'awaiting_approval', 'awaiting_confidence_review']
    if (!ACTIVE.includes(selectedPlan.status)) return

    pollRef.current = setInterval(() => {
      fetchPlan(planId)
      fetchPlans()
    }, 2500)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedPlan?.status, selectedPlan?.plan_id])

  useEffect(() => {
    resolveHitlApprovalForPlan(selectedPlan)
  }, [selectedPlan?.status, selectedPlan?.plan_id, selectedPlan?.steps?.length])

  const submitIntent = async () => {
    if (!intent.trim()) return
    try {
      setSubmitting(true)
      setError(null)
      const res = await fetch(`${BASE_URL}/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent_text: intent, org_id: orgId, initiated_by: 'user' }),
      })
      if (res.ok) {
        const data = await res.json()
        await fetchPlans()
        const planId = data.plan_id || data.id
        if (planId) await fetchPlan(planId)
        setIntent('')
      } else {
        const err = await res.json()
        if (err.detail?.pre_execution_gate) {
          setError(`Pre-execution gate failed: ${err.detail.pre_execution_gate.reason}`)
        } else {
          setError(err.detail || JSON.stringify(err))
        }
      }
    } catch (e: any) { setError(e.message) } finally { setSubmitting(false) }
  }

  const approvePlan = async (planId: string) => {
    await fetch(`${BASE_URL}/plans/${planId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    await fetchPlan(planId)
    await fetchPlans()
  }

  const plan = selectedPlan
  const planId = plan?.plan_id || (plan as any)?.id
  const steps = plan?.steps || plan?.step_results || []
  const analysis = plan?.intent_analysis
  const gate = plan?.pre_execution_gate
  const engines = plan?.engines_state

  const riskCls = (risk?: string) => RISK_COLOR[risk || 'low'] || 'text-slate-500 bg-slate-50 border-slate-200'

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Cpu className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Super Agent Orchestrator</h1>
          <p className="text-sm text-slate-500">L4 — 8-engine orchestration per Maxis AI Context Layer design</p>
        </div>
      </div>

      {/* Intent input */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-2">Describe what you need</label>
        <div className="flex gap-3">
          <input
            className="flex-1 px-4 py-3 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder='e.g. "Map all protocol domains to SDTM and validate conformance for the full study"'
            value={intent}
            onChange={e => setIntent(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitIntent()}
          />
          <button
            onClick={submitIntent}
            disabled={submitting || !intent.trim()}
            className="flex items-center gap-2 px-5 py-3 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {submitting ? 'Orchestrating…' : 'Orchestrate'}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <div className="grid grid-cols-4 gap-6">
        {/* Plans sidebar */}
        <div className="col-span-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800 text-sm">Recent Plans</h2>
            <button onClick={fetchPlans} className="text-xs text-brand-600 hover:text-brand-800">
              <RefreshCw className="w-3 h-3 inline" />
            </button>
          </div>
          <div className="space-y-2">
            {plans.map(p => {
              const pid = p.plan_id || (p as any).id
              const risk = p.risk_level || (p as any).plan_definition?.risk_level || 'low'
              return (
                <button
                  key={pid}
                  onClick={async () => { if (pid) await fetchPlan(pid) }}
                  className={clsx(
                    'w-full text-left p-3 rounded-xl border transition-colors',
                    (selectedPlan?.plan_id === pid || (selectedPlan as any)?.id === pid)
                      ? 'border-brand-300 bg-brand-50'
                      : 'border-slate-200 bg-white hover:bg-slate-50',
                  )}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-slate-500 truncate">
                      {p.intent_class?.replace(/_/g, ' ') || '—'}
                    </span>
                    <StatusIcon status={p.status} />
                  </div>
                  <p className="text-xs text-slate-600 truncate mt-0.5">
                    {p.intent_text || pid?.slice(0, 12) + '…'}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={clsx('text-xs px-1.5 py-0.5 rounded border font-medium', riskCls(risk))}>
                      {risk}
                    </span>
                    {p.estimated_cost_usd !== undefined && (
                      <span className="text-xs text-slate-400">
                        ${Number(p.estimated_cost_usd).toFixed(3)}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {plans.length === 0 && !loading && (
              <p className="text-xs text-slate-400 text-center py-8">No plans yet.</p>
            )}
          </div>
        </div>

        {/* Main panel */}
        <div className="col-span-3 space-y-4">
          {plan ? (
            <>
              {/* Status + approve */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusIcon status={plan.status} />
                  <div>
                    <p className="font-semibold text-slate-900 capitalize">{plan.status.replace(/_/g, ' ')}</p>
                    <p className="text-xs text-slate-500">
                      {analysis?.raw_class?.replace(/_/g, ' ')} · {planId?.slice(0, 12)}…
                      {plan.memory_episodes_used ? ` · ${plan.memory_episodes_used} memory episodes` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {plan.risk_level && (
                    <span className={clsx('text-xs px-2 py-1 rounded border font-medium', riskCls(plan.risk_level))}>
                      {plan.risk_level} risk · threshold {plan.confidence_threshold ? (plan.confidence_threshold * 100).toFixed(0) + '%' : '—'}
                    </span>
                  )}
                  {(plan.status === 'awaiting_approval' || plan.status === 'awaiting_confidence_review') && planId && (
                    <>
                      <button
                        onClick={() => router.push(hitlApprovalId ? `/agents/mapping-review/${hitlApprovalId}` : '/tasks')}
                        className="px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700"
                      >
                        {findingHitl ? 'Finding HITL…' : 'Open HITL Task'}
                      </button>
                      <button
                        onClick={() => approvePlan(planId)}
                        className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700"
                      >
                        Approve & Execute
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* L4 Engine Status Row */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">
                  L4 Engine States
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {ENGINE_META.map(({ key, label, icon: Icon }) => {
                    const eng = engines?.[key]
                    const state = eng?.state || (plan.status === 'pending' ? 'pending' : 'completed')
                    const cls = {
                      completed: 'border-green-200 bg-green-50',
                      running:   'border-blue-200 bg-blue-50',
                      warning:   'border-amber-200 bg-amber-50',
                      failed:    'border-red-200 bg-red-50',
                      idle:      'border-slate-100 bg-slate-50',
                      pending:   'border-slate-100 bg-slate-50',
                    }[state] || 'border-slate-100 bg-slate-50'
                    return (
                      <div key={key} className={clsx('rounded-lg border p-2 flex items-center gap-2', cls)}>
                        <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-700 truncate">{label}</p>
                          {key === 'E5_cost' && eng?.total_cost != null && (
                            <p className="text-xs text-slate-500">${Number(eng.total_cost).toFixed(3)}</p>
                          )}
                          {key === 'E4_risk' && eng?.risk_level && (
                            <p className="text-xs text-slate-500">{eng.risk_level} / {((eng.threshold || 0) * 100).toFixed(0)}%</p>
                          )}
                          {key === 'E6_confidence' && (
                            <p className="text-xs text-slate-500">
                              {eng?.hitl_required ? 'HITL triggered' : eng?.partial_review ? 'partial' : 'all auto'}
                            </p>
                          )}
                          {key === 'E7_retry' && (
                            <p className="text-xs text-slate-500">{eng?.retries_occurred ? 'retry occurred' : 'no retries'}</p>
                          )}
                          {key === 'E8_gate' && (
                            <p className="text-xs text-slate-500">
                              {eng?.passed ? `conf ${eng?.predicted_confidence ? (eng.predicted_confidence * 100).toFixed(0) + '%' : '✓'}` : 'BLOCKED'}
                            </p>
                          )}
                        </div>
                        <EngineStateBadge state={state} />
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Two-column: intent analysis + pre-execution gate */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">
                    L4.E1 Intent Analysis
                  </p>
                  <IntentAnalysisPanel analysis={analysis} />
                  {analysis && (
                    <p className="text-xs text-slate-400 mt-2">
                      Class: <b>{analysis.raw_class?.replace(/_/g, ' ')}</b>
                    </p>
                  )}
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">
                    L4.E8 Pre-execution Gate
                  </p>
                  <PreGatePanel gate={gate} />
                  {plan.model_strategy && (
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <p className="text-xs text-slate-500">
                        <b>L4.E5 Model strategy:</b> {plan.model_strategy}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Tabs: Execution Plan | Cost Breakdown */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex border-b border-slate-200">
                  {(['plan', 'cost'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setActiveTab(t)}
                      className={clsx(
                        'px-5 py-3 text-sm font-medium transition-colors',
                        activeTab === t
                          ? 'border-b-2 border-brand-500 text-brand-700 bg-brand-50/40'
                          : 'text-slate-500 hover:text-slate-700',
                      )}
                    >
                      {t === 'plan' ? `L4.E2 Execution Plan (${steps.length} steps)` : 'L4.E5 Cost Breakdown'}
                    </button>
                  ))}
                </div>
                <div className="p-4">
                  {activeTab === 'plan' ? (
                    steps.length > 0 ? (
                      <div className="space-y-1">
                        {steps.map((step, i) => (
                          <StepCard key={step.step_id} step={step} i={i} total={steps.length} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 text-center py-6">
                        {plan.status === 'awaiting_approval'
                          ? 'Approve the plan to begin execution.'
                          : 'Execution pending…'}
                      </p>
                    )
                  ) : (
                    <CostBreakdownTable steps={steps} />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-80 bg-slate-50 border border-slate-200 rounded-xl gap-3">
              <Cpu className="w-10 h-10 text-slate-300" />
              <p className="text-slate-400 text-sm">Submit an intent or select a plan to see all 8 engine states</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function OrchestratorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading orchestrator...</div>}>
      <OrchestratorPageInner />
    </Suspense>
  )
}
