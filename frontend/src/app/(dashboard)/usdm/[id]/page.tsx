'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/layout/AuthContext'
import {
  ChevronLeft, CheckCircle, XCircle, Edit2, Save, X, RefreshCw,
  Loader2, AlertCircle, ChevronDown, ChevronRight, FileText,
  Plus, Trash2, Info, Download, Upload, FolderOpen, ShieldCheck, ShieldX,
  ClipboardCheck, BookOpen, MessageSquare, GitCompare, Columns,
} from 'lucide-react'
import { AgentInsightTabs } from '@/components/agent/AgentInsightTabs'

const GRAPHQL_URL        = process.env.NEXT_PUBLIC_GRAPHQL_URL        || 'http://localhost:4000/graphql'
const INGESTION_URL      = process.env.NEXT_PUBLIC_INGESTION_URL      || 'http://localhost:8003'
const AGENT_RUNTIME_URL  = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL  || 'http://localhost:8004'
const ORG_ID             = process.env.NEXT_PUBLIC_ORG_ID             || '00000000-0000-0000-0000-000000000000'

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

// ── Provenance/Derivation Panel ─────────────────────────────────────────────

type ProvenanceEntry = {
  source_ich_section: string
  usdm_path: string
  char_start: number | null
  char_end: number | null
  para_index: number | null
  excerpt: string
  method: string
}

type SectionCorrection = {
  section: string
  usdm_path: string
  before: any
  after: any
  reason: string
  reviewer_id: string
  timestamp: string
}

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

function DerivationPanel({
  sectionKey,
  usdmPath,
  provenanceMap,
  usdmValue,
  onCorrect,
  isDone,
}: {
  sectionKey: string
  usdmPath: string | null
  provenanceMap: Record<string, ProvenanceEntry>
  usdmValue: any
  onCorrect: (correction: SectionCorrection) => void
  isDone: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [editedValue, setEditedValue] = useState('')
  const [showEditor, setShowEditor] = useState(false)

  // Find matching provenance entries for this section
  const prov = Object.entries(provenanceMap).filter(
    ([k]) => k === usdmPath || k.startsWith((usdmPath || sectionKey) + '.') || k.startsWith((usdmPath || sectionKey) + '[')
  )

  if (prov.length === 0) return null

  function submitCorrection(reviewerId: string) {
    let after: any = editedValue
    try { after = JSON.parse(editedValue) } catch {}
    onCorrect({
      section: sectionKey,
      usdm_path: usdmPath || sectionKey,
      before: usdmValue,
      after,
      reason,
      reviewer_id: reviewerId,
      timestamp: new Date().toISOString(),
    })
    setShowEditor(false)
    setReason('')
    setEditedValue('')
  }

  return (
    <div className="mt-2 border border-indigo-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-xs text-indigo-700 font-medium transition-colors"
      >
        <GitCompare className="w-3.5 h-3.5" />
        {open ? 'Hide' : 'Show'} protocol source ({prov.length} match{prov.length !== 1 ? 'es' : ''})
        <span className="ml-auto">{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</span>
      </button>

      {open && (
        <div className="p-3 bg-white space-y-3">
          {/* Side-by-side derivation view */}
          <div className="grid grid-cols-2 gap-3">
            {/* Left: protocol source */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <BookOpen className="w-3.5 h-3.5" /> Protocol Source
              </div>
              {prov.map(([key, entry]) => (
                <div key={key} className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  <div className="text-xs font-medium text-amber-700 mb-1">§ {entry.source_ich_section}</div>
                  <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{entry.excerpt}</p>
                  {entry.char_start != null && (
                    <div className="mt-1.5 text-xs text-slate-400">Chars {entry.char_start}–{entry.char_end} · Para {entry.para_index}</div>
                  )}
                  <div className="mt-1 text-xs text-slate-400">Method: {entry.method}</div>
                </div>
              ))}
            </div>

            {/* Right: USDM derived value */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <FileText className="w-3.5 h-3.5" /> USDM Derived Value
              </div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-2.5">
                <div className="text-xs font-medium text-green-700 mb-1">{usdmPath || sectionKey}</div>
                <pre className="text-xs text-slate-600 whitespace-pre-wrap overflow-x-auto max-h-40">
                  {usdmValue !== undefined ? JSON.stringify(usdmValue, null, 2) : '(empty)'}
                </pre>
              </div>

              {/* Reviewer correction */}
              {!isDone && (
                <div className="mt-2">
                  {!showEditor ? (
                    <button
                      onClick={() => {
                        setEditedValue(usdmValue !== undefined ? JSON.stringify(usdmValue, null, 2) : '')
                        setShowEditor(true)
                      }}
                      className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      <MessageSquare className="w-3.5 h-3.5" /> Add correction
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-slate-600">Corrected value</label>
                      <textarea
                        value={editedValue}
                        onChange={e => setEditedValue(e.target.value)}
                        rows={4}
                        className="w-full font-mono text-xs border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-y"
                      />
                      <label className="text-xs font-medium text-slate-600">Correction reason</label>
                      <textarea
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        rows={2}
                        placeholder="Why is this correction needed?"
                        className="w-full text-xs border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => submitCorrection('reviewer')}
                          disabled={!reason.trim()}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 font-medium"
                        >
                          <Save className="w-3 h-3" /> Save correction
                        </button>
                        <button
                          onClick={() => { setShowEditor(false); setReason(''); setEditedValue('') }}
                          className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── USDM Section definitions ─────────────────────────────────────────────────

const USDM_SECTIONS = [
  { key: 'meta',              label: 'Study Overview',        path: null },
  { key: 'studyIdentifiers',  label: 'Study Identifiers',    path: 'study.studyIdentifiers' },
  { key: 'studyProtocols',    label: 'Protocol Versions',    path: 'study.studyProtocolVersions' },
  { key: 'therapeuticAreas',  label: 'Therapeutic Areas',    path: 'study.businessTherapeuticAreas' },
  { key: 'objectives',        label: 'Objectives',           path: 'study.studyDesigns[0].objectives' },
  { key: 'estimands',         label: 'Estimands',            path: 'study.studyDesigns[0].estimands' },
  { key: 'populations',       label: 'Study Populations',    path: 'study.studyDesigns[0].studyPopulations' },
  { key: 'arms',              label: 'Study Arms',           path: 'study.studyDesigns[0].studyArms' },
  { key: 'epochs',            label: 'Study Epochs',         path: 'study.studyDesigns[0].studyEpochs' },
  { key: 'activities',        label: 'Activities',           path: 'study.studyDesigns[0].activities' },
]

function getPath(obj: any, path: string | null): any {
  if (!path || !obj) return undefined
  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (!cur) return undefined
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/)
    if (arrMatch) {
      cur = cur[arrMatch[1]]?.[parseInt(arrMatch[2])]
    } else {
      cur = cur[part]
    }
  }
  return cur
}

function setPath(obj: any, path: string, value: any): any {
  const parts = path.split('.')
  const clone = JSON.parse(JSON.stringify(obj))
  let cur = clone
  for (let i = 0; i < parts.length - 1; i++) {
    const arrMatch = parts[i].match(/^(\w+)\[(\d+)\]$/)
    if (arrMatch) {
      cur = cur[arrMatch[1]][parseInt(arrMatch[2])]
    } else {
      cur = cur[parts[i]]
    }
  }
  const lastPart = parts[parts.length - 1]
  const lastArr = lastPart.match(/^(\w+)\[(\d+)\]$/)
  if (lastArr) {
    cur[lastArr[1]][parseInt(lastArr[2])] = value
  } else {
    cur[lastPart] = value
  }
  return clone
}

// Fields injected by normalizeUsdmForUi that must be stripped before persisting to server
const USDM_UI_INJECTED_ROOT_FIELDS = [
  'studyVersion', 'studyRationale', 'studyPhase', 'studyType',
  'studyProtocolVersions', 'studyTitle',
  'studyIdentifiers', 'studyDesigns', 'businessTherapeuticAreas',
  'organizations', 'studyRoles', 'abbreviations', 'unstructuredContents',
]

function denormalizeForSave(usdmJson: any): any {
  if (!usdmJson || typeof usdmJson !== 'object') return usdmJson
  const next = JSON.parse(JSON.stringify(usdmJson))
  const study = next.study
  if (study && typeof study === 'object') {
    for (const key of USDM_UI_INJECTED_ROOT_FIELDS) {
      delete study[key]
    }
    next.study = study
  }
  return next
}

function normalizeUsdmForUi(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw
  const next = JSON.parse(JSON.stringify(raw))
  const study = next.study || {}
  const version = (study.versions || [])[0] || {}
  const design = (version.studyDesigns || [])[0] || (study.studyDesigns || [])[0] || {}
  const trialIntent = Array.isArray(design.trialIntentTypes) ? design.trialIntentTypes[0] : null

  // Project version-scoped fields to legacy root paths expected by this page.
  if (!study.studyIdentifiers && version.studyIdentifiers) study.studyIdentifiers = version.studyIdentifiers
  if (!study.studyDesigns && version.studyDesigns) study.studyDesigns = version.studyDesigns
  if (!study.businessTherapeuticAreas && version.businessTherapeuticAreas) {
    study.businessTherapeuticAreas = version.businessTherapeuticAreas
  }
  if (!study.organizations && version.organizations) study.organizations = version.organizations
  if (!study.studyRoles && version.studyRoles) study.studyRoles = version.studyRoles
  if (!study.abbreviations && version.abbreviations) study.abbreviations = version.abbreviations
  if (!study.unstructuredContents && version.unstructuredContents) study.unstructuredContents = version.unstructuredContents

  if (!study.studyVersion && version.versionIdentifier) study.studyVersion = version.versionIdentifier
  if (!study.studyRationale && version.rationale) study.studyRationale = version.rationale
  if (!study.studyPhase && design.studyPhase) study.studyPhase = design.studyPhase
  if (study.studyPhase && typeof study.studyPhase === 'object') {
    const phaseCode = String(study.studyPhase.code || study.studyPhase?.standardCode?.code || '').toUpperCase()
    const phaseDecode = String(study.studyPhase.decode || study.studyPhase?.standardCode?.decode || '').trim()
    const allowedPhaseDecodes = new Set(['Phase 1', 'Phase 1/2', 'Phase 2', 'Phase 2/3', 'Phase 3', 'Phase 4', 'Not Applicable'])
    if (!phaseDecode || !allowedPhaseDecodes.has(phaseDecode)) {
      if (phaseCode === 'UNSPECIFIED' || /not\s+explicitly\s+extracted/i.test(phaseDecode)) {
        study.studyPhase.decode = 'Not Applicable'
      }
    }
  }
  // Alias USDM v4 design keys to the legacy paths used by USDM_SECTIONS display
  if (design.arms && !design.studyArms) design.studyArms = design.arms
  if (design.epochs && !design.studyEpochs) design.studyEpochs = design.epochs
  if (design.population && !design.studyPopulations) {
    design.studyPopulations = Array.isArray(design.population) ? design.population : [design.population]
  }

  // Project design-level studyType to root study (USDM v4 stores it on the design)
  if (!study.studyType && design.studyType) study.studyType = design.studyType

  if (!study.studyType) {
    const trialIntentDecode = String(trialIntent?.decode || '').toLowerCase()
    const hasInterventions = Array.isArray(design.studyInterventions) && design.studyInterventions.length > 0
    if (trialIntentDecode.includes('treatment') || hasInterventions) {
      study.studyType = { decode: 'Interventional' }
    } else if (trialIntentDecode.includes('observ')) {
      study.studyType = { decode: 'Observational' }
    } else if (trialIntentDecode.includes('expanded access')) {
      study.studyType = { decode: 'Expanded Access' }
    }
  }

  // Backfill legacy protocol-version view model from StudyVersion/documentVersions.
  if (!study.studyProtocolVersions) {
    const official = (version.titles || []).find((t: any) => t?.type?.decode?.toLowerCase()?.includes('official'))
    const brief = (version.titles || []).find((t: any) => t?.type?.decode?.toLowerCase()?.includes('brief'))
    const docv = (version.documentVersions || [])[0] || {}
    const approvalDate = ((version.dateValues || []).find((d: any) => d?.dateValue)?.dateValue) || ''
    study.studyProtocolVersions = [{
      briefTitle: brief?.text || official?.text || '',
      officialTitle: official?.text || brief?.text || '',
      versionIdentifier: version.versionIdentifier || docv.version || '',
      protocolStatus: docv?.status?.decode || '',
      protocolEffectiveDate: approvalDate,
      documentVersionId: docv?.documentVersionId || '',
    }]
  }

  if (!study.studyTitle) {
    // Level 1: version.titles[] — populated for all conversions after the titles fix
    if (Array.isArray(version.titles) && version.titles.length > 0) {
      const official = version.titles.find((t: any) => t?.type?.decode?.toLowerCase()?.includes('official'))
      study.studyTitle = (official || version.titles[0])?.text || ''
    }
  }
  if (!study.studyTitle) {
    // Level 2: documentVersions[0] briefTitle/officialTitle (present when protocol effective date was set)
    const dv0 = Array.isArray(version.documentVersions) ? version.documentVersions[0] : null
    if (dv0 && typeof dv0 === 'object') {
      study.studyTitle = (dv0 as any).officialTitle || (dv0 as any).briefTitle || ''
    }
  }
  if (!study.studyTitle && Array.isArray(study.studyProtocolVersions)) {
    // Level 3: studyProtocolVersions[0] (built earlier in this function from version.documentVersions)
    const pv0 = (study.studyProtocolVersions as any[])[0]
    if (pv0 && typeof pv0 === 'object') {
      study.studyTitle = pv0.officialTitle || pv0.briefTitle || ''
    }
  }

  next.study = study
  return next
}

// ── JSON tree viewer/editor ───────────────────────────────────────────────────

function JsonArrayEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const arr = Array.isArray(value) ? value : []
  return (
    <div className="space-y-2">
      {arr.map((item, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <div className="flex-1 bg-slate-50 border border-slate-200 rounded-lg p-2">
            <textarea
              value={typeof item === 'object' ? JSON.stringify(item, null, 2) : String(item)}
              onChange={e => {
                try {
                  const parsed = JSON.parse(e.target.value)
                  const next = [...arr]; next[idx] = parsed; onChange(next)
                } catch {
                  const next = [...arr]; next[idx] = e.target.value; onChange(next)
                }
              }}
              rows={typeof item === 'object' && item !== null ? Math.min(Object.keys(item).length + 2, 10) : 2}
              className="w-full font-mono text-xs bg-transparent border-none focus:outline-none resize-y"
            />
          </div>
          <button onClick={() => { const next = arr.filter((_, i) => i !== idx); onChange(next) }}
            className="mt-1 p-1 text-slate-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
        </div>
      ))}
      <button
        onClick={() => onChange([...arr, {}])}
        className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700 font-medium"
      >
        <Plus className="w-3.5 h-3.5" /> Add item
      </button>
    </div>
  )
}

function StudyIdentifiersEditor({
  value, onChange, fieldQualityMap,
}: { value: any[]; onChange: (v: any[]) => void; fieldQualityMap?: Record<string, string> }) {
  const arr = Array.isArray(value) ? value : []

  function idQuality(idx: number): 'verified' | 'hallucinated' | 'unverified' | null {
    if (!fieldQualityMap) return null
    const hit = Object.entries(fieldQualityMap).find(([k]) => k.includes(`studyIdentifiers[${idx}]`))
    return hit ? (hit[1] as 'verified' | 'hallucinated' | 'unverified') : null
  }

  return (
    <div className="space-y-2">
      {arr.map((item, idx) => {
        const idVal = typeof item === 'object' && item !== null ? (item.studyIdentifier || '') : String(item)
        const scheme = typeof item === 'object' && item !== null
          ? (item.studyIdentifierScope?.organizationIdentifierScheme || '')
          : ''
        const quality = idQuality(idx)
        return (
          <div key={idx} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-medium text-slate-700 truncate">{idVal || '(empty)'}</span>
                {scheme && <span className="text-[10px] text-slate-400 truncate">{scheme}</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <QualityBadge status={quality} />
                <button onClick={() => { const next = arr.filter((_, i) => i !== idx); onChange(next) }}
                  className="p-0.5 text-slate-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <textarea
              value={typeof item === 'object' ? JSON.stringify(item, null, 2) : String(item)}
              onChange={e => {
                try {
                  const parsed = JSON.parse(e.target.value)
                  const next = [...arr]; next[idx] = parsed; onChange(next)
                } catch {
                  const next = [...arr]; next[idx] = e.target.value; onChange(next)
                }
              }}
              rows={typeof item === 'object' && item !== null ? Math.min(Object.keys(item).length + 1, 8) : 2}
              className="w-full font-mono text-xs bg-white border border-slate-200 rounded p-2 focus:outline-none resize-y"
            />
          </div>
        )
      })}
      <button
        onClick={() => onChange([...arr, {}])}
        className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700 font-medium"
      >
        <Plus className="w-3.5 h-3.5" /> Add identifier
      </button>
    </div>
  )
}

function SectionPanel({
  label, sectionKey, value, onChange, sourceChunks, fieldQualityMap, editable = true
}: { label: string; sectionKey: string; value: any; onChange: (v: any) => void; sourceChunks?: SectionSourceChunk[]; fieldQualityMap?: Record<string, string>; editable?: boolean }) {
  const [open, setOpen] = useState(sectionKey === 'meta')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<'extracted' | 'source'>('extracted')

  function startEdit() {
    setDraft(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? ''))
    setEditing(true)
  }

  function saveEdit() {
    try {
      onChange(JSON.parse(draft))
    } catch {
      onChange(draft)
    }
    setEditing(false)
  }

  const isEmpty = value === undefined || value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
  const sourceCount = (sourceChunks || []).length

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          <span className="text-sm font-medium text-slate-700">{label}</span>
          <button
            onClick={e => {
              e.stopPropagation()
              setOpen(true)
              setTab('source')
            }}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
              sourceCount > 0
                ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
            title={sourceCount > 0 ? `Show ${sourceCount} source excerpt${sourceCount !== 1 ? 's' : ''}` : 'No source excerpt mapped yet'}
          >
            <BookOpen className="w-3 h-3" />
            Source{sourceCount > 0 ? ` (${sourceCount})` : ''}
          </button>
          {isEmpty && <span className="text-xs text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded font-medium">Empty</span>}
          {!isEmpty && Array.isArray(value) && <span className="text-xs text-slate-400">{value.length} item{value.length !== 1 ? 's' : ''}</span>}
        </div>
        {!editing && editable && (
          <button
            onClick={e => { e.stopPropagation(); startEdit() }}
            className="p-1 text-slate-400 hover:text-brand-500 transition-colors"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 pb-4 bg-white border-t border-slate-100">
          <div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs font-medium">
            <button
              onClick={() => setTab('extracted')}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                tab === 'extracted' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Extracted
            </button>
            <button
              onClick={() => setTab('source')}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                tab === 'source' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Source
            </button>
          </div>

          {tab === 'source' ? (
            <div className="mt-3 space-y-3">
              {(sourceChunks || []).length > 0 ? (
                sourceChunks!.map((chunk, idx) => (
                  <div key={`${chunk.chunk_id || chunk.chunk_index || idx}`} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-amber-800">{chunk.section || 'Protocol section'}</span>
                      {chunk.page_number != null && <span className="text-amber-700">Page {chunk.page_number}</span>}
                      {chunk.chunk_index != null && <span className="text-amber-700">Chunk {chunk.chunk_index}</span>}
                      {typeof chunk.score === 'number' && <span className="text-amber-700">Match {Math.round(chunk.score)}</span>}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-700">{chunk.excerpt}</p>
                    {!!chunk.matched_terms?.length && (
                      <div className="mt-2 text-xs text-slate-500">
                        Matched on: {chunk.matched_terms.join(', ')}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs italic text-slate-500">
                  Source text is not available for this section yet.
                </div>
              )}
            </div>
          ) : editing ? (
            <div className="mt-3 space-y-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={Math.min(draft.split('\n').length + 2, 20)}
                className="w-full font-mono text-xs border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-brand-300 resize-y bg-slate-50"
              />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 font-medium">
                  <Save className="w-3 h-3" /> Save
                </button>
                <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">
                  <X className="w-3 h-3" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              {sectionKey === 'meta' ? (
                <MetaEditor value={value} onChange={onChange} />
              ) : sectionKey === 'studyIdentifiers' && Array.isArray(value) ? (
                <StudyIdentifiersEditor value={value} onChange={onChange} fieldQualityMap={fieldQualityMap} />
              ) : Array.isArray(value) ? (
                <JsonArrayEditor value={value} onChange={onChange} />
              ) : isEmpty ? (
                <p className="text-xs text-slate-400 italic">No data. Click edit to add content.</p>
              ) : (
                <pre className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(value, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fieldQuality(usdm: any, qualityPath: string): 'verified' | 'hallucinated' | 'unverified' | null {
  const fq = usdm?.provenance?.field_quality
  if (!fq || typeof fq !== 'object') return null
  const hit = Object.entries(fq).find(([k]) => k === qualityPath || k.endsWith(qualityPath))
  return hit ? (hit[1] as 'verified' | 'hallucinated' | 'unverified') : null
}

function QualityBadge({ status }: { status: 'verified' | 'hallucinated' | 'unverified' | null }) {
  if (!status) return null
  if (status === 'verified')
    return <span className="ml-1.5 inline-flex items-center text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-px">✓ Verified</span>
  if (status === 'hallucinated')
    return <span className="ml-1.5 inline-flex items-center text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded px-1 py-px">⚠ Not in source</span>
  return <span className="ml-1.5 inline-flex items-center text-[10px] text-slate-400 bg-slate-50 border border-slate-200 rounded px-1 py-px">◯ Unverified</span>
}

function MetaEditor({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const study = value?.study || {}
  const allowedStudyPhases = ['Phase 1', 'Phase 1/2', 'Phase 2', 'Phase 2/3', 'Phase 3', 'Phase 4', 'Not Applicable']
  const rawPhaseDecode = String(study.studyPhase?.decode || study.studyPhase?.standardCode?.decode || '').trim()
  const showCustomPhase = rawPhaseDecode.length > 0 && !allowedStudyPhases.includes(rawPhaseDecode)
  function update(field: string, val: string) {
    onChange({ ...value, study: { ...study, [field]: val } })
  }
  function updateNested(field: string, subField: string, val: string) {
    onChange({ ...value, study: { ...study, [field]: { ...(study[field] || {}), [subField]: val } } })
  }

  return (
    <div className="space-y-3">
      {[
        { label: 'Study Title', field: 'studyTitle', type: 'text', qualityPath: '.study.studyTitle' },
        { label: 'Acronym', field: 'studyAcronym', type: 'text', qualityPath: '.study.studyAcronym' },
        { label: 'Version', field: 'studyVersion', type: 'text', qualityPath: '.study.versionIdentifier' },
        { label: 'Study Rationale', field: 'studyRationale', type: 'textarea', qualityPath: '.study.studyRationale' },
      ].map(({ label, field, type, qualityPath }) => (
        <div key={field}>
          <label className="flex items-center text-xs font-medium text-slate-600 mb-1">
            {label}
            <QualityBadge status={fieldQuality(value, qualityPath)} />
          </label>
          {type === 'textarea' ? (
            <textarea
              value={study[field] || ''}
              onChange={e => update(field, e.target.value)}
              rows={3}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none"
            />
          ) : (
            <input
              value={study[field] || ''}
              onChange={e => update(field, e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
            />
          )}
        </div>
      ))}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="flex items-center text-xs font-medium text-slate-600 mb-1">
            Study Type
            <QualityBadge status={fieldQuality(value, '.study.studyType')} />
          </label>
          <select
            value={study.studyType?.decode || ''}
            onChange={e => updateNested('studyType', 'decode', e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
          >
            <option value="">— select —</option>
            {['Interventional', 'Observational', 'Expanded Access'].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="flex items-center text-xs font-medium text-slate-600 mb-1">
            Study Phase
            <QualityBadge status={fieldQuality(value, '.study.studyPhaseLabel')} />
          </label>
          <select
            value={study.studyPhase?.decode || study.studyPhase?.standardCode?.decode || ''}
            onChange={e => updateNested('studyPhase', 'decode', e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
          >
            <option value="">— select —</option>
            {showCustomPhase ? <option value={rawPhaseDecode}>{rawPhaseDecode}</option> : null}
            {allowedStudyPhases.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
    </div>
  )
}

// ── USDM Compliance Scorecard ─────────────────────────────────────────────────

function USDMComplianceScorecard({ usdmJson }: { usdmJson: any }) {
  if (!usdmJson || Object.keys(usdmJson).length === 0) return null

  const sectionStatus = USDM_SECTIONS.map(s => {
    let val: any
    if (s.key === 'meta') {
      // meta is covered when top-level study title or design exists
      val = usdmJson?.study?.studyTitle || usdmJson?.study?.studyDesigns?.length
    } else {
      val = getPath(usdmJson, s.path!)
    }
    const covered = val !== undefined && val !== null &&
      !(Array.isArray(val) && val.length === 0) &&
      !(typeof val === 'object' && !Array.isArray(val) && Object.keys(val ?? {}).length === 0) &&
      val !== ''
    return { ...s, covered }
  })

  const coveredCount = sectionStatus.filter(s => s.covered).length
  const total = USDM_SECTIONS.length
  const pct = Math.round((coveredCount / total) * 100)
  const barCls = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400'
  const badgeCls = pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-700">USDM v4.0 Compliance Scorecard</span>
          <span className="text-[10px] text-slate-400 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded font-mono">L5.E12 Completeness</span>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${badgeCls}`}>{pct}% field coverage</span>
      </div>
      <div className="px-4 pb-4 bg-white border-t border-slate-100">
        <div className="mt-3 mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-slate-500">Required Sections Populated</span>
            <span className="text-xs font-semibold text-slate-600">{coveredCount} / {total}</span>
          </div>
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barCls}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
          {sectionStatus.map(s => (
            <div key={s.key} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs ${
              s.covered ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
            }`}>
              {s.covered
                ? <CheckCircle className="w-3 h-3 flex-shrink-0" />
                : <XCircle className="w-3 h-3 flex-shrink-0" />}
              <span className="truncate">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Document Selection Step ───────────────────────────────────────────────────

interface ValidationResult {
  isValidProtocol: boolean
  confidence: number
  matchedIndicators: string[]
  wordCount?: number
  error?: string
}

interface SelectedDoc {
  id: string
  file_name: string
  s3_key: string   // bronze_s3_key for existing docs, or uploaded s3_key
  source: 'existing' | 'uploaded'
}

function DocumentSelectionStep({
  conversionId, conversionName, orgId, studyId, userId,
  approvalId, runId,
  onStarted,
}: {
  conversionId: string
  conversionName: string
  orgId: string
  studyId?: string
  userId?: string
  approvalId?: string   // set when agent initiated the HITL pause
  runId?: string
  onStarted: () => void
}) {
  const [tab, setTab] = useState<'existing' | 'upload'>('existing')
  const [docs, setDocs] = useState<any[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [selectedDoc, setSelectedDoc] = useState<SelectedDoc | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [croReviewerId, setCroReviewerId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const params = new URLSearchParams({ org_id: orgId })
    if (studyId) params.set('study_id', studyId)
    fetch(`${INGESTION_URL}/documents?${params}`)
      .then(r => r.json())
      .then(res => {
        const filtered = (res.documents || []).filter((d: any) =>
          /\.(pdf|docx|doc|txt|md)$/i.test(d.file_name || ''))
        setDocs(filtered)
      })
      .catch(() => {})
      .finally(() => setDocsLoading(false))
  }, [orgId, studyId])

  async function selectExisting(doc: any) {
    const sel: SelectedDoc = {
      id: doc.id,
      file_name: doc.file_name,
      s3_key: doc.bronze_s3_key || '',
      source: 'existing',
    }
    setSelectedDoc(sel)
    setValidation(null)
    await runValidation(sel.s3_key, sel.file_name)
  }

  async function handleFileSelect(file: File) {
    if (!/\.(pdf|docx|doc|txt|md)$/i.test(file.name)) {
      setValidation({ isValidProtocol: false, confidence: 0, matchedIndicators: [], error: 'Unsupported file type. Use PDF, Word, or text files.' })
      return
    }
    setUploadedFile(file)
    setSelectedDoc(null)
    setValidation(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('org_id', orgId)
      form.append('document_type', 'protocol')
      form.append('uploaded_by', userId || orgId)
      const res = await fetch(`${INGESTION_URL}/documents/upload`, { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) {
        // 409 = duplicate: use the existing document, skip re-validation
        // (document was already validated on first upload; re-running validation
        //  against an existing s3 key can return 400 from the validator service)
        if (res.status === 409 && json.existing_document_id) {
          const sel: SelectedDoc = {
            id: json.existing_document_id,
            file_name: file.name,
            s3_key: json.s3_key || '',
            source: 'existing',
          }
          setSelectedDoc(sel)
          setUploading(false)
          // Mark as valid with a note — no need to re-validate an existing document
          setValidation({
            isValidProtocol: true,
            confidence: 1,
            matchedIndicators: [],
            wordCount: 0,
            error: null,
            _duplicate: true,
          } as any)
          return
        }
        throw new Error(json.detail || json.message || 'Upload failed')
      }
      const sel: SelectedDoc = {
        id: json.document_id,
        file_name: file.name,
        s3_key: json.s3_key,
        source: 'uploaded',
      }
      setSelectedDoc(sel)
      setUploading(false)
      await runValidation(sel.s3_key, file.name)
    } catch (e: any) {
      setUploading(false)
      setValidation({ isValidProtocol: false, confidence: 0, matchedIndicators: [], error: e.message })
    }
  }

  async function runValidation(s3Key: string, filename: string) {
    if (!s3Key) return
    setValidating(true)
    try {
      const data = await gql(`
        query($s3Key: String!, $filename: String!) {
          validateProtocolDoc(s3Key: $s3Key, filename: $filename) {
            isValidProtocol confidence matchedIndicators wordCount error
          }
        }
      `, { s3Key, filename })
      setValidation(data.validateProtocolDoc)
    } catch (e: any) {
      setValidation({ isValidProtocol: false, confidence: 0, matchedIndicators: [], error: e.message })
    } finally {
      setValidating(false)
    }
  }

  async function startConversion() {
    if (!selectedDoc) return
    setStarting(true)
    try {
      if (approvalId && runId) {
        // Agent-initiated HITL: resume the paused run with the selected doc
        await gql(`
          mutation($runId: String!, $approvalId: String!, $decision: String!, $modifiedSpec: JSON, $decidedBy: String!, $reviewerRole: String) {
            resumeAgentRun(runId: $runId, approvalId: $approvalId, decision: $decision, modifiedSpec: $modifiedSpec, decidedBy: $decidedBy, reviewerRole: $reviewerRole)
          }
        `, {
          runId,
          approvalId,
          decision: 'approved',
          modifiedSpec: {
            protocol_doc_id: selectedDoc.id,
            protocol_filename: selectedDoc.file_name,
            protocol_s3_key: selectedDoc.s3_key,
            cro_reviewer_id: croReviewerId.trim() || null,
          },
          decidedBy: userId || 'user',
          reviewerRole: 'sponsor',
        })
      } else {
        // Draft flow: attach doc and start a new run
        await gql(`
          mutation($id: ID!, $protocolDocId: String!, $protocolFilename: String!, $protocolS3Key: String!, $createdBy: String, $croReviewerId: String) {
            beginUsdmConversion(id: $id, protocolDocId: $protocolDocId, protocolFilename: $protocolFilename, protocolS3Key: $protocolS3Key, createdBy: $createdBy, croReviewerId: $croReviewerId) { id }
          }
        `, {
          id: conversionId,
          protocolDocId: selectedDoc.id,
          protocolFilename: selectedDoc.file_name,
          protocolS3Key: selectedDoc.s3_key,
          createdBy: userId,
          croReviewerId: croReviewerId.trim() || null,
        })
      }
      onStarted()
    } catch (e: any) {
      setValidation(v => ({ ...v!, error: e.message }))
    } finally {
      setStarting(false)
    }
  }

  const canStart = selectedDoc && !uploading && !validating && !starting

  return (
    <div className="space-y-5">
      {/* Step banner */}
      <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 flex items-start gap-3">
        <div className="w-7 h-7 bg-brand-500 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">1</div>
        <div>
          <p className="text-sm font-semibold text-brand-900">Step 1 of 2 — Select Protocol Document</p>
          <p className="text-xs text-brand-700 mt-0.5">
            Choose an existing uploaded document or upload a new protocol file from your computer.
            The document will be validated before the AI conversion starts.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setTab('existing')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors ${
              tab === 'existing' ? 'border-b-2 border-brand-500 text-brand-600' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <FolderOpen className="w-4 h-4" /> Select from uploads
          </button>
          <button
            onClick={() => setTab('upload')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors ${
              tab === 'upload' ? 'border-b-2 border-brand-500 text-brand-600' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Upload className="w-4 h-4" /> Upload from PC
          </button>
        </div>

        <div className="p-4">
          {tab === 'existing' ? (
            docsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 py-4 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading documents…
              </div>
            ) : docs.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No PDF/Word/text documents found.</p>
                <p className="text-xs mt-1">Upload one in the Documents section, or use the Upload tab.</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {docs.map((d: any) => (
                  <button
                    key={d.id}
                    onClick={() => selectExisting(d)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors flex items-center gap-3 ${
                      selectedDoc?.id === d.id
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-slate-200 hover:border-slate-300 text-slate-600'
                    }`}
                  >
                    <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{d.file_name}</div>
                      <div className="text-xs text-slate-400">{d.document_type || 'document'}</div>
                    </div>
                    {selectedDoc?.id === d.id && <CheckCircle className="w-4 h-4 text-brand-500 flex-shrink-0" />}
                  </button>
                ))}
              </div>
            )
          ) : (
            /* Upload from PC */
            <div>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault(); setDragOver(false)
                  const file = e.dataTransfer.files[0]
                  if (file) handleFileSelect(file)
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  dragOver ? 'border-brand-400 bg-brand-50' : 'border-slate-300 hover:border-brand-300 hover:bg-slate-50'
                }`}
              >
                <Upload className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                <p className="text-sm font-medium text-slate-600">Drop a protocol document here</p>
                <p className="text-xs text-slate-400 mt-1">or click to browse — PDF, Word (.docx/.doc), or text files</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.doc,.txt,.md"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }}
                />
              </div>
              {uploadedFile && (
                <div className="mt-3 flex items-center gap-2 text-sm text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
                  <FileText className="w-4 h-4 text-brand-500 flex-shrink-0" />
                  <span className="truncate font-medium">{uploadedFile.name}</span>
                  {uploading && <Loader2 className="w-4 h-4 animate-spin text-brand-500 ml-auto flex-shrink-0" />}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Validation result */}
      {(validating || validation) && (
        <div className={`rounded-xl border p-4 ${
          validating ? 'border-slate-200 bg-slate-50' :
          validation?.error ? 'border-red-200 bg-red-50' :
          (validation as any)?._duplicate ? 'border-blue-200 bg-blue-50' :
          validation?.isValidProtocol ? 'border-green-200 bg-green-50' :
          'border-amber-200 bg-amber-50'
        }`}>
          {validating ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Validating document — checking for clinical protocol content…
            </div>
          ) : validation?.error ? (
            <div className="flex items-start gap-2">
              <ShieldX className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-700">Validation error</p>
                <p className="text-xs text-red-600 mt-0.5">{validation.error}</p>
              </div>
            </div>
          ) : (validation as any)?._duplicate ? (
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-blue-800">Document already uploaded — using existing copy</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  This file was previously uploaded to your organisation. The existing version will be used for the conversion.
                </p>
              </div>
            </div>
          ) : validation?.isValidProtocol ? (
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-green-800">
                  Protocol document confirmed ({Math.round((validation.confidence || 0) * 100)}% confidence)
                </p>
                {validation.wordCount && (
                  <p className="text-xs text-green-700 mt-0.5">{validation.wordCount.toLocaleString()} words</p>
                )}
                {validation.matchedIndicators?.length > 0 && (
                  <p className="text-xs text-green-600 mt-1">
                    Detected: {validation.matchedIndicators.slice(0, 5).join(', ')}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">Protocol content not detected</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  This document may not be a clinical trial protocol. You can still proceed, but results may be poor.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <label className="block text-sm font-medium text-slate-700 mb-1">CRO Reviewer ID</label>
        <input
          value={croReviewerId}
          onChange={e => setCroReviewerId(e.target.value)}
          placeholder="Optional: route final sign-off to a CRO reviewer"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
        <p className="mt-1 text-xs text-slate-500">Leave blank for the standard single-review flow.</p>
      </div>

      {/* Standards mapping pre-flight banner */}
      {selectedDoc && !uploading && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-800">Review Standards Mapping (recommended)</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Verify how each protocol section maps to the USDM IG, ICH M11, and CDISC CT codelists before conversion.
            </p>
          </div>
          <a
            href={`/standards/terminology?protocol_doc_id=${encodeURIComponent(selectedDoc.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-slate-700 text-xs font-medium rounded-lg hover:bg-white whitespace-nowrap flex-shrink-0 transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" /> View Mapping
          </a>
        </div>
      )}

      {/* Start button */}
      {selectedDoc && !uploading && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-slate-500">
            Selected: <span className="font-medium text-slate-700">{selectedDoc.file_name}</span>
          </div>
          <button
            onClick={startConversion}
            disabled={!canStart || starting}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-40 transition-colors"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
            {starting ? 'Starting…' : 'Start USDM Conversion'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function UsdmReviewPage() {
  const { id } = useParams() as { id: string }
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID

  const [conversion, setConversion] = useState<any>(null)
  const [usdmJson, setUsdmJson] = useState<any>({})
  const [provenanceMap, setProvenanceMap] = useState<Record<string, ProvenanceEntry>>({})
  const [sectionProvenance, setSectionProvenance] = useState<Record<string, SectionSourceChunk[]>>({})
  const [corrections, setCorrections] = useState<SectionCorrection[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [showRejectPanel, setShowRejectPanel] = useState(false)
  const [restart, setRestart] = useState(false)
  const [toast, setToast] = useState('')
  const [polling, setPolling] = useState(false)
  const [contentTab, setContentTab] = useState<'sections' | 'raw'>('sections')

  const load = useCallback(async () => {
    try {
      const data = await gql(
        `query($id: ID!) { usdmConversion(id: $id) {
          id name status protocolFilename protocolDocId runId approvalId studyId
          usdmJson errorMessage createdAt updatedAt
          confidence evalAccuracy evalCompleteness evalStandards evalHallucination evalReadability
        }}`,
        { id }
      )
      const conv = data.usdmConversion
      setConversion(conv)
      if (conv?.usdmJson && Object.keys(conv.usdmJson).length > 0) {
        const _normalized = normalizeUsdmForUi(conv.usdmJson)
        if (!_normalized?.study?.studyTitle && conv.name) {
          if (_normalized.study) _normalized.study.studyTitle = conv.name
        }
        setUsdmJson(_normalized)
      }
      // Fetch provenance manifest once a runId is available
      if (conv?.runId) {
        fetch(`${AGENT_RUNTIME_URL}/runs/${conv.runId}/provenance-manifest`)
          .then(r => r.ok ? r.json() : null)
          .then(manifest => {
            if (manifest?.provenance_map) setProvenanceMap(manifest.provenance_map)
            if (manifest?.section_provenance) setSectionProvenance(manifest.section_provenance)
          })
          .catch(() => {})
      }
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  // Poll while running or pending
  useEffect(() => {
    if (!conversion) return
    if (['running', 'pending'].includes(conversion.status)) {
      setPolling(true)
      const t = setInterval(load, 4000)
      return () => { clearInterval(t); setPolling(false) }
    }
    setPolling(false)
  }, [conversion?.status, load])

  async function saveEdits() {
    setSaving(true)
    try {
      await gql(`
        mutation($id: ID!, $usdmJson: JSON!) { updateUsdmConversion(id: $id, usdmJson: $usdmJson) { id } }
      `, { id, usdmJson: denormalizeForSave(usdmJson) })
      showToast('Changes saved')
    } catch (e: any) { showToast('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }

  async function decide(decision: 'approved' | 'modified' | 'rejected') {
    if (!conversion?.runId || !conversion?.approvalId) return
    const decidingKey = decision === 'rejected' ? 'reject' : 'approve'
    setDeciding(decidingKey)
    try {
      if (decision !== 'rejected') {
        await gql(`mutation($id: ID!, $usdmJson: JSON!, $corrections: JSON) { updateUsdmConversion(id: $id, usdmJson: $usdmJson, corrections: $corrections) { id } }`,
          { id, usdmJson: denormalizeForSave(usdmJson), corrections: corrections.length > 0 ? corrections : null })
      }
      const resumeResult = await gql(`
        mutation($runId: String!, $approvalId: String!, $decision: String!, $modifiedSpec: JSON, $decidedBy: String!, $reviewerRole: String, $note: String, $restart: Boolean) {
          resumeAgentRun(runId: $runId, approvalId: $approvalId, decision: $decision, modifiedSpec: $modifiedSpec, decidedBy: $decidedBy, reviewerRole: $reviewerRole, note: $note, restart: $restart)
        }
      `, {
        runId: conversion.runId,
        approvalId: conversion.approvalId,
        decision,
        modifiedSpec: decision !== 'rejected' ? { ...denormalizeForSave(usdmJson), _corrections: corrections } : null,
        decidedBy: user?.id || 'user',
        reviewerRole: (searchParams.get('role') === 'cro' || conversion.status === 'waiting_cro_approval') ? 'cro' : 'sponsor',
        note: rejectNote,
        restart,
      })
      const nextStatus = resumeResult?.resumeAgentRun?.status
      showToast(
        decision === 'rejected'
          ? 'Conversion rejected'
          : nextStatus === 'waiting_approval' && !isCROMode
            ? 'Sponsor review complete. Routed for CRO sign-off.'
            : isCROMode
              ? 'CRO sign-off recorded.'
              : 'USDM mapping approved!'
      )
      // Immediately reflect the new status so buttons are hidden and polling starts
      const optimisticStatus =
        decision === 'rejected'
          ? 'rejected'
          : nextStatus === 'waiting_approval' && !isCROMode
            ? 'waiting_approval'
            : 'running'
      setConversion((c: any) => ({ ...c, status: optimisticStatus }))
      setTimeout(load, 2000)
    } catch (e: any) { showToast('Error: ' + e.message) }
    finally { setDeciding(null); setShowRejectPanel(false) }
  }

  function handleSectionChange(section: typeof USDM_SECTIONS[0], value: any) {
    if (!section.path) {
      setUsdmJson(value)
      return
    }
    setUsdmJson((prev: any) => setPath(prev, section.path!, value))
  }

  function showToast(msg: string) {
    setToast(msg); setTimeout(() => setToast(''), 3000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading conversion…
      </div>
    )
  }

  if (!conversion) {
    return <div className="text-center py-24 text-slate-400">Conversion not found.</div>
  }

  const isSelectingDoc = conversion.status === 'selecting_document'
  const isReviewable   = ['waiting_approval', 'waiting_cro_approval'].includes(conversion.status)
  const isRunning      = ['running', 'pending'].includes(conversion.status)
  const isDone         = ['approved', 'completed', 'rejected', 'failed'].includes(conversion.status)
  const isCROMode      = searchParams.get('role') === 'cro' || conversion.status === 'waiting_cro_approval'

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/usdm')} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-slate-800 truncate">{conversion.name}</h1>
          {conversion.protocolFilename && (
            <p className="text-sm text-slate-500 truncate">{conversion.protocolFilename}</p>
          )}
        </div>
        {/* Workbench button */}
        {conversion?.runId && (
          <button
            onClick={() => router.push(`/usdm/${id}/workbench`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <Columns className="w-3.5 h-3.5" />
            Workbench
          </button>
        )}
        {/* Download button */}
        {['approved','completed'].includes(conversion.status) && (
          <a
            href={`${process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'}/usdm/${id}/download`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Download USDM JSON
          </a>
        )}
        {/* Status badge */}
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
          isSelectingDoc ? 'bg-brand-50 text-brand-700 border border-brand-200' :
          conversion.status === 'waiting_cro_approval' ? 'bg-orange-50 text-orange-700 border border-orange-200' :
          isReviewable ? 'bg-amber-50 text-amber-700 border border-amber-200' :
          isRunning ? 'bg-blue-50 text-blue-700 border border-blue-200' :
          ['approved','completed'].includes(conversion.status) ? 'bg-green-50 text-green-700 border border-green-200' :
          'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
          {isSelectingDoc && <FileText className="w-3 h-3" />}
          {isReviewable && <AlertCircle className="w-3 h-3" />}
          {['approved','completed'].includes(conversion.status) && <CheckCircle className="w-3 h-3" />}
          {['rejected','failed'].includes(conversion.status) && <XCircle className="w-3 h-3" />}
          {conversion.status.replace(/_/g, ' ')}
          {polling && <RefreshCw className="w-3 h-3 animate-spin ml-0.5" />}
        </div>
      </div>

      {/* Step 1 — document selection */}
      {isSelectingDoc && (
        <DocumentSelectionStep
          conversionId={id}
          conversionName={conversion.name}
          orgId={orgId}
          studyId={conversion.studyId}
          userId={user?.id}
          approvalId={conversion.approvalId}
          runId={conversion.runId}
          onStarted={() => {
            setConversion((c: any) => ({ ...c, status: 'pending' }))
            load()
          }}
        />
      )}

      {/* Running state */}
      {isRunning && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-blue-500 animate-spin flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-800">AI is processing your protocol…</p>
            <p className="text-xs text-blue-600 mt-0.5">This usually takes 1–3 minutes. This page auto-refreshes.</p>
          </div>
        </div>
      )}

      {/* Failed state */}
      {conversion.status === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm font-medium text-red-800">Conversion failed</p>
          {conversion.errorMessage && <p className="text-xs text-red-600 mt-1 font-mono">{conversion.errorMessage}</p>}
        </div>
      )}

      {/* Review banner */}
      {isReviewable && (
        <div className={`${isCROMode ? 'bg-orange-50 border-orange-200' : 'bg-amber-50 border-amber-200'} border rounded-xl p-4 flex items-start gap-3`}>
          <Info className={`w-5 h-5 flex-shrink-0 mt-0.5 ${isCROMode ? 'text-orange-600' : 'text-amber-600'}`} />
          <div className="flex-1">
            <p className={`text-sm font-semibold ${isCROMode ? 'text-orange-800' : 'text-amber-800'}`}>
              {isCROMode ? 'CRO Validation Required' : 'Step 2 of 2 — Review Required'}
            </p>
            <p className={`text-xs mt-0.5 ${isCROMode ? 'text-orange-700' : 'text-amber-700'}`}>
              {isCROMode
                ? 'Validate each section against protocol source text and provide CRO sign-off once the sponsor-reviewed mapping is acceptable.'
                : 'The AI has converted your protocol to USDM v4. Review each section below, edit where needed, then approve or reject the mapping.'}
            </p>
          </div>
        </div>
      )}

      {/* USDM editor / raw JSON */}
      {(
        <div className="space-y-3">
          {Object.keys(usdmJson).length > 0 && <USDMComplianceScorecard usdmJson={usdmJson} />}
          {conversion?.confidence != null && (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-white flex items-center justify-between border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="w-4 h-4 text-brand-600" />
                  <span className="text-sm font-semibold text-slate-700">DDF Quality Scores</span>
                </div>
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                  conversion.confidence >= 0.9 ? 'bg-green-100 text-green-700' :
                  conversion.confidence >= 0.7 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                }`}>{Math.round(conversion.confidence * 100)}% overall confidence</span>
              </div>
              <div className="px-4 py-3 bg-white grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {[
                  { label: 'Digitization Accuracy', value: conversion.evalAccuracy },
                  { label: 'Section Completeness', value: conversion.evalCompleteness },
                  { label: 'Standards Compliance', value: conversion.evalStandards },
                  { label: 'Hallucination Score', value: conversion.evalHallucination },
                  { label: 'Readability', value: conversion.evalReadability },
                ].map(({ label, value }) => value != null && (
                  <div key={label} className="flex flex-col gap-1">
                    <span className="text-[10px] text-slate-500">{label}</span>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${value >= 0.9 ? 'bg-green-500' : value >= 0.7 ? 'bg-amber-400' : 'bg-red-400'}`}
                        style={{ width: `${Math.round(value * 100)}%` }} />
                    </div>
                    <span className={`text-xs font-semibold ${value >= 0.9 ? 'text-green-700' : value >= 0.7 ? 'text-amber-600' : 'text-red-600'}`}>
                      {Math.round(value * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-slate-700">USDM v4</h2>
              <div className="inline-flex bg-slate-100 rounded-lg p-1">
                <button
                  onClick={() => setContentTab('sections')}
                  className={`px-2.5 py-1 text-xs rounded-md ${contentTab === 'sections' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Sections
                </button>
                <button
                  onClick={() => setContentTab('raw')}
                  className={`px-2.5 py-1 text-xs rounded-md ${contentTab === 'raw' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Raw JSON
                </button>
              </div>
            </div>
            {contentTab === 'sections' && !isDone && !isCROMode && (
              <button
                onClick={saveEdits}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save edits
              </button>
            )}
          </div>

          {contentTab === 'sections' && Object.keys(usdmJson).length > 0 && USDM_SECTIONS.map(section => {
            const value = section.key === 'meta' ? usdmJson : getPath(usdmJson, section.path!)
            return (
              <div key={section.key}>
                <SectionPanel
                  label={section.label}
                  sectionKey={section.key}
                  value={section.key === 'meta' ? usdmJson : value}
                  onChange={v => handleSectionChange(section, v)}
                  sourceChunks={sectionProvenance[section.key] || []}
                  fieldQualityMap={usdmJson?.provenance?.field_quality}
                  editable={!isCROMode}
                />
                {/* HITL Derivation panel: shows protocol source alongside USDM */}
                {Object.keys(provenanceMap).length > 0 && (
                  <DerivationPanel
                    sectionKey={section.key}
                    usdmPath={section.path}
                    provenanceMap={provenanceMap}
                    usdmValue={value}
                    isDone={isDone}
                    onCorrect={correction => {
                      setCorrections(prev => {
                        const idx = prev.findIndex(c => c.usdm_path === correction.usdm_path)
                        if (idx >= 0) { const next = [...prev]; next[idx] = correction; return next }
                        return [...prev, correction]
                      })
                    }}
                  />
                )}
              </div>
            )
          })}

          {contentTab === 'sections' && Object.keys(usdmJson).length === 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 text-sm text-amber-800">
              USDM JSON is currently empty for this conversion. Re-run the conversion to regenerate output.
            </div>
          )}

          {contentTab === 'raw' && (
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <p className="text-sm font-medium text-slate-700">Raw USDM v4 JSON</p>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(denormalizeForSave(usdmJson), null, 2))
                      showToast('USDM JSON copied')
                    } catch {
                      showToast('Copy failed')
                    }
                  }}
                  className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <ClipboardCheck className="w-3.5 h-3.5" /> Copy JSON
                </button>
              </div>
              <pre className="text-xs text-slate-700 bg-slate-50 p-4 overflow-x-auto max-h-[28rem] overflow-y-auto">
                {JSON.stringify(denormalizeForSave(usdmJson), null, 2)}
              </pre>
            </div>
          )}

          <details className="border border-slate-200 rounded-xl overflow-hidden hidden">
            <summary className="px-4 py-3 bg-white text-sm font-medium text-slate-600 cursor-pointer hover:bg-slate-50 flex items-center gap-2">
              <FileText className="w-4 h-4" /> Full USDM v4 JSON
            </summary>
            <div className="px-4 pb-4 bg-white border-t border-slate-100">
              <pre className="mt-3 text-xs text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto max-h-96 overflow-y-auto">
                {JSON.stringify(denormalizeForSave(usdmJson), null, 2)}
              </pre>
            </div>
          </details>
        </div>
      )}

      {/* Approve / Reject actions */}
      {isReviewable && (
        <div className="sticky bottom-0 bg-white border-t border-slate-200 -mx-6 px-6 py-4 flex items-center gap-3">
          <div className="flex-1 text-xs text-slate-500">
            {isCROMode ? 'Validate all sections against protocol source text before CRO sign-off.' : 'Review all sections above before approving.'}
            {corrections.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full font-medium">
                <MessageSquare className="w-3 h-3" /> {corrections.length} correction{corrections.length !== 1 ? 's' : ''} recorded
              </span>
            )}
          </div>
          <button
            onClick={() => setShowRejectPanel(true)}
            disabled={!!deciding}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors font-medium disabled:opacity-40"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>
          <button
            onClick={() => decide('modified')}
            disabled={!!deciding}
            className="flex items-center gap-1.5 px-5 py-2 text-sm bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors font-medium disabled:opacity-40"
          >
            {deciding === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {isCROMode ? 'CRO Sign-off' : 'Approve & Save'}
          </button>
        </div>
      )}

      {/* Reject panel */}
      {showRejectPanel && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">Reject USDM Mapping</h3>
              <p className="text-xs text-slate-500 mt-0.5">Provide feedback and choose whether to re-run the AI</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Rejection Note (optional)</label>
                <textarea
                  value={rejectNote}
                  onChange={e => setRejectNote(e.target.value)}
                  rows={3}
                  placeholder="What should be improved?"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={restart} onChange={e => setRestart(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-brand-500" />
                <span className="text-sm text-slate-700">Re-run AI conversion automatically</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button onClick={() => setShowRejectPanel(false)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
                Cancel
              </button>
              <button
                onClick={() => decide('rejected')}
                disabled={deciding === 'reject'}
                className="flex items-center gap-1.5 px-5 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium disabled:opacity-40"
              >
                {deciding === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent Insights: Evaluation / Decision Traces / Audit Log */}
      {conversion.runId && (
        <AgentInsightTabs
          runId={conversion.runId}
          orgId={orgId}
          userId={user?.id || ''}
          runStatus={conversion.status}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-slate-800 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
