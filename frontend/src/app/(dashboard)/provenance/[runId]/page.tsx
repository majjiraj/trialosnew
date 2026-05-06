'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  Shield, CheckCircle, XCircle, AlertTriangle, BookOpen,
  GitBranch, Activity, Download, Printer, ChevronDown, ChevronUp,
  FileText, Clock, User, Hash, TrendingUp, Layers, RefreshCw, MapPin,
  Info, Wrench, AlertCircle, List,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface Quality {
  verdict: string
  faithfulness_score: number | null
  hallucination_detected: boolean
  hallucination_rate: number
  reasoning_score: number | null
  task_completed: boolean
  judge_notes: string
  judge_model: string
  confidence: number | null
  branch_action: string | null
  readability_score: number | null
  readability_grade: string
  completeness_score: number | null
  completeness_grade: string
  sources_cited_count: number
  provenance_completeness?: number | null
  confidence_decomposition?: {
    digitization_accuracy?: number | null
    output_quality?: number | null
    standards_alignment?: number | null
    technical_feasibility?: number | null
    overall?: number | null
  }
}

interface Source {
  doc_name?: string
  doc_type?: string
  section?: string
  score?: number
  excerpt?: string
  chunk_id?: string
  page_number?: number | null
  query_type?: string
  is_domain_specific?: boolean
  low_relevance_flag?: boolean
  used_for?: string
  usdm_path?: string
  matched_terms?: string[]
}

interface ReasoningStep {
  step?: string | number
  action?: string
  reasoning?: string
  confidence?: number
  sources?: string[]
}

interface EvaluatorScore {
  evaluator: string
  slug: string
  category: string
  score: number | null
  verdict: string
  notes: string
  details: Record<string, unknown> | null
}

interface EvalScoreFull {
  score: number
  passed: boolean
  details: string[]
  gap_failures: string[]
}

interface QualityCheckAudit {
  check_id: string
  description: string
  status: 'pass' | 'fail' | 'auto-corrected'
  iteration_first_seen: number
  iteration_fixed: number | null
  was_autocorrected: boolean
  score_at_detection: number | null
  score_after_fix: number | null
}

interface AuditEvent {
  event_id?: string
  timestamp?: string
  actor_type?: string
  actor_id?: string
  action?: string
  resource_type?: string
  row_hash?: string
}

interface StandardsCompliance {
  usdm_score?: number | null
  ich_m11_score?: number | null
  sections_found?: number | null
  sections_total?: number | null
  missing_mandatory?: string[]
  conformant?: boolean | null
}

interface ProvenanceEntry {
  source_ich_section: string
  usdm_path: string
  char_start: number | null
  char_end: number | null
  para_index: number | null
  excerpt: string
  method: string
}

interface SectionCitation {
  score?: number
  excerpt?: string
  section?: string
  chunk_id?: string
  page_number?: number | null
  usdm_path?: string
  matched_terms?: string[]
}

interface GenerationAttempt {
  attempt: number
  passed?: boolean
  overall_score?: number
  excel_passed?: boolean
  gap_count?: number
  details?: string[]
  stage_confidence?: Record<string, number>
  gaps?: string[]
  [key: string]: unknown
}

interface GenerationLoopSummary {
  best_attempt?: number
  final_passed?: boolean
  max_attempts?: number
  final_overall?: number
  excel_feedback?: { passed: boolean; gap_count: number }
  attempts_executed?: number
  overall_progression?: number[]
}

interface ProvenanceManifest {
  run_id: string
  agent_name: string
  agent_slug: string
  agent_category: string
  study_id: string
  org_id: string
  status: string
  created_at: string
  completed_at: string
  output_summary: string
  quality: Quality
  sources_cited: Source[]
  reasoning_steps: ReasoningStep[]
  evaluator_scores: EvaluatorScore[]
  audit_events: AuditEvent[]
  standards_compliance: StandardsCompliance
  provenance_map?: Record<string, ProvenanceEntry>
  provenance_coverage?: number | null
  section_provenance?: Record<string, SectionCitation[]>
  generation_loop_history?: GenerationAttempt[]
  generation_loop_summary?: GenerationLoopSummary
  eval_scores_full?: Record<string, EvalScoreFull>
  quality_checks_audit?: QualityCheckAudit[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

const RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'text-gray-400'
  if (score >= 0.7) return 'text-green-600'
  if (score >= 0.4) return 'text-amber-500'
  return 'text-red-500'
}

function scoreBg(score: number | null | undefined): string {
  if (score == null) return 'bg-gray-100'
  if (score >= 0.7) return 'bg-green-50 border-green-200'
  if (score >= 0.4) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const map: Record<string, string> = {
    pass: 'bg-green-100 text-green-700 border-green-200',
    partial: 'bg-amber-100 text-amber-700 border-amber-200',
    fail: 'bg-red-100 text-red-700 border-red-200',
    unknown: 'bg-gray-100 text-gray-500 border-gray-200',
  }
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${map[verdict] || map.unknown}`}>
      {verdict.toUpperCase()}
    </span>
  )
}

function ScoreBar({ score, label }: { score: number | null | undefined; label: string }) {
  const pct = score != null ? Math.round(score * 100) : null
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{label}</span>
        <span className={scoreColor(score)}>{pct != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${score != null && score >= 0.7 ? 'bg-green-500' : score != null && score >= 0.4 ? 'bg-amber-400' : 'bg-red-400'}`}
          style={{ width: `${pct || 0}%` }}
        />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ProvenancePage() {
  const { runId } = useParams<{ runId: string }>()
  const [manifest, setManifest] = useState<ProvenanceManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['quality', 'sources', 'ddf-scores', 'protocol-citations', 'reasoning', 'gen-loop'])
  )
  const [activeTab, setActiveTab] = useState<'overview' | 'quality-checks'>('overview')
  const [expandedEvaluators, setExpandedEvaluators] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!runId) return
    fetch(`${RUNTIME_URL}/runs/${runId}/provenance-manifest`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setManifest(data))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [runId])

  const toggle = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(section) ? next.delete(section) : next.add(section)
      return next
    })
  }

  const downloadJSON = () => {
    if (!manifest) return
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `provenance-${runId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  )

  if (error || !manifest) return (
    <div className="p-6 text-center text-red-500">
      {error ? `Error loading provenance: ${error}` : 'Manifest not found'}
    </div>
  )

  const q = manifest.quality
  const sc = manifest.standards_compliance
  const provMap = manifest.provenance_map || {}
  const provCoverage = manifest.provenance_coverage
  const sectionProv = manifest.section_provenance || {}
  const genLoopHistory = manifest.generation_loop_history || []
  const genLoopSummary = manifest.generation_loop_summary
  const ddfScores = q.confidence_decomposition
  const protocolSources = manifest.sources_cited.filter(s => s.doc_type === 'protocol')
  const nonProtocolSources = manifest.sources_cited.filter(s => s.doc_type !== 'protocol')
  const evalScoresFull = manifest.eval_scores_full || {}
  const qualityChecksAudit = manifest.quality_checks_audit || []

  // Evaluator metadata: how each score is computed
  const EVALUATOR_META: Record<string, {
    label: string; icon: string; threshold: number; formula: string; description: string
  }> = {
    accuracy: {
      label: 'Protocol Digitization Accuracy',
      icon: '🎯',
      threshold: 1.0,
      formula: 'matched_values / sampled_values',
      description: 'Samples leaf string values from each USDM mandatory section and checks whether the first 40 characters appear verbatim in the source protocol text. Score = proportion of traced values / total sampled. Threshold: 100%.',
    },
    completeness: {
      label: 'Section Completeness',
      icon: '📋',
      threshold: 1.0,
      formula: 'populated_sections / 10_mandatory_sections',
      description: 'Checks all 10 mandatory USDM v4.0 sections (studyProtocols, studyDesigns, populations, arms, activities, epochs, encounters, procedures, estimands, studyIdentifiers). Score = populated count / 10. Threshold: 100%.',
    },
    standards: {
      label: 'Standards Compliance (ICH M11 + USDM IG)',
      icon: '🔗',
      threshold: 1.0,
      formula: 'resolved_checks / total_checks (ICH-M11 + IG-types + IG-fields + gap-rules)',
      description: 'Four-part check: (1) ICH M11 section mapping — each ICH section must resolve to a populated USDM path; (2) USDM IG section types — dict vs list validation; (3) USDM IG required fields — key fields per section; (4) Gap rules catalog (GAP-USDM-001 to GAP-USDM-019+) — root duplication, ICE structure, absent non-USDM fields. Threshold: 100%.',
    },
    hallucination: {
      label: 'Hallucination Detection',
      icon: '🔍',
      threshold: 1.0,
      formula: '1 - (hallucinated_values / total_sampled)',
      description: 'For each USDM section, samples up to 5 leaf strings (≥15 chars), builds 3-grams, and computes overlap with source protocol 3-grams. Values with <40% n-gram overlap are flagged as potentially hallucinated. Score = 1 − hallucination rate. Threshold: 100%.',
    },
    readability: {
      label: 'Readability & Clarity',
      icon: '📖',
      threshold: 1.0,
      formula: 'running_points / max_points (0.10 per section for avg_words ≤ 30, 0.05 for no placeholders)',
      description: 'Per USDM section: +0.10 if average sentence length ≤ 30 words; +0.05 if no placeholder text (TBD, lorem ipsum, [insert], etc.). Score = accumulated points / max achievable. Threshold: 100%.',
    },
    cost: {
      label: 'Cost Accounting',
      icon: '💰',
      threshold: 0.0,
      formula: 'tokens_used × $0.000002/token',
      description: 'Informational evaluator — always passes. Records tokens used, total cost at $2/1M tokens, sections populated, and cost per populated section.',
    },
    consistency: {
      label: 'Cross-field Consistency',
      icon: '🔄',
      threshold: 1.0,
      formula: 'sum_of_5_checks × 0.20 each',
      description: 'Five checks × 0.20 each: (1) studyProtocols.officialTitle present; (2) arms is a non-empty list; (3) populations have inclusion/exclusion type tags; (4) activities is non-empty; (5) estimands reference arm names. Score = passed checks × 0.20. Threshold: 100%.',
    },
    provenance: {
      label: 'Provenance Coverage',
      icon: '🗺️',
      threshold: 1.0,
      formula: 'sections_with_provenance / populated_sections',
      description: 'Blocking gate: every populated mandatory USDM section must have a source entry in the provenance map tracing it to an ICH protocol section. Score = covered / populated. Threshold: 100% (HITL required otherwise).',
    },
  }

  // ── Evaluation Criteria dimension mapping (evaluationCriteria.jpeg) ─────
  // Maps 5 DDF evaluation criteria to specific evaluator score slugs
  const evalCriteria = [
    {
      id: 'digitization_accuracy',
      label: 'Protocol Digitization Accuracy',
      description: 'How accurately the protocol content was extracted and reproduced',
      slugs: ['accuracy', 'hallucination'],
      icon: '🎯',
    },
    {
      id: 'output_quality',
      label: 'Automated Output Quality',
      description: 'Overall quality of the generated USDM document',
      slugs: ['completeness', 'consistency'],
      icon: '✅',
    },
    {
      id: 'interoperability',
      label: 'Interoperability / Standards',
      description: 'Compliance with USDM v4.0 and ICH M11 standards',
      slugs: ['standards'],
      icon: '🔗',
    },
    {
      id: 'readability',
      label: 'Readability & Usability',
      description: 'Readability and clarity of generated content',
      slugs: ['readability'],
      icon: '📖',
    },
    {
      id: 'provenance',
      label: 'Provenance Coverage',
      description: 'Every USDM field traceable to source protocol section',
      slugs: ['provenance'],
      icon: '🔍',
    },
  ]

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5 print:p-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-xl">
            <Shield className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Provenance Certificate</h1>
            <p className="text-sm text-gray-500">
              {manifest.agent_name || manifest.agent_slug} · Run {runId.slice(0, 8)}…
            </p>
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 text-sm border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-50"
          >
            <Printer className="w-4 h-4" /> Print / PDF
          </button>
          <button
            onClick={downloadJSON}
            className="flex items-center gap-1.5 text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700"
          >
            <Download className="w-4 h-4" /> Download JSON
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-gray-200 print:hidden">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'overview'
              ? 'border-indigo-600 text-indigo-600 bg-indigo-50'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Overview
          </span>
        </button>
        <button
          onClick={() => setActiveTab('quality-checks')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'quality-checks'
              ? 'border-indigo-600 text-indigo-600 bg-indigo-50'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <List className="w-3.5 h-3.5" /> Quality Checks
            {qualityChecksAudit.length > 0 && (
              <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">
                {qualityChecksAudit.length}
              </span>
            )}
          </span>
        </button>
      </div>

      {/* ── Overview Tab ────────────────────────────────────────────── */}
      {activeTab === 'overview' && <>

      {/* Run Summary */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Agent</p>
          <p className="font-medium text-gray-800">{manifest.agent_name || manifest.agent_slug}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Status</p>
          <p className="font-medium capitalize text-gray-800">{manifest.status}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Created</p>
          <p className="font-medium text-gray-800">{manifest.created_at ? new Date(manifest.created_at).toLocaleString() : '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Protocol Sources</p>
          <p className="font-medium text-gray-800">{protocolSources.length} sections</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Study ID</p>
          <p className="font-medium text-gray-800 text-xs truncate max-w-[120px]" title={manifest.study_id}>{manifest.study_id?.slice(0, 8)}…</p>
        </div>
      </div>

      {/* DDF Confidence Decomposition — always shown for USDM runs */}
      {ddfScores && Object.values(ddfScores).some(v => v != null) && (
        <Section
          id="ddf-scores"
          title="DDF Evaluation Scores"
          icon={<TrendingUp className="w-4 h-4 text-indigo-500" />}
          badge={
            ddfScores.overall != null
              ? <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${
                  ddfScores.overall >= 0.7 ? 'bg-green-100 text-green-700 border-green-200' :
                  ddfScores.overall >= 0.4 ? 'bg-amber-100 text-amber-700 border-amber-200' :
                  'bg-red-100 text-red-700 border-red-200'
                }`}>{Math.round(ddfScores.overall * 100)}% Overall</span>
              : undefined
          }
          open={expandedSections.has('ddf-scores')}
          onToggle={() => toggle('ddf-scores')}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {([
              { key: 'digitization_accuracy', label: 'Protocol Digitization Accuracy', icon: '🎯', desc: 'Mandatory fields populated, traceability' },
              { key: 'output_quality', label: 'Automated Output Quality', icon: '✅', desc: 'Hallucination-free, grounded output' },
              { key: 'standards_alignment', label: 'Interoperability & Standards', icon: '🔗', desc: 'USDM v4.0 + ICH M11 compliance' },
              { key: 'technical_feasibility', label: 'Technical Feasibility', icon: '⚙️', desc: 'Data richness & structural completeness' },
            ] as { key: keyof typeof ddfScores; label: string; icon: string; desc: string }[]).map(({ key, label, icon, desc }) => {
              const val = ddfScores[key]
              return (
                <div key={key} className={`border rounded-xl p-4 ${val == null ? 'bg-gray-50 border-gray-200' : val >= 0.7 ? 'bg-green-50 border-green-200' : val >= 0.4 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-xl">{icon}</span>
                    <div>
                      <p className="text-[11px] font-semibold text-gray-700 leading-tight">{label}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{desc}</p>
                    </div>
                  </div>
                  <p className={`text-2xl font-bold ${scoreColor(val)}`}>
                    {val != null ? `${Math.round(val * 100)}%` : '—'}
                  </p>
                  <div className="mt-2 h-1.5 bg-white/60 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${
                      val == null ? '' : val >= 0.7 ? 'bg-green-500' : val >= 0.4 ? 'bg-amber-400' : 'bg-red-400'
                    }`} style={{ width: `${val != null ? Math.round(val * 100) : 0}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Section>
      )}

      {/* Evaluation Criteria Panel (evaluationCriteria.jpeg dimensions) — Phase 6 */}
      {manifest.evaluator_scores.length > 0 && (
        <Section
          id="eval-criteria"
          title="Evaluation Criteria"
          icon={<Activity className="w-4 h-4 text-violet-500" />}
          open={expandedSections.has('eval-criteria')}
          onToggle={() => toggle('eval-criteria')}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {evalCriteria.map(criterion => {
              const matchingScores = manifest.evaluator_scores.filter(e =>
                criterion.slugs.includes(e.slug)
              )
              // For provenance, also check provenance_coverage from manifest
              let displayScore: number | null = null
              if (criterion.id === 'provenance' && provCoverage != null) {
                displayScore = provCoverage
              } else if (matchingScores.length > 0) {
                const valid = matchingScores.filter(e => e.score != null)
                displayScore = valid.length > 0 ? valid.reduce((a, e) => a + (e.score ?? 0), 0) / valid.length : null
                // Invert hallucination: higher hallucination score = worse digitization accuracy
                if (criterion.id === 'digitization_accuracy') {
                  const hallScore = matchingScores.find(e => e.slug === 'hallucination')
                  const accScore = matchingScores.find(e => e.slug === 'accuracy')
                  if (hallScore?.score != null && accScore?.score != null) {
                    displayScore = (accScore.score + (1 - hallScore.score)) / 2
                  }
                }
              }
              const allPassed = matchingScores.length > 0
                ? matchingScores.every(e => e.verdict === 'pass')
                : (displayScore != null ? displayScore >= 0.7 : null)

              return (
                <div key={criterion.id}
                  className={`border rounded-xl p-4 ${
                    allPassed === true ? 'bg-green-50 border-green-200' :
                    allPassed === false ? 'bg-red-50 border-red-200' :
                    'bg-gray-50 border-gray-200'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{criterion.icon}</span>
                      <div>
                        <p className="text-xs font-semibold text-gray-700">{criterion.label}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{criterion.description}</p>
                      </div>
                    </div>
                  </div>
                  {displayScore != null
                    ? <ScoreBar score={displayScore} label={`${Math.round(displayScore * 100)}%`} />
                    : <p className="text-xs text-gray-400 italic">No data yet</p>
                  }
                  <div className="mt-2 flex flex-wrap gap-1">
                    {matchingScores.map(e => (
                      <VerdictBadge key={e.slug} verdict={e.verdict} />
                    ))}
                    {criterion.id === 'provenance' && provCoverage != null && matchingScores.length === 0 && (
                      <VerdictBadge verdict={provCoverage >= 1.0 ? 'pass' : 'fail'} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>
      )}

      {/* Quality Certificate — Criterion 1, 2, 3, 5 */}
      <Section
        id="quality"
        title="Quality Certificate"
        icon={<TrendingUp className="w-4 h-4 text-indigo-500" />}
        badge={<VerdictBadge verdict={q.verdict} />}
        open={expandedSections.has('quality')}
        onToggle={() => toggle('quality')}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
          {/* Hallucination */}
          <div className={`border rounded-xl p-3 ${q.hallucination_detected ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
            <p className="text-xs text-gray-500 mb-1">Hallucination</p>
            <div className="flex items-center gap-1.5">
              {q.hallucination_detected
                ? <><XCircle className="w-4 h-4 text-red-500" /><span className="text-sm font-semibold text-red-600">Detected</span></>
                : <><CheckCircle className="w-4 h-4 text-green-500" /><span className="text-sm font-semibold text-green-600">None Detected</span></>
              }
            </div>
          </div>
          {/* Confidence */}
          <div className={`border rounded-xl p-3 ${scoreBg(q.confidence)}`}>
            <p className="text-xs text-gray-500 mb-1">Confidence</p>
            <p className={`text-lg font-bold ${scoreColor(q.confidence)}`}>
              {q.confidence != null ? `${Math.round(q.confidence * 100)}%` : '—'}
            </p>
          </div>
          {/* Branch Action */}
          <div className="border border-gray-200 bg-gray-50 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">Decision Branch</p>
            <p className={`text-sm font-semibold capitalize ${
              q.branch_action === 'proceed' ? 'text-green-600' :
              q.branch_action === 'escalate' ? 'text-amber-600' :
              q.branch_action === 'defer' ? 'text-red-600' : 'text-gray-500'
            }`}>{q.branch_action || '—'}</p>
          </div>
          {/* Readability */}
          <div className={`border rounded-xl p-3 ${scoreBg(q.readability_score)}`}>
            <p className="text-xs text-gray-500 mb-1">Readability Grade</p>
            <p className={`text-lg font-bold ${scoreColor(q.readability_score)}`}>{q.readability_grade}</p>
          </div>
          {/* Completeness */}
          <div className={`border rounded-xl p-3 ${scoreBg(q.completeness_score)}`}>
            <p className="text-xs text-gray-500 mb-1">Completeness Grade</p>
            <p className={`text-lg font-bold ${scoreColor(q.completeness_score)}`}>{q.completeness_grade}</p>
          </div>
          {/* Sources */}
          <div className="border border-indigo-100 bg-indigo-50 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">Sources Cited</p>
            <p className="text-lg font-bold text-indigo-600">{q.sources_cited_count}</p>
          </div>
        </div>
        <div className="space-y-2">
          <ScoreBar score={q.faithfulness_score} label="Faithfulness (groundedness in source docs)" />
          <ScoreBar score={q.reasoning_score} label="Reasoning quality" />
          <ScoreBar score={q.readability_score} label="Readability / conciseness" />
          <ScoreBar score={q.completeness_score} label="Completeness (all aspects covered)" />
        </div>
        {q.judge_notes && (
          <p className="mt-3 text-xs text-gray-500 bg-gray-50 rounded-lg p-2 italic">
            Judge: "{q.judge_notes}"
            {q.judge_model && <span className="ml-2 text-gray-400">({q.judge_model})</span>}
          </p>
        )}
      </Section>

      {/* Standards Compliance — Criterion 4, 6 */}
      {(sc.usdm_score != null || sc.ich_m11_score != null) && (
        <Section
          id="standards"
          title="Standards Compliance"
          icon={<BookOpen className="w-4 h-4 text-blue-500" />}
          badge={sc.conformant
            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200">Conformant</span>
            : <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200">Non-Conformant</span>}
          open={expandedSections.has('standards')}
          onToggle={() => toggle('standards')}
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {sc.usdm_score != null && (
              <div className="border border-blue-200 bg-blue-50 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">USDM v4.0 Score</p>
                <p className="text-2xl font-bold text-blue-600">{sc.usdm_score}<span className="text-sm text-blue-400">/100</span></p>
              </div>
            )}
            {sc.ich_m11_score != null && (
              <div className="border border-purple-200 bg-purple-50 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">ICH M11 Score</p>
                <p className="text-2xl font-bold text-purple-600">{sc.ich_m11_score}<span className="text-sm text-purple-400">/100</span></p>
              </div>
            )}
            {sc.sections_found != null && (
              <div className="border border-gray-200 bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Sections Found</p>
                <p className="text-2xl font-bold text-gray-700">{sc.sections_found}<span className="text-sm text-gray-400">/{sc.sections_total}</span></p>
              </div>
            )}
          </div>
          {sc.missing_mandatory && sc.missing_mandatory.length > 0 && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-xs font-semibold text-red-700 mb-1">Missing Mandatory Fields/Sections:</p>
              <div className="flex flex-wrap gap-1">
                {sc.missing_mandatory.map(m => (
                  <span key={m} className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full border border-red-200">{m}</span>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Protocol Document Citations */}
      <Section
        id="protocol-citations"
        title={`Protocol Document Citations (${protocolSources.length} sections)`}
        icon={<MapPin className="w-4 h-4 text-blue-500" />}
        badge={
          protocolSources.length > 0
            ? <span className="text-xs px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">{protocolSources.length} sections cited</span>
            : undefined
        }
        open={expandedSections.has('protocol-citations')}
        onToggle={() => toggle('protocol-citations')}
      >
        {protocolSources.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No protocol citations recorded. Run a new conversion to see protocol-to-USDM citations.</p>
        ) : (
          <div className="space-y-3">
            {protocolSources.map((s, i) => (
              <div key={i} className="border border-blue-100 bg-blue-50/40 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-blue-700 uppercase tracking-wide">§ {s.section?.split('>').pop()?.trim() || s.section || 'Protocol'}</span>
                      {s.page_number && (
                        <span className="text-[10px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full border border-blue-200">p.{s.page_number}</span>
                      )}
                      {s.used_for && (
                        <span className="text-[10px] bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full border border-indigo-200">→ {s.used_for}</span>
                      )}
                      {s.usdm_path && (
                        <span className="text-[10px] font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded border border-gray-200 max-w-[200px] truncate" title={s.usdm_path}>{s.usdm_path}</span>
                      )}
                    </div>
                    {s.section && s.section.includes('>') && (
                      <p className="text-[10px] text-gray-400 mt-0.5 truncate">{s.section}</p>
                    )}
                  </div>
                  {s.score != null && (
                    <span className={`text-xs font-bold flex-shrink-0 ${s.score >= 0.7 ? 'text-green-600' : s.score >= 0.4 ? 'text-amber-500' : 'text-red-500'}`}>
                      {Math.round(s.score * 100)}%
                    </span>
                  )}
                </div>
                {s.excerpt && (
                  <blockquote className="text-xs text-gray-600 italic bg-white rounded-lg p-3 border border-blue-100 leading-relaxed line-clamp-4">
                    &ldquo;{s.excerpt.slice(0, 350)}{s.excerpt.length > 350 ? '…' : ''}&rdquo;
                  </blockquote>
                )}
                {s.matched_terms && s.matched_terms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.matched_terms.map((t, ti) => (
                      <span key={ti} className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded border border-amber-200">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Sources Cited — guidelines / other references */}
      {nonProtocolSources.length > 0 && (
      <Section
        id="sources"
        title={`Other References (${nonProtocolSources.length})`}
        icon={<FileText className="w-4 h-4 text-green-500" />}
        open={expandedSections.has('sources')}
        onToggle={() => toggle('sources')}
      >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-400">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Section</th>
                  <th className="px-3 py-2">Relevance</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Excerpt</th>
                </tr>
              </thead>
              <tbody>
                {nonProtocolSources.map((s, i) => {
                  const score = s.score || 0
                  const scoreCol = score >= 0.7 ? 'text-green-600' : score >= 0.4 ? 'text-amber-500' : 'text-red-500'
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2 font-medium text-gray-700 max-w-[140px] truncate">{s.doc_name || '—'}</td>
                      <td className="px-3 py-2 text-gray-500 max-w-[100px] truncate">{s.section ? `§ ${s.section}` : '—'}</td>
                      <td className={`px-3 py-2 font-mono font-semibold ${scoreCol}`}>{score ? `${Math.round(score * 100)}%` : '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${s.is_domain_specific ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>
                          {s.query_type || (s.is_domain_specific ? 'domain' : 'general')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-400 max-w-[200px] truncate italic">
                        {s.excerpt ? `"${s.excerpt.slice(0, 80)}"` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
      </Section>
      )}

      {/* Reasoning Chain — Criterion 1, 5 */}
      {manifest.reasoning_steps.length > 0 && (
        <Section
          id="reasoning"
          title={`Reasoning Chain (${manifest.reasoning_steps.length} steps)`}
          icon={<GitBranch className="w-4 h-4 text-purple-500" />}
          open={expandedSections.has('reasoning')}
          onToggle={() => toggle('reasoning')}
        >
          <ol className="space-y-2">
            {manifest.reasoning_steps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="flex-shrink-0 w-6 h-6 bg-purple-100 text-purple-600 text-xs font-bold rounded-full flex items-center justify-center">
                  {i + 1}
                </span>
                <div className="flex-1 bg-gray-50 rounded-lg p-2.5">
                  {step.action && <p className="font-medium text-gray-700">{step.action}</p>}
                  {step.reasoning && <p className="text-gray-500 text-xs mt-0.5">{step.reasoning}</p>}
                  {step.confidence != null && (
                    <span className={`text-xs font-mono ${scoreColor(step.confidence)}`}>
                      confidence: {Math.round(step.confidence * 100)}%
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Evaluator Scores — Criterion 2, 3, 5 */}
      {manifest.evaluator_scores.length > 0 && (
        <Section
          id="evaluators"
          title="Evaluator Results"
          icon={<Activity className="w-4 h-4 text-orange-500" />}
          badge={
            <button
              onClick={(e) => { e.stopPropagation(); setActiveTab('quality-checks') }}
              className="text-[10px] text-indigo-600 border border-indigo-200 bg-indigo-50 px-2 py-0.5 rounded-full hover:bg-indigo-100 transition-colors print:hidden"
            >
              View Score Breakdown →
            </button>
          }
          open={expandedSections.has('evaluators')}
          onToggle={() => toggle('evaluators')}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {manifest.evaluator_scores.map((ev, i) => {
              const meta = EVALUATOR_META[ev.slug]
              const fullEv = evalScoresFull[ev.slug]
              const details = fullEv?.details ?? []
              const gapCount = fullEv?.gap_failures?.length ?? 0
              return (
                <div key={i} className={`border rounded-xl p-3 ${ev.verdict === 'pass' ? 'border-green-200 bg-green-50/30' : ev.verdict === 'fail' ? 'border-red-200 bg-red-50/30' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">{meta?.icon ?? '📊'}</span>
                      <p className="text-sm font-medium text-gray-700">{ev.evaluator}</p>
                    </div>
                    <VerdictBadge verdict={ev.verdict} />
                  </div>
                  {ev.score != null && <ScoreBar score={ev.score} label={`Score: ${Math.round(ev.score * 100)}%`} />}
                  {meta && (
                    <p className="text-[10px] font-mono text-gray-400 mt-1">formula: {meta.formula}</p>
                  )}
                  {meta && (
                    <p className="text-[10px] text-gray-400 mt-0.5">threshold: {Math.round(meta.threshold * 100)}%</p>
                  )}
                  {(details.length > 0 || gapCount > 0) && (
                    <div className="mt-2 flex gap-1 flex-wrap">
                      {details.length > 0 && (
                        <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full">
                          {details.length} finding{details.length > 1 ? 's' : ''}
                        </span>
                      )}
                      {gapCount > 0 && (
                        <span className="text-[10px] bg-red-50 text-red-700 border border-red-200 px-1.5 py-0.5 rounded-full">
                          {gapCount} gap rule{gapCount > 1 ? 's' : ''} failed
                        </span>
                      )}
                    </div>
                  )}
                  {ev.notes && <p className="text-xs text-gray-500 mt-1.5 italic">{ev.notes}</p>}
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-gray-400 text-center">
            For full check details, gap rules, and auto-correction history, see the{' '}
            <button onClick={() => setActiveTab('quality-checks')} className="text-indigo-600 underline hover:text-indigo-800 print:hidden">
              Quality Checks tab
            </button>
          </p>
        </Section>
      )}

      {/* Audit Trail — Criterion 4 */}
      {manifest.audit_events.length > 0 && (
        <Section
          id="audit"
          title={`Audit Trail (${manifest.audit_events.length} events)`}
          icon={<Clock className="w-4 h-4 text-gray-500" />}
          open={expandedSections.has('audit')}
          onToggle={() => toggle('audit')}
        >
          <div className="space-y-1.5">
            {manifest.audit_events.map((ev, i) => (
              <div key={i} className="flex items-start gap-3 text-xs p-2 bg-gray-50 rounded-lg">
                <User className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-gray-700">{ev.action}</span>
                  <span className="text-gray-400 ml-2">{ev.actor_type}: {ev.actor_id?.slice(0, 8)}…</span>
                  {ev.timestamp && <span className="text-gray-400 ml-2">{new Date(ev.timestamp).toLocaleString()}</span>}
                </div>
                {ev.row_hash && (
                  <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                    <Hash className="w-3 h-3" />
                    <span className="font-mono">{ev.row_hash.slice(0, 8)}…</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Per-field Provenance Map (Protocol → USDM) — Phase 3 */}
      {Object.keys(provMap).length > 0 && (
        <Section
          id="provenance-map"
          title={`Per-field Provenance Map (${Object.keys(provMap).length} fields traced)`}
          icon={<BookOpen className="w-4 h-4 text-amber-500" />}
          badge={
            provCoverage != null
              ? <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${
                  provCoverage >= 1.0 ? 'bg-green-100 text-green-700 border-green-200' :
                  'bg-amber-100 text-amber-700 border-amber-200'
                }`}>{Math.round(provCoverage * 100)}% coverage</span>
              : undefined
          }
          open={expandedSections.has('provenance-map')}
          onToggle={() => toggle('provenance-map')}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-400">
                  <th className="px-3 py-2">USDM Field Path</th>
                  <th className="px-3 py-2">Protocol Section (ICH)</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Char Range</th>
                  <th className="px-3 py-2">Excerpt</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(provMap).map(([path, entry], i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-amber-50 transition-colors">
                    <td className="px-3 py-2 font-mono text-indigo-700 max-w-[180px] truncate">{path}</td>
                    <td className="px-3 py-2 font-medium text-gray-700">§ {entry.source_ich_section}</td>
                    <td className="px-3 py-2">
                      <span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{entry.method}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-400">
                      {entry.char_start != null ? `${entry.char_start}–${entry.char_end}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-500 max-w-[260px] truncate italic">
                      {entry.excerpt ? `"${entry.excerpt.slice(0, 100)}"` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Generation Loop History */}
      {genLoopHistory.length > 0 && (
        <Section
          id="gen-loop"
          title={`Generation Loop (${genLoopHistory.length} attempt${genLoopHistory.length > 1 ? 's' : ''})`}
          icon={<RefreshCw className="w-4 h-4 text-violet-500" />}
          badge={
            genLoopSummary?.final_passed != null
              ? <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${
                  genLoopSummary.final_passed ? 'bg-green-100 text-green-700 border-green-200' : 'bg-amber-100 text-amber-700 border-amber-200'
                }`}>{genLoopSummary.final_passed ? 'Converged' : `Best: attempt ${genLoopSummary.best_attempt ?? '?'}`}</span>
              : undefined
          }
          open={expandedSections.has('gen-loop')}
          onToggle={() => toggle('gen-loop')}
        >
          {genLoopSummary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-400 mb-0.5">Attempts</p>
                <p className="text-xl font-bold text-violet-600">{genLoopSummary.attempts_executed ?? genLoopHistory.length}</p>
              </div>
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-400 mb-0.5">Best Attempt</p>
                <p className="text-xl font-bold text-violet-600">#{genLoopSummary.best_attempt ?? '—'}</p>
              </div>
              <div className={`border rounded-xl p-3 text-center ${genLoopSummary.excel_feedback?.passed ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                <p className="text-xs text-gray-400 mb-0.5">Excel Checks</p>
                <p className={`text-sm font-bold ${genLoopSummary.excel_feedback?.passed ? 'text-green-600' : 'text-amber-600'}`}>
                  {genLoopSummary.excel_feedback?.passed ? '✓ Passed' : `${genLoopSummary.excel_feedback?.gap_count ?? '?'} gaps`}
                </p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-400 mb-0.5">Final Score</p>
                <p className={`text-xl font-bold ${scoreColor(genLoopSummary.final_overall ?? null)}`}>
                  {genLoopSummary.final_overall != null ? `${Math.round(genLoopSummary.final_overall * 100)}%` : '—'}
                </p>
              </div>
            </div>
          )}
          {genLoopSummary?.overall_progression && genLoopSummary.overall_progression.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-gray-400 mb-2">Score progression per attempt</p>
              <div className="flex gap-2 flex-wrap">
                {genLoopSummary.overall_progression.map((score, idx) => (
                  <div key={idx} className={`flex flex-col items-center border rounded-lg p-2 min-w-[52px] ${
                    idx + 1 === genLoopSummary!.best_attempt ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-gray-50'
                  }`}>
                    <span className="text-[10px] text-gray-400">#{idx + 1}</span>
                    <span className={`text-sm font-bold ${scoreColor(score)}`}>{Math.round(score * 100)}%</span>
                    {idx + 1 === genLoopSummary!.best_attempt && <span className="text-[9px] text-green-600 font-semibold">BEST</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {genLoopHistory.map((att, i) => (
              <div key={i} className={`border rounded-xl p-3 text-xs ${
                att.passed ? 'bg-green-50 border-green-200' :
                att.attempt === genLoopSummary?.best_attempt ? 'bg-violet-50 border-violet-300' :
                'bg-gray-50 border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-gray-700">Attempt {att.attempt}</span>
                  <div className="flex items-center gap-2">
                    {att.excel_passed != null && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                        att.excel_passed ? 'bg-green-100 text-green-700 border-green-200' : 'bg-amber-100 text-amber-700 border-amber-200'
                      }`}>{att.excel_passed ? 'Excel ✓' : `Excel: ${att.gap_count} gaps`}</span>
                    )}
                    {att.overall_score != null && (
                      <span className={`font-bold ${scoreColor(att.overall_score)}`}>{Math.round(att.overall_score * 100)}%</span>
                    )}
                    {att.passed && <CheckCircle className="w-3.5 h-3.5 text-green-500" />}
                  </div>
                </div>
                {att.details && att.details.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-gray-500 list-disc list-inside">
                    {att.details.slice(0, 4).map((d, di) => <li key={di}>{d}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Output Summary */}
      {manifest.output_summary && (
        <Section
          id="output"
          title="Agent Output Summary"
          icon={<FileText className="w-4 h-4 text-teal-500" />}
          open={expandedSections.has('output')}
          onToggle={() => toggle('output')}
        >
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{manifest.output_summary}</p>
        </Section>
      )}

      </>}

      {/* ── Quality Checks Tab ──────────────────────────────────────── */}
      {activeTab === 'quality-checks' && (
        <div className="space-y-5">
          {/* Score Breakdown per evaluator */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-500" />
              <span className="font-semibold text-gray-800 text-sm">Quality Score Breakdown</span>
              <span className="text-xs text-gray-400 ml-1">— how each evaluator score was computed</span>
            </div>
            <div className="p-5 space-y-3">
              {/* Build evaluator list from DB scores + full scores */}
              {(() => {
                const allSlugs = Array.from(new Set([
                  ...manifest.evaluator_scores.map(e => e.slug),
                  ...Object.keys(evalScoresFull),
                ]))
                return allSlugs.map(slug => {
                  const dbEv = manifest.evaluator_scores.find(e => e.slug === slug)
                  const fullEv = evalScoresFull[slug]
                  const meta = EVALUATOR_META[slug]
                  const score = fullEv?.score ?? (dbEv?.score ?? null)
                  const passed = fullEv?.passed ?? (dbEv?.verdict === 'pass')
                  const details = fullEv?.details ?? []
                  const gapFailures = fullEv?.gap_failures ?? []
                  const isExpanded = expandedEvaluators.has(slug)
                  const label = meta?.label ?? dbEv?.evaluator ?? slug
                  return (
                    <div key={slug} className={`border rounded-xl overflow-hidden ${
                      passed ? 'border-green-200' : 'border-red-200'
                    }`}>
                      <button
                        className={`w-full flex items-center justify-between px-4 py-3 text-left hover:opacity-90 transition-opacity ${
                          passed ? 'bg-green-50' : 'bg-red-50'
                        }`}
                        onClick={() => setExpandedEvaluators(prev => {
                          const next = new Set(prev)
                          next.has(slug) ? next.delete(slug) : next.add(slug)
                          return next
                        })}
                      >
                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                          <span className="text-lg flex-shrink-0">{meta?.icon ?? '📊'}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-800">{label}</span>
                              {passed
                                ? <span className="text-[10px] bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-semibold">PASS</span>
                                : <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full font-semibold">FAIL</span>
                              }
                              {meta && (
                                <span className="text-[10px] text-gray-400">threshold: {Math.round(meta.threshold * 100)}%</span>
                              )}
                            </div>
                            {meta && (
                              <p className="text-[10px] font-mono text-gray-500 mt-0.5">{meta.formula}</p>
                            )}
                          </div>
                          <div className="flex-shrink-0 text-right">
                            <span className={`text-lg font-bold ${score != null && score >= 0.7 ? 'text-green-600' : score != null && score >= 0.4 ? 'text-amber-500' : 'text-red-500'}`}>
                              {score != null ? `${Math.round(score * 100)}%` : '—'}
                            </span>
                          </div>
                        </div>
                        <div className="ml-3 flex-shrink-0">
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-3 bg-white space-y-3">
                          {meta && (
                            <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
                              <div className="flex items-start gap-2">
                                <Info className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />
                                <p className="text-xs text-blue-800">{meta.description}</p>
                              </div>
                            </div>
                          )}
                          {score != null && meta && (
                            <div className="space-y-1.5">
                              <p className="text-xs font-semibold text-gray-600">Score computation</p>
                              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-amber-400' : 'bg-red-400'}`}
                                  style={{ width: `${Math.round(score * 100)}%` }}
                                />
                              </div>
                              <div className="flex justify-between text-[10px] text-gray-400">
                                <span>0%</span>
                                <span className="text-amber-500">threshold {Math.round(meta.threshold * 100)}%</span>
                                <span>100%</span>
                              </div>
                            </div>
                          )}
                          {details.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-600 mb-1.5">Check findings ({details.length})</p>
                              <ul className="space-y-1">
                                {details.map((d, i) => (
                                  <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                                    <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                    <span>{d}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {gapFailures.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-red-600 mb-1.5">Gap rule failures ({gapFailures.length})</p>
                              <ul className="space-y-1">
                                {gapFailures.map((g, i) => (
                                  <li key={i} className="flex items-start gap-1.5 text-xs bg-red-50 rounded px-2 py-1">
                                    <XCircle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                                    <span className="text-red-700 font-mono">{g}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {details.length === 0 && gapFailures.length === 0 && passed && (
                            <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 rounded px-3 py-2">
                              <CheckCircle className="w-3.5 h-3.5" />
                              All checks passed — no issues detected
                            </div>
                          )}
                          {dbEv?.notes && (
                            <p className="text-xs text-gray-500 italic bg-gray-50 rounded px-2 py-1">Note: {dbEv.notes}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              })()}
              {manifest.evaluator_scores.length === 0 && Object.keys(evalScoresFull).length === 0 && (
                <p className="text-sm text-gray-400 italic text-center py-4">No evaluator data yet — run a new conversion to populate quality scores.</p>
              )}
            </div>
          </div>

          {/* Quality Checks Audit Table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2">
              <Wrench className="w-4 h-4 text-violet-500" />
              <span className="font-semibold text-gray-800 text-sm">Quality Checks Audit Trail</span>
              <span className="text-xs text-gray-400 ml-1">— all checks, corrections, and which iteration fixed them</span>
              {qualityChecksAudit.length > 0 && (
                <div className="ml-auto flex gap-2 text-[10px]">
                  <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200">
                    {qualityChecksAudit.filter(c => c.status === 'pass').length} passed
                  </span>
                  <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                    {qualityChecksAudit.filter(c => c.was_autocorrected).length} auto-corrected
                  </span>
                  <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200">
                    {qualityChecksAudit.filter(c => c.status === 'fail').length} unresolved
                  </span>
                </div>
              )}
            </div>
            <div className="px-5 pb-5 pt-3">
              {qualityChecksAudit.length === 0 ? (
                <p className="text-sm text-gray-400 italic text-center py-4">
                  No quality check audit data yet. Run a new conversion to see the per-iteration audit trail.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 text-left text-gray-400">
                        <th className="px-3 py-2 w-20">Check ID</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2 w-28 text-center">Status</th>
                        <th className="px-3 py-2 w-20 text-center">Found at</th>
                        <th className="px-3 py-2 w-20 text-center">Fixed at</th>
                        <th className="px-3 py-2 w-24 text-right">Score Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {qualityChecksAudit.map((chk, i) => {
                        const scoreImproved = chk.score_after_fix != null && chk.score_at_detection != null
                          ? chk.score_after_fix - chk.score_at_detection
                          : null
                        return (
                          <tr key={i} className={`border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                            chk.was_autocorrected ? 'bg-green-50/40' :
                            chk.status === 'fail' ? 'bg-red-50/30' : ''
                          }`}>
                            <td className="px-3 py-2.5 font-mono text-gray-500 text-[10px]">{chk.check_id}</td>
                            <td className="px-3 py-2.5 text-gray-700 max-w-[320px]">
                              <span className="line-clamp-2">{chk.description}</span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {chk.was_autocorrected ? (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200 font-semibold">
                                  <Wrench className="w-2.5 h-2.5" /> Auto-Corrected
                                </span>
                              ) : chk.status === 'pass' ? (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200 font-semibold">
                                  <CheckCircle className="w-2.5 h-2.5" /> Pass
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200 font-semibold">
                                  <XCircle className="w-2.5 h-2.5" /> Fail
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                                iter #{chk.iteration_first_seen}
                              </span>
                              {chk.score_at_detection != null && (
                                <div className={`text-[9px] mt-0.5 ${scoreColor(chk.score_at_detection)}`}>
                                  {Math.round(chk.score_at_detection * 100)}%
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {chk.iteration_fixed != null ? (
                                <>
                                  <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                    iter #{chk.iteration_fixed}
                                  </span>
                                  {chk.score_after_fix != null && (
                                    <div className={`text-[9px] mt-0.5 ${scoreColor(chk.score_after_fix)}`}>
                                      {Math.round(chk.score_after_fix * 100)}%
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {scoreImproved != null ? (
                                <span className={`text-[10px] font-mono font-semibold ${scoreImproved > 0 ? 'text-green-600' : scoreImproved < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                                  {scoreImproved > 0 ? '+' : ''}{Math.round(scoreImproved * 100)}%
                                </span>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Per-attempt iteration breakdown from generation loop */}
          {genLoopHistory.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-violet-500" />
                <span className="font-semibold text-gray-800 text-sm">Iteration-by-Iteration Check Progress</span>
              </div>
              <div className="p-5 space-y-3">
                {genLoopHistory.map((att, i) => {
                  const stageConf = (att as Record<string, unknown>)?.stage_confidence as Record<string, number> | undefined
                  const overall = stageConf?.overall ?? (att as Record<string, unknown>)?.overall_score as number | undefined
                  const gaps = (att as Record<string, unknown>)?.gaps as string[] | undefined ?? []
                  const isLast = i === genLoopHistory.length - 1
                  return (
                    <div key={i} className={`border rounded-xl p-4 ${
                      att.passed ? 'bg-green-50 border-green-200' :
                      isLast ? 'bg-violet-50 border-violet-200' :
                      'bg-gray-50 border-gray-200'
                    }`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-700 w-20">Iteration {att.attempt}</span>
                          {att.passed && <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200">✓ Converged</span>}
                          {!att.passed && isLast && <span className="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full border border-violet-200">Best Result</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          {att.excel_passed != null && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                              att.excel_passed ? 'bg-green-100 text-green-700 border-green-200' : 'bg-amber-100 text-amber-700 border-amber-200'
                            }`}>{att.excel_passed ? 'Excel ✓' : `Excel: ${att.gap_count ?? '?'} gaps`}</span>
                          )}
                          {overall != null && (
                            <span className={`text-sm font-bold ${scoreColor(overall)}`}>{Math.round(overall * 100)}%</span>
                          )}
                        </div>
                      </div>
                      {stageConf && (
                        <div className="grid grid-cols-4 gap-2 mb-2">
                          {Object.entries(stageConf).filter(([k]) => k !== 'overall').map(([key, val]) => (
                            <div key={key} className="text-center">
                              <p className="text-[9px] text-gray-400 capitalize">{key.replace(/_/g, ' ')}</p>
                              <p className={`text-xs font-semibold ${scoreColor(val)}`}>{Math.round(val * 100)}%</p>
                            </div>
                          ))}
                        </div>
                      )}
                      {gaps.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-400 mb-1">{gaps.length} unresolved check{gaps.length > 1 ? 's' : ''}</p>
                          <ul className="space-y-0.5">
                            {gaps.slice(0, 5).map((g, gi) => (
                              <li key={gi} className="flex items-start gap-1 text-[10px] text-gray-600">
                                <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                <span className="line-clamp-1">{g}</span>
                              </li>
                            ))}
                            {gaps.length > 5 && <li className="text-[10px] text-gray-400 pl-4">…and {gaps.length - 5} more</li>}
                          </ul>
                        </div>
                      )}
                      {att.passed && gaps.length === 0 && (
                        <p className="text-[10px] text-green-600 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" /> All checks resolved — generation converged
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-center text-gray-400 pt-2 print:mt-8">
        Provenance Certificate · Trialo Platform · Pfizer DDF Challenge · Run ID: {runId}
      </p>
    </div>
  )
}

function Section({
  id, title, icon, badge, open, onToggle, children,
}: {
  id: string; title: string; icon: React.ReactNode; badge?: React.ReactNode
  open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          {icon}
          <span className="font-semibold text-gray-800 text-sm">{title}</span>
          {badge && <div>{badge}</div>}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>
      {open && <div className="px-5 pb-5 pt-2">{children}</div>}
    </div>
  )
}
