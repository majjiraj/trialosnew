'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/components/layout/AuthContext'
import {
  ChevronLeft, ChevronRight, Loader2, Download, FileText, AlertCircle,
  ChevronDown, Info, ExternalLink, Activity, GitBranch,
  Braces, X, Copy, Check, BarChart2, ClipboardList, Brain, CheckCircle, Shield,
} from 'lucide-react'
import { clsx } from 'clsx'
import { AgentInsightTabs } from '@/components/agent/AgentInsightTabs'

const GRAPHQL_URL       = process.env.NEXT_PUBLIC_GRAPHQL_URL       || 'http://localhost:4000/graphql'
const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const INGESTION_URL     = process.env.NEXT_PUBLIC_INGESTION_URL     || 'http://localhost:8003'
const ORG_ID            = process.env.NEXT_PUBLIC_ORG_ID            || '00000000-0000-0000-0000-000000000000'

type SectionSourceChunk = {
  chunk_id: string | null
  chunk_index: number | null
  page_number: number | null
  section: string
  excerpt: string
  score?: number
  matched_terms?: string[]
  usdm_path?: string | null
}

const USDM_SECTIONS = [
  { key: 'meta',             label: 'Study Overview',     path: null },
  { key: 'studyIdentifiers', label: 'Study Identifiers',  path: 'study.studyIdentifiers' },
  { key: 'studyProtocols',   label: 'Protocol Versions',  path: 'study.studyProtocolVersions' },
  { key: 'therapeuticAreas', label: 'Therapeutic Areas',  path: 'study.businessTherapeuticAreas' },
  { key: 'objectives',       label: 'Objectives',         path: 'study.studyDesigns[0].objectives' },
  { key: 'estimands',        label: 'Estimands',          path: 'study.studyDesigns[0].estimands' },
  { key: 'populations',      label: 'Study Populations',  path: 'study.studyDesigns[0].studyPopulations' },
  { key: 'arms',             label: 'Study Arms',         path: 'study.studyDesigns[0].studyArms' },
  { key: 'epochs',           label: 'Study Epochs',       path: 'study.studyDesigns[0].studyEpochs' },
  { key: 'activities',       label: 'Activities',         path: 'study.studyDesigns[0].activities' },
]

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed', approved: 'Approved',
  waiting_approval: 'In Review', failed: 'Failed', pending: 'Queued',
  rejected: 'Rejected', running: 'Running',
}

const INSIGHT_TABS = [
  { id: 'evaluation', label: 'Evaluation',      Icon: BarChart2 },
  { id: 'quality',    label: 'Quality',         Icon: ClipboardList },
  { id: 'traces',     label: 'Decision Traces', Icon: Brain },
  { id: 'validation', label: 'Validation',      Icon: CheckCircle },
  { id: 'learnings',  label: 'Learnings',       Icon: Activity },
  { id: 'audit',      label: 'Audit Log',       Icon: Shield },
]

type VRule = { field: string; desc: string; ref: string; check: (j: any) => boolean }
const VALIDATION_RULES: Record<string, VRule[]> = {
  meta: [
    { field: 'studyTitle',
      desc: 'full protocol title required',
      ref: 'USDM v4 §3.1 / ICH M11 §4.1',
      // v4: normalized to study.studyTitle from versions[0].titles; v3: study.studyTitle directly
      check: j => {
        if (j?.study?.studyTitle) return false
        const ver0 = (j?.study?.versions || [])[0]
        return !(ver0?.titles || []).some((t: any) => t.text)
      },
    },
    { field: 'studyPhase.code',
      desc: 'CDISC phase code required (e.g. C15602 = Phase III)',
      ref: 'ICH M11 §6.1',
      // v4: studyDesigns[0].studyPhase.standardCode.code; normalized to study.studyPhase.code
      check: j => {
        if (j?.study?.studyPhase?.code || j?.study?.studyPhase?.standardCode?.code) return false
        const d0 = (j?.study?.studyDesigns || [])[0]
        const ph = d0?.studyPhase
        return !ph?.code && !ph?.standardCode?.code
      },
    },
  ],
  studyIdentifiers: [
    { field: 'studyIdentifiers[0].scopeId',
      desc: 'identifier organisation reference absent (NCT, EudraCT, JAPIC etc.)',
      ref: 'USDM v4 §4.2',
      // v4: scopeId → Organisation.type determines identifier type; no idType field
      check: j => {
        const ids = j?.study?.studyIdentifiers
        return !ids?.length || !ids[0]?.scopeId
      },
    },
  ],
  studyProtocols: [
    { field: 'documentVersionIds',
      desc: 'protocol document version reference required',
      ref: 'ICH M11 §4.2',
      check: j => {
        const ver0 = (j?.study?.versions || [])[0]
        const dv = j?.study?.documentVersions || j?.study?.studyProtocolVersions || ver0?.documentVersionIds
        return !dv?.length
      },
    },
  ],
  estimands: [
    { field: 'estimands[0].populationSummary',
      desc: 'estimand summary statement required',
      ref: 'ICH E9(R1) §3.1',
      // v4: populationSummary; v3: summary
      check: j => { const e = j?.study?.studyDesigns?.[0]?.estimands; return !!(e?.length && !e[0]?.populationSummary && !e[0]?.summary) },
    },
    { field: 'estimands[0].analysisPopulationId',
      desc: 'estimand population reference required',
      ref: 'ICH E9(R1) §3.1',
      // v4: analysisPopulationId; v3: population
      check: j => { const e = j?.study?.studyDesigns?.[0]?.estimands; return !!(e?.length && !e[0]?.analysisPopulationId && !e[0]?.population) },
    },
    { field: 'estimands[0].variableOfInterestId',
      desc: 'estimand variable (endpoint) reference required',
      ref: 'ICH E9(R1) §3.1',
      // v4: variableOfInterestId; v3: variable
      check: j => { const e = j?.study?.studyDesigns?.[0]?.estimands; return !!(e?.length && !e[0]?.variableOfInterestId && !e[0]?.variable) },
    },
  ],
  populations: [
    { field: 'studyDesigns[0].population',
      desc: 'study population definition required',
      ref: 'USDM v4 §5.1',
      // v4: design.population (StudyDesignPopulation); v3: studyPopulations[]
      check: j => { const d = j?.study?.studyDesigns?.[0]; return !d?.population && !d?.studyPopulations?.length },
    },
  ],
  activities: [
    { field: 'activities — definedProcedures',
      desc: 'no leaf activities have defined procedures',
      ref: 'USDM v4 §9.1',
      // v4: definedProcedures[] on leaf activities (childIds empty); v3: activityType
      check: j => {
        const acts: any[] = j?.study?.studyDesigns?.[0]?.activities || []
        if (!acts.length) return false
        const leaves = acts.filter(a => !a.childIds?.length)
        return leaves.length > 0 && leaves.every(a => !a.definedProcedures?.length)
      },
    },
  ],
}

const TRACE_TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  tool_call:  { label: 'Retrieval',  cls: 'bg-blue-50 text-blue-700' },
  synthesis:  { label: 'Synthesis',  cls: 'bg-purple-50 text-purple-700' },
  reasoning:  { label: 'Reasoning',  cls: 'bg-amber-50 text-amber-700' },
  output:     { label: 'Output',     cls: 'bg-green-50 text-green-700' },
}

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

function getPath(obj: any, path: string | null): any {
  if (!path || !obj) return undefined
  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (!cur) return undefined
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/)
    if (arrMatch) cur = cur[arrMatch[1]]?.[parseInt(arrMatch[2])]
    else cur = cur[part]
  }
  return cur
}

function normalizeUsdmForUi(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw
  const next = JSON.parse(JSON.stringify(raw))
  const study = next.study || {}
  const version = (study.versions || [])[0] || {}

  // Promote version-scoped arrays to study root
  if (!study.studyIdentifiers && version.studyIdentifiers) study.studyIdentifiers = version.studyIdentifiers
  if (!study.studyDesigns && version.studyDesigns) study.studyDesigns = version.studyDesigns
  if (!study.businessTherapeuticAreas && version.businessTherapeuticAreas) study.businessTherapeuticAreas = version.businessTherapeuticAreas
  if (!study.studyProtocolVersions && version.studyProtocolVersions) study.studyProtocolVersions = version.studyProtocolVersions

  // USDM v4: title is in versions[0].titles[] — promote official title to study.studyTitle
  if (!study.studyTitle && version.titles?.length) {
    const official = version.titles.find((t: any) => t.type?.code === 'C207411') || version.titles[0]
    if (official?.text) study.studyTitle = official.text
  }

  // USDM v4: studyPhase lives in studyDesigns[0].studyPhase as AliasCode — promote to study.studyPhase
  const design0 = (study.studyDesigns || [])[0]
  if (!study.studyPhase && design0?.studyPhase) {
    const ph = design0.studyPhase
    // Flatten AliasCode → use standardCode if present
    study.studyPhase = ph.standardCode ? { ...ph.standardCode, aliasCode: ph } : ph
  }

  next.study = study
  return next
}

function fmtDate(ts: string | null | undefined) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
  catch { return ts }
}

// ── JSON syntax coloriser ─────────────────────────────────────────────────────

function JsonBlock({ value }: { value: any }) {
  const raw = JSON.stringify(value, null, 2)
  if (!raw || raw === 'null') return <span className="text-slate-400 italic text-xs">null</span>
  const lines = raw.split('\n')
  return (
    <code className="text-[11px] leading-relaxed font-mono">
      {lines.map((line, i) => {
        const keyMatch = line.match(/^(\s*)("(?:[^"\\]|\\.)*")\s*:\s*(.*)$/)
        if (keyMatch) {
          const [, indent, key, rest] = keyMatch
          return (
            <div key={i}>
              {indent}<span className="text-blue-600">{key}</span>{': '}<JsonValue raw={rest} />
            </div>
          )
        }
        return <div key={i}><JsonValue raw={line} /></div>
      })}
    </code>
  )
}

function JsonValue({ raw }: { raw: string }) {
  const t = raw.trim()
  if (t.startsWith('"')) return <span className="text-emerald-700">{raw}</span>
  if (t === 'true' || t === 'false') return <span className="text-amber-600">{raw}</span>
  if (t === 'null') return <span className="text-slate-400">{raw}</span>
  if (!isNaN(Number(t.replace(/[,\[\]{}\s]/g, '')))) return <span className="text-orange-600">{raw}</span>
  return <span className="text-slate-700">{raw}</span>
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const norm = Math.min(score, 1)
  const pct = Math.round(norm * 100)
  const color = norm >= 0.8 ? 'bg-emerald-500' : norm >= 0.6 ? 'bg-amber-500' : 'bg-red-500'
  const textColor = norm >= 0.8 ? 'text-emerald-700' : norm >= 0.6 ? 'text-amber-700' : 'text-red-700'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={clsx('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={clsx('text-[11px] font-semibold tabular-nums w-7 text-right', textColor)}>{pct}%</span>
    </div>
  )
}

// ── Collapsible card ──────────────────────────────────────────────────────────

function Collapsible({ title, icon, defaultOpen = false, children }: {
  title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors"
      >
        <span className="text-slate-400">{icon}</span>
        <span className="flex-1 text-left">{title}</span>
        <ChevronDown className={clsx('w-3.5 h-3.5 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="p-3 bg-white space-y-3 text-xs">{children}</div>}
    </div>
  )
}

// ── Pane section label ────────────────────────────────────────────────────────

function PaneLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">{children}</p>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WorkbenchPage() {
  const { id } = useParams() as { id: string }
  const router = useRouter()
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID
  const userId = user?.id || '00000000-0000-0000-0000-000000000002'

  const [conversion, setConversion] = useState<any>(null)
  const [usdmJson, setUsdmJson] = useState<any>({})
  const [manifest, setManifest] = useState<any>(null)
  const [sectionProvenance, setSectionProvenance] = useState<Record<string, SectionSourceChunk[]>>({})
  const [similarConversions, setSimilarConversions] = useState<any[]>([])

  const [selectedSection, setSelectedSection] = useState<string>('objectives')
  const [selectedChunkIdx, setSelectedChunkIdx] = useState<number>(0)
  const [sourceView, setSourceView] = useState<'chunks' | 'pdf'>('chunks')
  const [loading, setLoading] = useState(true)
  const [fullChunkContent, setFullChunkContent] = useState<Record<string, string>>({})
  const [showJson, setShowJson] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const [rightPaneOpen, setRightPaneOpen] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [jumpTab, setJumpTab] = useState<string | null>(null)
  const pdfIframeRef = useRef<HTMLIFrameElement>(null)
  const insightsRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setSelectedChunkIdx(0) }, [selectedSection])

  const load = useCallback(async () => {
    try {
      const [convData] = await Promise.all([
        gql(
          `query($id: ID!) { usdmConversion(id: $id) {
            id name status protocolFilename protocolDocId runId
            usdmJson createdAt updatedAt confidence
          }}`,
          { id }
        ),
      ])
      const conv = convData.usdmConversion
      setConversion(conv)

      if (conv?.usdmJson && Object.keys(conv.usdmJson).length > 0) {
        setUsdmJson(normalizeUsdmForUi(conv.usdmJson))
      }

      // Fetch manifest + similar conversions in parallel
      await Promise.all([
        conv?.runId
          ? fetch(`${AGENT_RUNTIME_URL}/runs/${conv.runId}/provenance-manifest`)
              .then(r => r.ok ? r.json() : null)
              .then(m => {
                if (!m) return
                setManifest(m)
                if (m.section_provenance) setSectionProvenance(m.section_provenance)
              })
              .catch(() => {})
          : Promise.resolve(),

        gql(
          `query($orgId: String!) { usdmConversions(orgId: $orgId) {
            id name status confidence createdAt
          }}`,
          { orgId }
        ).then(d => {
          const all = d.usdmConversions || []
          setSimilarConversions(
            all
              .filter((c: any) => c.id !== id && ['completed', 'approved', 'waiting_approval'].includes(c.status))
              .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .slice(0, 3)
          )
        }).catch(() => {}),
      ])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [id, orgId])

  useEffect(() => { load() }, [load])

  // ── Fetch full chunk content when selection changes ─────────────────────────
  const activeChunkForFetch = sectionProvenance[selectedSection]?.[selectedChunkIdx] || null
  useEffect(() => {
    if (!activeChunkForFetch?.chunk_id || fullChunkContent[activeChunkForFetch.chunk_id]) return
    const docId = conversion?.protocolDocId
    if (!docId) return
    fetch(`${INGESTION_URL}/documents/${docId}/chunks/${activeChunkForFetch.chunk_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.content) {
          setFullChunkContent(prev => ({ ...prev, [activeChunkForFetch.chunk_id!]: data.content }))
        }
      })
      .catch(() => {})
  }, [activeChunkForFetch?.chunk_id, conversion?.protocolDocId])

  // ── Navigate PDF to active chunk page ──────────────────────────────────────
  useEffect(() => {
    if (sourceView !== 'pdf' || !pdfIframeRef.current || !conversion?.protocolDocId) return
    const page = activeChunkForFetch?.page_number ?? 1
    const newSrc = `${INGESTION_URL}/documents/${conversion.protocolDocId}/serve#page=${page}&view=FitH`
    if (pdfIframeRef.current.src !== newSrc) {
      setPdfLoading(true)
      pdfIframeRef.current.src = newSrc
    }
  }, [sourceView, activeChunkForFetch?.page_number, conversion?.protocolDocId])

  // ── Derived values ──────────────────────────────────────────────────────────

  const sectionDef = USDM_SECTIONS.find(s => s.key === selectedSection)
  const sectionValue = (() => {
    if (!sectionDef) return null
    const s = usdmJson?.study
    if (sectionDef.key === 'meta') {
      if (!s) return null
      const ver0 = (s.versions || [])[0] || {}
      return {
        studyTitle:     s.studyTitle     || (ver0.titles?.[0]?.text ?? null),
        studyPhase:     s.studyPhase     || null,
        studyType:      s.studyType      || null,
        studyRationale: s.studyRationale || (ver0.rationale ?? null),
      }
    }
    if (sectionDef.key === 'populations') {
      const d = s?.studyDesigns?.[0]
      if (!d) return null
      // USDM v4: design.population (object) + design.analysisPopulations (array)
      // USDM v3: design.studyPopulations (array)
      const main    = d.population     ?? null
      const anPops  = d.analysisPopulations?.length  ? d.analysisPopulations  : null
      const legacyP = d.studyPopulations?.length      ? d.studyPopulations     : null
      if (!main && !anPops && !legacyP) return null
      const out: any = {}
      if (main)    out.population            = main
      if (anPops)  out.analysisPopulations   = anPops
      if (legacyP && !main) out.studyPopulations = legacyP
      return out
    }
    if (sectionDef.key === 'studyProtocols') {
      // USDM v4: versions[0].documentVersionIds; v3: study.studyProtocolVersions
      const ver0 = (s?.versions || [])[0] || {}
      return s?.studyProtocolVersions
        || s?.documentVersions
        || (ver0.documentVersionIds?.length ? ver0.documentVersionIds : null)
        || null
    }
    return getPath(usdmJson, sectionDef.path || null)
  })()

  const hasData = sectionValue !== null && sectionValue !== undefined &&
    !(Array.isArray(sectionValue) && sectionValue.length === 0)

  const chunks: SectionSourceChunk[] = sectionProvenance[selectedSection] || []
  const activeChunk = chunks[selectedChunkIdx] || null
  const topChunk = chunks[0] || null

  // "Why this value?" data
  const sectionSources = (manifest?.sources_cited || []).filter(
    (s: any) => s.used_for === selectedSection || (typeof s.usdm_path === 'string' && s.usdm_path.includes(selectedSection))
  ).slice(0, 6)
  const reasoningSteps = (manifest?.reasoning_steps || []).slice(0, 5)
  const loopHistory: any[] = manifest?.generation_loop_history || []

  // Source type pills
  const sourceTypeCounts = sectionSources.reduce((acc: Record<string, number>, s: any) => {
    const t = s.doc_type || 'unknown'
    acc[t] = (acc[t] || 0) + 1
    return acc
  }, {})

  // Extraction details
  const modelName = manifest?.quality?.judge_model || 'claude-sonnet-4-6'
  const agentName = manifest?.agent_name || 'USDM Conversion Agent'
  const generatedAt = manifest?.created_at || conversion?.createdAt
  const runShort = conversion?.runId?.slice(0, 8).toUpperCase() || '—'

  // Audit events
  const auditEvents: any[] = (manifest?.audit_events || []).slice(0, 5)

  // ── USDM required-field validation (populated sections only) ─────────────
  const validationIssues = useMemo(() => {
    if (!usdmJson || Object.keys(usdmJson).length === 0) return []
    const out: Array<{ sectionKey: string; sectionLabel: string; field: string; desc: string; ref: string }> = []
    for (const [sectionKey, rules] of Object.entries(VALIDATION_RULES)) {
      const sec = USDM_SECTIONS.find(s => s.key === sectionKey)
      const val = sec?.key === 'meta' ? usdmJson?.study : getPath(usdmJson, sec?.path || null)
      const populated = val != null && !(Array.isArray(val) && val.length === 0)
      if (!populated) continue
      for (const rule of rules) {
        if (rule.check(usdmJson)) {
          out.push({ sectionKey, sectionLabel: sec?.label || sectionKey, field: rule.field, desc: rule.desc, ref: rule.ref })
        }
      }
    }
    return out
  }, [usdmJson])

  // ── Loading / not found ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading workbench…
      </div>
    )
  }
  if (!conversion) {
    return <div className="text-center py-24 text-slate-400">Conversion not found.</div>
  }

  const shortId = id.slice(0, 8).toUpperCase()

  function jumpToInsight(tabId: string) {
    setJumpTab(tabId)
    setTimeout(() => insightsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
    {/* Workbench: fills main's visible height so 3-pane PDF never gets clipped */}
    <div className="flex flex-col -mx-6 -mt-6" style={{ height: '100%' }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-6 py-3.5 bg-white border-b border-slate-200 flex-shrink-0">
        <button
          onClick={() => router.push('/usdm')}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 flex-shrink-0"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">Reviewer Workbench</span>
            <span className="font-mono text-[11px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{shortId}</span>
          </div>
          <p className="text-xs text-slate-400 truncate mt-0.5">
            {conversion.name}
            {conversion.protocolFilename && <> · <span className="font-mono">{conversion.protocolFilename}</span></>}
          </p>
        </div>

        {/* ── Insight tab shortcuts ── */}
        {conversion?.runId && (
          <div className="flex items-center gap-0.5 border-l border-slate-200 ml-1 pl-3 flex-shrink-0">
            {INSIGHT_TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => jumpToInsight(tab.id)}
                title={tab.label}
                className="p-1.5 rounded-lg hover:bg-brand-50 text-slate-400 hover:text-brand-600 transition-colors"
              >
                <tab.Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setShowJson(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors flex-shrink-0"
        >
          <Braces className="w-3.5 h-3.5" /> Full JSON
        </button>
        <a
          href={`${AGENT_RUNTIME_URL}/usdm/${id}/download`}
          target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors flex-shrink-0"
        >
          <Download className="w-3.5 h-3.5" /> Export JSON
        </a>
      </div>

      {/* ── Three-pane body — flex: 1 1 0 with minHeight: 0 gives a DEFINITE height so iframe fills correctly ── */}
      <div className="flex overflow-hidden border-b border-slate-200" style={{ flex: '1 1 0', minHeight: 0 }}>

        {/* ════ LEFT: USDM Section JSON + collapsibles ════ */}
        <div className="flex flex-col border-r border-slate-200 overflow-hidden" style={{ width: '36%', minWidth: 0 }}>
          {/* Pane header */}
          <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50 border-b border-slate-100 flex-shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">USDM Section</p>
              <select
                value={selectedSection}
                onChange={e => setSelectedSection(e.target.value)}
                className="w-full text-sm font-medium text-slate-800 bg-white border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-300 cursor-pointer"
              >
                {USDM_SECTIONS.map(s => {
                  const count = (sectionProvenance[s.key] || []).length
                  return (
                    <option key={s.key} value={s.key}>
                      {s.label}{count > 0 ? ` (${count})` : ''}
                    </option>
                  )
                })}
              </select>
            </div>
            {chunks.length > 0 && (
              <span className="flex-shrink-0 text-[10px] font-semibold bg-brand-50 text-brand-600 border border-brand-200 px-2 py-0.5 rounded-full">
                {chunks.length} src
              </span>
            )}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-3 bg-white space-y-3">
            {/* JSON block */}
            {hasData ? (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 overflow-x-auto">
                <JsonBlock value={sectionValue} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                <AlertCircle className="w-7 h-7 mb-2 opacity-30" />
                <p className="text-sm font-medium">No data for this section</p>
              </div>
            )}

            {/* ── Required Fields Missing ── */}
            {validationIssues.length > 0 && (
              <Collapsible
                title={`Required Fields Missing in Populated Sections (${validationIssues.length})`}
                icon={<AlertCircle className="w-3.5 h-3.5 text-amber-500" />}
                defaultOpen
              >
                {Object.entries(
                  validationIssues.reduce((acc, issue) => {
                    if (!acc[issue.sectionKey]) acc[issue.sectionKey] = { label: issue.sectionLabel, items: [] as typeof validationIssues }
                    acc[issue.sectionKey].items.push(issue)
                    return acc
                  }, {} as Record<string, { label: string; items: typeof validationIssues }>)
                ).map(([sectionKey, group]) => (
                  <div key={sectionKey} className="space-y-1">
                    <button
                      onClick={() => setSelectedSection(sectionKey)}
                      className="text-[10px] font-bold text-amber-800 uppercase tracking-wide hover:text-amber-600 transition-colors"
                    >
                      {group.label}
                    </button>
                    {group.items.map((issue, i) => (
                      <div key={i} className="flex gap-2 pl-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                        <div className="min-w-0">
                          <span className="text-[11px] font-mono text-slate-700">{issue.field}</span>
                          <span className="text-[11px] text-slate-500"> — {issue.desc}</span>
                          <span className="ml-1 text-[10px] text-amber-600 font-medium whitespace-nowrap">({issue.ref})</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </Collapsible>
            )}

            {/* ── Why this value? ── */}
            <Collapsible title="Why this value?" icon={<Info className="w-3.5 h-3.5" />} defaultOpen>
              {/* Source type pills */}
              {Object.keys(sourceTypeCounts).length > 0 && (
                <div>
                  <PaneLabel>Source types used</PaneLabel>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(sourceTypeCounts).map(([t, count]) => (
                      <span key={t} className="text-[10px] bg-brand-50 text-brand-700 border border-brand-100 px-2 py-0.5 rounded-full font-medium capitalize">
                        {t.replace(/_/g, ' ')}: {count as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Sources list */}
              {sectionSources.length > 0 ? (
                <div>
                  <PaneLabel>Supporting sources</PaneLabel>
                  <div className="space-y-2">
                    {sectionSources.map((src: any, i: number) => (
                      <div key={i} className="border border-slate-100 rounded-lg p-2 bg-slate-50">
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <span className="text-[10px] font-semibold text-slate-700 truncate">
                            {src.doc_name || 'Unknown source'}
                          </span>
                          {src.score != null && (
                            <span className="text-[10px] text-slate-500 flex-shrink-0">{Math.round(src.score * 100)}%</span>
                          )}
                        </div>
                        {src.section && (
                          <span className="text-[10px] text-slate-400">§ {src.section}</span>
                        )}
                        {src.excerpt && (
                          <p className="text-[10px] text-slate-600 mt-1 line-clamp-2 leading-snug">
                            "{src.excerpt.slice(0, 140)}{src.excerpt.length > 140 ? '…' : ''}"
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-slate-400 italic text-[11px]">No specific sources traced for this section.</p>
              )}

              {/* Reasoning chain */}
              {reasoningSteps.length > 0 && (
                <div>
                  <PaneLabel>Reasoning chain</PaneLabel>
                  <div className="space-y-1.5">
                    {reasoningSteps.map((step: any, i: number) => {
                      const typeCfg = TRACE_TYPE_LABEL[step.traceType || step.trace_type] || { label: step.traceType || 'Step', cls: 'bg-slate-50 text-slate-600' }
                      const text = step.output || step.inputContext || step.input_context || ''
                      return (
                        <div key={i} className="flex gap-2">
                          <div className="flex-shrink-0 w-4 h-4 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-[9px] font-bold mt-0.5">
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={clsx('inline-block text-[9px] px-1.5 py-0.5 rounded font-semibold mb-0.5', typeCfg.cls)}>{typeCfg.label}</span>
                            {text && (
                              <p className="text-[10px] text-slate-600 line-clamp-2 leading-snug">
                                {typeof text === 'string' ? text.slice(0, 160) : JSON.stringify(text).slice(0, 120)}
                              </p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </Collapsible>

            {/* ── Self-Correction History ── */}
            <Collapsible title="Self-Correction History" icon={<Activity className="w-3.5 h-3.5" />}>
              {loopHistory.length === 0 ? (
                <p className="text-[11px] text-slate-400 italic">Single-pass generation — no refinement iterations recorded.</p>
              ) : (
                <div className="space-y-2">
                  {loopHistory.map((iter: any, i: number) => {
                    const score = iter.score ?? iter.quality_score ?? null
                    const gaps = iter.gap_count ?? (Array.isArray(iter.gaps) ? iter.gaps.length : null)
                    const isCurrent = i === loopHistory.length - 1
                    return (
                      <div key={i} className="flex gap-2">
                        <div className="flex-shrink-0 flex flex-col items-center">
                          <div className={clsx(
                            'w-3 h-3 rounded-full mt-0.5 border-2',
                            isCurrent ? 'border-brand-500 bg-brand-500 animate-pulse'
                              : 'border-slate-400 bg-slate-400',
                          )} />
                          {i < loopHistory.length - 1 && <div className="w-px flex-1 bg-slate-200 mt-1" />}
                        </div>
                        <div className="flex-1 pb-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] font-semibold text-slate-700">Iter {i + 1}</span>
                            {score != null && (
                              <span className={clsx('text-[10px] font-medium', score >= 0.8 ? 'text-emerald-600' : score >= 0.6 ? 'text-amber-600' : 'text-red-600')}>
                                {Math.round(score * 100)}%
                              </span>
                            )}
                            {gaps != null && <span className="text-[10px] text-slate-400">{gaps} gap{gaps !== 1 ? 's' : ''}</span>}
                            {isCurrent && <span className="text-[10px] text-brand-600 font-medium">(current)</span>}
                          </div>
                          {iter.reason && <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-2">{iter.reason}</p>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Collapsible>
          </div>
        </div>

        {/* ════ CENTER: Protocol Source ════ */}
        <div className="flex flex-col border-r border-slate-200 overflow-hidden" style={{ flex: rightPaneOpen ? '0 0 40%' : '1 1 0', minWidth: 0 }}>
          {/* Pane header */}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-slate-50 border-b border-slate-100 flex-shrink-0">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Protocol Source</p>
              <p className="text-xs font-medium text-slate-700 truncate">
                {conversion.protocolFilename
                  ? <span className="font-mono text-[11px]">{conversion.protocolFilename}</span>
                  : <span className="text-slate-400 italic">No document</span>
                }
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Chunk reference tabs — visible in both modes */}
              {chunks.length > 1 && (
                <div className="flex items-center gap-1">
                  {chunks.slice(0, 4).map((chunk, idx) => (
                    <button
                      key={idx}
                      onClick={() => setSelectedChunkIdx(idx)}
                      className={clsx(
                        'flex flex-col items-center px-2 py-0.5 rounded text-[10px] font-medium transition-colors border leading-tight',
                        idx === selectedChunkIdx
                          ? 'bg-brand-500 text-white border-brand-500'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50',
                      )}
                    >
                      <span>{idx + 1}</span>
                      {chunk.page_number != null && (
                        <span className={clsx('text-[9px]', idx === selectedChunkIdx ? 'opacity-75' : 'text-slate-400')}>
                          p{chunk.page_number}
                        </span>
                      )}
                    </button>
                  ))}
                  {chunks.length > 4 && <span className="text-[10px] text-slate-400">+{chunks.length - 4}</span>}
                </div>
              )}
              {/* PDF / Chunks toggle */}
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-[11px]">
                <button
                  onClick={() => setSourceView('chunks')}
                  className={clsx('px-2.5 py-1 transition-colors', sourceView === 'chunks' ? 'bg-brand-500 text-white' : 'text-slate-500 hover:bg-slate-50')}
                >
                  Chunks
                </button>
                <button
                  onClick={() => { if (sourceView !== 'pdf') { setPdfLoading(true); setSourceView('pdf') } }}
                  disabled={!conversion?.protocolDocId}
                  className={clsx('px-2.5 py-1 transition-colors border-l border-slate-200', sourceView === 'pdf' ? 'bg-brand-500 text-white' : 'text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed')}
                >
                  PDF
                </button>
              </div>
            </div>
          </div>

          {/* Pane body */}
          <div className="flex-1 overflow-hidden relative">
            {sourceView === 'pdf' ? (
              /* PDF viewer */
              conversion.protocolDocId ? (
                <>
                  <iframe
                    ref={pdfIframeRef}
                    src={`${INGESTION_URL}/documents/${conversion.protocolDocId}/serve#page=${activeChunk?.page_number ?? 1}&view=FitH`}
                    className="w-full border-0"
                    style={{ height: '100%' }}
                    title="Protocol PDF"
                    onLoad={() => setPdfLoading(false)}
                  />
                  {pdfLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 backdrop-blur-sm z-10">
                      <Loader2 className="w-8 h-8 animate-spin text-brand-400 mb-3" />
                      <p className="text-sm text-slate-500 font-medium">Loading PDF…</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-slate-400">
                  <FileText className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">No document linked to this conversion</p>
                </div>
              )
            ) : (
              /* Chunks view */
              <div className="h-full overflow-y-auto p-4">
                {chunks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <FileText className="w-10 h-10 mb-3 opacity-30" />
                    <p className="text-sm font-medium">No source chunks for this section</p>
                    <p className="text-xs mt-1 text-slate-300">
                      {Object.keys(sectionProvenance).length === 0
                        ? 'Provenance manifest not yet available'
                        : 'The agent did not cite protocol text for this USDM section'}
                    </p>
                  </div>
                ) : activeChunk && (
                  <div className="space-y-4">
                    {/* Metadata chips */}
                    <div className="flex flex-wrap items-center gap-2">
                      {activeChunk.section && (
                        <span className="text-[11px] font-medium bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
                          § {activeChunk.section}
                        </span>
                      )}
                      {activeChunk.page_number != null && (
                        <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full font-medium">
                          Page {activeChunk.page_number}
                        </span>
                      )}
                      {activeChunk.chunk_index != null && (
                        <span className="text-[10px] text-slate-400 font-mono">chunk #{activeChunk.chunk_index}</span>
                      )}
                    </div>

                    {/* Score */}
                    {activeChunk.score != null && (
                      <div>
                        <PaneLabel>Relevance Score</PaneLabel>
                        <ScoreBar score={activeChunk.score} />
                      </div>
                    )}

                    {/* Excerpt / full content */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <PaneLabel>Source Text</PaneLabel>
                        {activeChunk.chunk_id && fullChunkContent[activeChunk.chunk_id] &&
                          fullChunkContent[activeChunk.chunk_id] !== activeChunk.excerpt && (
                          <span className="text-[10px] text-emerald-600 font-medium">Full content</span>
                        )}
                      </div>
                      <blockquote className="bg-slate-50 border-l-4 border-brand-300 rounded-r-xl px-4 py-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                        {(activeChunk.chunk_id && fullChunkContent[activeChunk.chunk_id]) || activeChunk.excerpt}
                      </blockquote>
                    </div>

                    {/* Matched terms */}
                    {Array.isArray(activeChunk.matched_terms) && activeChunk.matched_terms.length > 0 && (
                      <div>
                        <PaneLabel>Matched Terms</PaneLabel>
                        <div className="flex flex-wrap gap-1.5">
                          {activeChunk.matched_terms.map((term, i) => (
                            <span key={i} className="text-[11px] bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full font-medium">
                              {term}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* USDM path */}
                    {activeChunk.usdm_path && (
                      <div>
                        <PaneLabel>USDM Path</PaneLabel>
                        <code className="text-xs font-mono text-slate-500 bg-slate-50 border border-slate-100 px-2 py-1 rounded-lg block">
                          {activeChunk.usdm_path}
                        </code>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ════ RIGHT: Provenance & Similar (collapsible) ════ */}
        {!rightPaneOpen ? (
          <div
            className="group flex flex-col items-center bg-slate-50 border-l border-slate-200 flex-shrink-0 cursor-pointer hover:bg-slate-100 transition-colors"
            style={{ width: '28px' }}
            onClick={() => setRightPaneOpen(true)}
            title="Expand Provenance & Similar"
          >
            <div className="mt-2 p-1 rounded text-slate-400 group-hover:text-brand-600 transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 flex items-center justify-center overflow-hidden">
              <span
                className="text-[10px] font-semibold uppercase tracking-wide text-slate-300 select-none whitespace-nowrap"
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                Provenance & Similar
              </span>
            </div>
          </div>
        ) : (
        <div className="flex flex-col bg-white border-l border-slate-200 flex-shrink-0" style={{ width: '24%', minWidth: 0 }}>
          <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50 border-b border-slate-100 flex-shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Provenance & Similar</p>
              <p className="text-xs font-medium text-slate-700 mt-0.5 truncate">
                {sectionDef?.label || 'Section'} · {shortId}
              </p>
            </div>
            <button
              onClick={() => setRightPaneOpen(false)}
              className="flex-shrink-0 p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
              title="Collapse pane"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4">

            {/* ── A: Extraction Details ── */}
            <div>
              <PaneLabel>Extraction Details</PaneLabel>
              <dl className="space-y-1.5">
                {[
                  { label: 'Model', value: <span className="font-mono text-[10px]">{modelName}</span> },
                  { label: 'Agent', value: agentName },
                  { label: 'Run ID', value: <span className="font-mono text-[10px]">{runShort}</span> },
                  { label: 'Generated', value: fmtDate(generatedAt) },
                ].map(row => (
                  <div key={row.label} className="flex justify-between gap-2">
                    <dt className="text-[11px] text-slate-400 flex-shrink-0">{row.label}</dt>
                    <dd className="text-[11px] text-slate-700 text-right">{row.value}</dd>
                  </div>
                ))}
                {manifest?.quality?.confidence != null && (
                  <div className="pt-1">
                    <PaneLabel>Confidence</PaneLabel>
                    <ScoreBar score={manifest.quality.confidence} />
                  </div>
                )}
              </dl>
            </div>

            {/* ── B: Source Highlight ── */}
            <div className="border-t border-slate-100 pt-3">
              <PaneLabel>Source Highlight</PaneLabel>
              {topChunk ? (
                <div>
                  {topChunk.section && (
                    <span className="text-[10px] text-slate-400 block mb-1">§ {topChunk.section}{topChunk.page_number != null ? ` · Page ${topChunk.page_number}` : ''}</span>
                  )}
                  <blockquote className="text-[11px] text-slate-700 leading-snug italic border-l-2 border-brand-300 pl-2 line-clamp-5">
                    "{topChunk.excerpt.slice(0, 240)}{topChunk.excerpt.length > 240 ? '…' : ''}"
                  </blockquote>
                  <div className="mt-1.5 flex gap-3">
                    <button
                      onClick={() => { setSourceView('chunks'); setSelectedChunkIdx(0) }}
                      className="text-[10px] text-brand-600 hover:text-brand-800 font-medium"
                    >
                      View chunks →
                    </button>
                    {conversion?.protocolDocId && topChunk?.page_number != null && (
                      <button
                        onClick={() => { setSelectedChunkIdx(0); setSourceView('pdf') }}
                        className="text-[10px] text-slate-500 hover:text-slate-700 font-medium"
                      >
                        Open PDF p.{topChunk.page_number} →
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 italic">No source quoted for this section.</p>
              )}
            </div>

            {/* ── C: Similar Past Cases ── */}
            <div className="border-t border-slate-100 pt-3">
              <PaneLabel>Similar Past Cases</PaneLabel>
              {similarConversions.length > 0 ? (
                <div className="space-y-2">
                  {similarConversions.map(c => (
                    <div
                      key={c.id}
                      onClick={() => router.push(`/usdm/${c.id}/workbench`)}
                      className="border border-slate-200 rounded-lg p-2.5 cursor-pointer hover:bg-slate-50 hover:border-brand-200 transition-colors"
                    >
                      <p className="text-[11px] font-semibold text-slate-800 truncate">{c.name}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {c.confidence != null ? `${Math.round(c.confidence * 100)}% confidence · ` : ''}
                        {STATUS_LABEL[c.status] || c.status}
                      </p>
                    </div>
                  ))}
                  <button
                    onClick={() => router.push('/protocols')}
                    className="w-full mt-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-brand-50 text-brand-600 border border-brand-200 hover:bg-brand-100 transition-colors"
                  >
                    Suggest from corpus →
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 italic">No similar past conversions found.</p>
              )}
            </div>

            {/* ── D: Audit Trail ── */}
            <div className="border-t border-slate-100 pt-3">
              <PaneLabel>Audit Trail</PaneLabel>
              <div className="space-y-2 text-[11px] text-slate-600">
                <div className="flex gap-2 items-start">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" />
                  <span>
                    {fmtDate(conversion.createdAt)} — <span className="text-slate-400">Created (auto-extraction)</span>
                  </span>
                </div>
                {auditEvents.map((ev: any, i: number) => (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="w-1.5 h-1.5 rounded-full bg-brand-300 mt-1.5 flex-shrink-0" />
                    <span>
                      {fmtDate(ev.timestamp || ev.created_at)} — <span className="text-brand-600 font-medium">{ev.action || ev.event_type || 'Event'}</span>
                      {ev.actorId && <span className="text-slate-400"> · {ev.actorId}</span>}
                    </span>
                  </div>
                ))}
                {conversion.updatedAt && conversion.updatedAt !== conversion.createdAt && (
                  <div className="flex gap-2 items-start">
                    <div className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" />
                    <span>
                      {fmtDate(conversion.updatedAt)} — <span className="text-slate-400">Last updated ({STATUS_LABEL[conversion.status] || conversion.status})</span>
                    </span>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
        )}
      </div>

      {/* ── Full JSON modal ── */}
      {showJson && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setShowJson(false) }}
        >
          <div className="flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: '80vw', maxWidth: '1100px', height: '85vh' }}
          >
            {/* Modal header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 flex-shrink-0 bg-slate-50">
              <Braces className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-700">Complete USDM JSON</p>
                <p className="text-[11px] text-slate-400 truncate">
                  {conversion.name} · {shortId}
                  {usdmJson && (
                    <span className="ml-2 font-mono">{JSON.stringify(usdmJson).length.toLocaleString()} chars</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(usdmJson, null, 2))
                  setJsonCopied(true)
                  setTimeout(() => setJsonCopied(false), 2000)
                }}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex-shrink-0',
                  jsonCopied
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                )}
              >
                {jsonCopied
                  ? <><Check className="w-3.5 h-3.5" /> Copied</>
                  : <><Copy className="w-3.5 h-3.5" /> Copy</>
                }
              </button>
              <button
                onClick={() => setShowJson(false)}
                className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* JSON body */}
            <div className="flex-1 overflow-auto bg-slate-950 p-5">
              <pre className="text-[12px] leading-relaxed font-mono text-slate-200 whitespace-pre">
                {JSON.stringify(usdmJson, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* ── Agent Insight Tabs — outside the height:100% workbench container so main scrolls to reveal them ── */}
    <div ref={insightsRef} className="-mx-6 bg-white border-t border-slate-200">
      {conversion?.runId ? (
        <div className="px-6 pt-5 pb-6">
          {/* Section label strip shows the icon shortcuts users clicked from the header */}
          <div className="flex items-center gap-2 mb-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Agent Insights</p>
            <div className="flex-1 h-px bg-slate-100" />
          </div>
          <AgentInsightTabs
            runId={conversion.runId}
            orgId={orgId}
            userId={userId}
            runStatus={conversion.status}
            jumpToTab={jumpTab}
            onJumped={() => setJumpTab(null)}
          />
        </div>
      ) : (
        <div className="px-6 py-8 text-center text-slate-400 text-sm">
          No agent run linked — insights will appear after a conversion is run.
        </div>
      )}
    </div>
    </>
  )
}
