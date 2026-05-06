'use client'
import { Star, RefreshCw, Play, CheckCircle, GitBranch, Loader2, ExternalLink, Cpu, Brain, Database, Shield, Users, BookOpen, BarChart2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { clsx } from 'clsx'

// ─── Agent registry ───────────────────────────────────────────────────────────

type AgentEntry = {
  slug: string
  name: string
  description: string
  category: string
  icon: React.ElementType
  tier: 'L4 Orchestrator' | 'L5 Cognitive' | 'L5 Specialist' | 'Utility'
  hasFlow: boolean
  engines?: string[]
}

const ALL_AGENTS: AgentEntry[] = [
  // ── L4 Orchestrator
  {
    slug: 'l4-super-agent',
    name: 'L4 Super Agent Orchestrator',
    description: '8-engine cognitive orchestrator: Intent Understanding, Task Decomposition, Reputation-Weighted Routing, Risk-Based Planning, Cost Optimisation, Confidence Orchestration, Recovery/Retry cascade, and Pre-Execution Gate.',
    category: 'Orchestration',
    icon: Cpu,
    tier: 'L4 Orchestrator',
    hasFlow: true,
    engines: ['L4.E1 Intent', 'L4.E2 Decompose', 'L4.E3 Route', 'L4.E4 Risk', 'L4.E5 Cost', 'L4.E6 Confidence', 'L4.E7 Retry', 'L4.E8 Gate'],
  },
  // ── L5 Cognitive
  {
    slug: 'protocol-usdm-cognitive',
    name: 'Protocol → USDM Cognitive Agent',
    description: '4-capability L5 cognitive agent: Section Parsing, Eligibility Extraction, Schedule Recognition, Feasibility Comparison. 7 inline evaluators (E11-E17), 5-level retry tree, self-learning memory write-back after every run.',
    category: 'Protocol',
    icon: Brain,
    tier: 'L5 Cognitive',
    hasFlow: true,
    engines: ['S1 Parse', 'S2 Eligibility', 'S3 Schedule', 'S4 Feasibility', 'E11-E17 Eval', 'E18 Retry', 'E8-E10 Memory'],
  },
  // ── L5 Specialists
  {
    slug: 'protocol-usdm-converter',
    name: 'Protocol → USDM Converter',
    description: 'Converts clinical trial protocol documents into USDM v4.0 JSON using the USDM IG from the knowledge graph. Includes HITL review step.',
    category: 'Protocol',
    icon: BookOpen,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  {
    slug: 'ich-m11-validator',
    name: 'ICH M11 Validator',
    description: 'Validates protocol documents against the ICH M11 CeSHarP 14-section template. Identifies gaps and generates a compliance scorecard.',
    category: 'Protocol',
    icon: Shield,
    tier: 'L5 Specialist',
    hasFlow: true,
  },
  {
    slug: 'protocol-ich-m11-converter',
    name: 'Protocol → ICH M11 Converter',
    description: 'Transforms existing protocols into ICH M11 CeSHarP format. Maps source content to all 14 mandatory sections with medical writing rewrite.',
    category: 'Protocol',
    icon: BookOpen,
    tier: 'L5 Specialist',
    hasFlow: true,
  },
  {
    slug: 'protocol-intelligence',
    name: 'Protocol Intelligence',
    description: 'Classifies endpoints, codes eligibility criteria with SNOMED CT, detects protocol design gaps, and benchmarks against similar trials.',
    category: 'Protocol',
    icon: Brain,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  {
    slug: 'study-design-extractor',
    name: 'Study Design Extractor',
    description: 'Parses USDM documents and extracts structured study design elements (arms, epochs, activities) into the study graph.',
    category: 'Protocol',
    icon: GitBranch,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  {
    slug: 'standards-mapping',
    name: 'Standards Mapping',
    description: 'Maps source EDC columns to SDTM variables using deterministic rules first, LLM fallback for unmatched columns, with confidence-gated HITL review.',
    category: 'Data',
    icon: Database,
    tier: 'L5 Specialist',
    hasFlow: true,
  },
  {
    slug: 'sdtm-conformance-checker',
    name: 'SDTM Conformance Checker',
    description: 'Validates SDTM datasets against CDISC SDTM IG rules: domain structure, required variables, controlled terminology, and cross-domain consistency.',
    category: 'Data',
    icon: Database,
    tier: 'L5 Specialist',
    hasFlow: true,
  },
  {
    slug: 'crf-generation',
    name: 'CRF Generation',
    description: 'Generates CDASH-annotated CRF field specifications with SDTM traceability from study activities and protocol schedule.',
    category: 'Data',
    icon: Database,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  {
    slug: 'compliance',
    name: 'Compliance Agent',
    description: 'Validates outputs against FDA/EMA/ICH regulatory requirements. Applies decision memory to handle known exceptions consistently.',
    category: 'Regulatory',
    icon: Shield,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  {
    slug: 'writing',
    name: 'Clinical Writing Agent',
    description: 'Generates CSR synopsis, adverse event narratives, and variable documentation using procedural memory and prior approved templates.',
    category: 'Clinical',
    icon: BookOpen,
    tier: 'L5 Specialist',
    hasFlow: false,
  },
  // ── Utility
  {
    slug: 'evaluator',
    name: 'Evaluator',
    description: '6-dimension quality scoring in parallel: accuracy, compliance, hallucination detection, readability, consistency, completeness. Produces a weighted composite score.',
    category: 'Quality',
    icon: BarChart2,
    tier: 'Utility',
    hasFlow: true,
  },
  {
    slug: 'hitl-coordinator',
    name: 'HITL Coordinator',
    description: 'Routes approval requests to reviewers by domain expertise. Sets SLA deadlines (critical 4h / standard 24h / low 72h) and triggers adaptive learning after resolution.',
    category: 'Workflow',
    icon: Users,
    tier: 'Utility',
    hasFlow: true,
  },
  {
    slug: 'adaptive-learning',
    name: 'Adaptive Learning',
    description: 'Post-HITL learning extraction. Diffs agent outputs vs reviewer corrections, classifies gold patterns and anti-patterns, updates agent reputation via EMA.',
    category: 'Learning',
    icon: Brain,
    tier: 'Utility',
    hasFlow: true,
  },
  {
    slug: 'missing-data-sweeper',
    name: 'Missing Data Sweeper',
    description: 'Scans clinical datasets for missing values and out-of-range entries. Generates targeted data clarification forms (DCFs) and tracks resolution status.',
    category: 'Data',
    icon: Database,
    tier: 'Utility',
    hasFlow: false,
  },
  {
    slug: 'query-rate-monitor',
    name: 'Query Rate Monitor',
    description: 'Monitors open data query (DCF) rates by site and domain. Alerts on query rate spikes and predicts query backlog based on historical patterns.',
    category: 'Operations',
    icon: Zap,
    tier: 'Utility',
    hasFlow: false,
  },
]

const TIER_ORDER = ['L4 Orchestrator', 'L5 Cognitive', 'L5 Specialist', 'Utility'] as const
const TIER_STYLE: Record<string, { border: string; header: string; badge: string }> = {
  'L4 Orchestrator': { border: 'border-violet-200',  header: 'text-violet-800 bg-violet-50',  badge: 'bg-violet-100 text-violet-700' },
  'L5 Cognitive':    { border: 'border-brand-200',   header: 'text-brand-800 bg-brand-50',    badge: 'bg-brand-100 text-brand-700' },
  'L5 Specialist':   { border: 'border-emerald-200', header: 'text-emerald-800 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700' },
  'Utility':         { border: 'border-slate-200',   header: 'text-slate-700 bg-slate-50',    badge: 'bg-slate-100 text-slate-600' },
}

const CATEGORY_COLORS: Record<string, string> = {
  Orchestration: 'bg-violet-100 text-violet-700',
  Protocol:      'bg-blue-100 text-blue-700',
  Data:          'bg-green-100 text-green-700',
  Regulatory:    'bg-purple-100 text-purple-700',
  Clinical:      'bg-orange-100 text-orange-700',
  Quality:       'bg-yellow-100 text-yellow-700',
  Workflow:      'bg-pink-100 text-pink-700',
  Learning:      'bg-indigo-100 text-indigo-700',
  Operations:    'bg-cyan-100 text-cyan-700',
}

interface AgentInstallation {
  id: string
  agent_slug: string
  last_run_at?: string
  avg_confidence?: number
  total_runs?: number
}

function AgentCard({ agent, install, onLaunch, launching }: {
  agent: AgentEntry
  install?: AgentInstallation
  onLaunch: (slug: string) => void
  launching: string | null
}) {
  const Icon = agent.icon
  const style = TIER_STYLE[agent.tier]
  const isLaunching = launching === agent.slug

  return (
    <div className={clsx('bg-white border rounded-xl p-4 hover:shadow-sm transition-shadow flex flex-col gap-3', style.border)}>
      <div className="flex items-start gap-3">
        <div className={clsx('w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0', TIER_STYLE[agent.tier].header)}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-slate-900 text-sm leading-tight">{agent.name}</h3>
            {agent.hasFlow && (
              <span className="text-[10px] bg-brand-50 text-brand-600 border border-brand-100 px-1.5 py-0.5 rounded font-medium">FLOW</span>
            )}
          </div>
          <span className={clsx('inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium', CATEGORY_COLORS[agent.category] || 'bg-slate-100 text-slate-600')}>
            {agent.category}
          </span>
        </div>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed flex-1">{agent.description}</p>

      {agent.engines && (
        <div className="flex flex-wrap gap-1">
          {agent.engines.map(e => (
            <span key={e} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">{e}</span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-slate-100">
        <div className="text-xs text-slate-400">
          {install ? (
            <span>
              {install.total_runs || 0} run{(install.total_runs ?? 0) !== 1 ? 's' : ''}
              {install.avg_confidence ? ` · ${Math.round(install.avg_confidence * 100)}% avg` : ''}
            </span>
          ) : 'No runs yet'}
        </div>
        <div className="flex items-center gap-1.5">
          {agent.hasFlow && (
            <Link
              href={`/agents/flow-view/${agent.slug}`}
              className="flex items-center gap-1 px-2.5 py-1.5 border border-brand-200 text-brand-700 text-xs rounded-lg hover:bg-brand-50 transition-colors"
            >
              <GitBranch className="w-3 h-3" /> View Flow
            </Link>
          )}
          <button
            onClick={() => onLaunch(agent.slug)}
            disabled={isLaunching}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-brand-600 text-white text-xs rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {isLaunching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Launch
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SpecialistsPage() {
  const [installations, setInstallations] = useState<AgentInstallation[]>([])
  const [launching, setLaunching] = useState<string | null>(null)
  const [launched, setLaunched] = useState<Record<string, boolean>>({})
  const [filterTier, setFilterTier] = useState<string>('all')

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  useEffect(() => { fetchInstallations() }, [])

  const fetchInstallations = async () => {
    try {
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || '') : ''
      const res = await fetch(`${runtimeUrl}/agents?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setInstallations(data.agents || data.installations || [])
      }
    } catch { /* non-fatal */ }
  }

  const launchAgent = async (slug: string) => {
    setLaunching(slug)
    try {
      const orgId   = typeof window !== 'undefined' ? (localStorage.getItem('org_id')   || '') : ''
      const studyId = typeof window !== 'undefined' ? (localStorage.getItem('study_id') || '') : ''
      const superAgentUrl = process.env.NEXT_PUBLIC_SUPER_AGENT_URL || 'http://localhost:8015'

      // protocol-usdm-cognitive and l4-super-agent both go via L4 /orchestrate
      const isUsdmAgent = slug === 'protocol-usdm-cognitive' || slug === 'l4-super-agent'
      if (isUsdmAgent) {
        const intentBody = slug === 'protocol-usdm-cognitive'
          ? { intent: 'convert protocol to USDM', intent_text: 'convert protocol to USDM',
              org_id: orgId, study_id: studyId, preferred_agent: 'protocol-usdm-cognitive' }
          : { intent: 'Manual launch from Agent Gallery', org_id: orgId, study_id: studyId }
        const res = await fetch(`${superAgentUrl}/orchestrate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(intentBody),
        })
        if (res.ok) setLaunched(prev => ({ ...prev, [slug]: true }))
      } else {
        // All other agents launch directly via agent-runtime
        const res = await fetch(`${runtimeUrl}/runs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_slug: slug, org_id: orgId, study_id: studyId,
            input_context: { trigger_type: 'manual_launch' } }),
        })
        if (res.ok) setLaunched(prev => ({ ...prev, [slug]: true }))
      }
    } catch { /* non-fatal */ } finally { setLaunching(null) }
  }

  const getInstall = (slug: string) => installations.find(i => i.agent_slug === slug)

  const tiersToShow = filterTier === 'all' ? TIER_ORDER : [filterTier as typeof TIER_ORDER[number]]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Star className="w-6 h-6 text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Agent Gallery</h1>
            <p className="text-sm text-slate-500">{ALL_AGENTS.length} agents across 4 tiers — click "View Flow" to inspect a visual diagram</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Tier filter */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
            {(['all', ...TIER_ORDER] as const).map(t => (
              <button
                key={t}
                onClick={() => setFilterTier(t)}
                className={clsx(
                  'px-3 py-1.5 transition-colors',
                  filterTier === t ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50',
                )}
              >
                {t === 'all' ? 'All' : t}
              </button>
            ))}
          </div>
          <button onClick={fetchInstallations} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-8">
        {tiersToShow.map(tier => {
          const agents = ALL_AGENTS.filter(a => a.tier === tier)
          const style = TIER_STYLE[tier]
          return (
            <section key={tier}>
              <div className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg mb-3 w-fit', style.header)}>
                <span className="text-xs font-bold uppercase tracking-wide">{tier}</span>
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-semibold', style.badge)}>{agents.length}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {agents.map(agent => (
                  <AgentCard
                    key={agent.slug}
                    agent={agent}
                    install={getInstall(agent.slug)}
                    onLaunch={launchAgent}
                    launching={launching}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {/* Toast for launched agents */}
      {Object.keys(launched).length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-slate-900 text-white text-sm px-4 py-3 rounded-xl shadow-xl">
          <CheckCircle className="w-4 h-4 text-green-400" />
          Agent launched — check Agent Console for run status
          <Link href="/agents" className="text-brand-300 hover:underline flex items-center gap-1 ml-1">
            Open <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  )
}
