'use client'
import { useState, useEffect } from 'react'
import { FileText, FileSpreadsheet, Clock, Network, CheckCircle, AlertCircle, Loader2, Trash2, Layers, BookOpen, List, ShieldCheck, X } from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

/**
 * Foundational category maps to Layer 1 of the Maxis AI Context Graph design:
 *   standard   → L1.E4 Standards (SDTM IG, ADaM IG, USDM IG, CDASH, etc.)
 *   codelist   → L1.E3 Controlled Terminology (CDISC CT, MedDRA, WHO Drug, SNOMED)
 *   regulation → L1.E2 Regulatory Requirements (FDA 21 CFR, ICH, EMA guidelines)
 */
export type FoundationalCategory = 'standard' | 'codelist' | 'regulation'

const CATEGORY_CONFIG: Record<FoundationalCategory, {
  label: string
  description: string
  icon: React.ElementType
  badge: string
  color: string
}> = {
  standard: {
    label: 'Standard',
    description: 'L1.E4 — CDISC/USDM implementation guidelines & specifications',
    icon: BookOpen,
    badge: 'bg-blue-100 text-blue-700',
    color: 'text-blue-600',
  },
  codelist: {
    label: 'Code List',
    description: 'L1.E3 — Controlled terminology, codelists & medical dictionaries',
    icon: List,
    badge: 'bg-teal-100 text-teal-700',
    color: 'text-teal-600',
  },
  regulation: {
    label: 'Regulation',
    description: 'L1.E2 — Regulatory requirements (FDA, ICH, EMA guidelines)',
    icon: ShieldCheck,
    badge: 'bg-purple-100 text-purple-700',
    color: 'text-purple-600',
  },
}

export interface DocRecord {
  id: string
  name: string
  document_type: string
  status: string
  version: string
  file_size_bytes: number
  created_at: string
  uploaded_by?: string
  is_foundational?: boolean
  metadata?: Record<string, unknown>
}

interface GraphStats {
  chunk_count: number
  entity_count: number
  status: string
}

interface DocumentCardProps {
  doc: DocRecord
  orgId: string
  isSelected: boolean
  onToggleSelect: (id: string) => void
  onOpenGraph: (doc: DocRecord) => void
  onOpenHistory: (doc: DocRecord) => void
  onDelete: (doc: DocRecord) => void
  onFoundationalChange?: (id: string, val: boolean) => void
}

const DOC_TYPE_LABELS: Record<string, string> = {
  protocol: 'Protocol', sap: 'SAP', crf: 'CRF', csr: 'CSR',
  sdtm_ig: 'SDTM IG', adam_ig: 'ADaM IG', usdm_ig: 'USDM IG', sdtm_dataset: 'SDTM XPT',
  adam_dataset: 'ADaM XPT', lab_manual: 'Lab Manual', lab_report: 'Lab Report',
  study_budget: 'Budget', dmp: 'DMP', icf: 'ICF',
  ich_guideline: 'ICH Guideline', controlled_terminology: 'Ctrl. Terminology',
  other: 'Other',
}

const DOC_TYPE_COLORS: Record<string, string> = {
  protocol: 'bg-blue-100 text-blue-700',
  sap: 'bg-purple-100 text-purple-700',
  crf: 'bg-teal-100 text-teal-700',
  csr: 'bg-indigo-100 text-indigo-700',
  sdtm_ig: 'bg-orange-100 text-orange-700',
  adam_ig: 'bg-amber-100 text-amber-700',
  usdm_ig: 'bg-fuchsia-100 text-fuchsia-700',
  sdtm_dataset: 'bg-rose-100 text-rose-700',
  adam_dataset: 'bg-pink-100 text-pink-700',
  lab_manual: 'bg-cyan-100 text-cyan-700',
  lab_report: 'bg-green-100 text-green-700',
  study_budget: 'bg-lime-100 text-lime-700',
  dmp: 'bg-violet-100 text-violet-700',
  icf: 'bg-sky-100 text-sky-700',
  ich_guideline: 'bg-emerald-100 text-emerald-700',
  controlled_terminology: 'bg-yellow-100 text-yellow-700',
  other: 'bg-slate-100 text-slate-600',
}

function relativeDate(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(isoStr).toLocaleDateString()
}

function FileIcon({ type }: { type: string }) {
  const isSpreadsheet = ['sdtm_dataset', 'adam_dataset', 'study_budget', 'lab_report'].includes(type)
  if (isSpreadsheet) return <FileSpreadsheet className="w-8 h-8 text-green-500" />
  return <FileText className="w-8 h-8 text-blue-500" />
}

export function DocumentCard({ doc, orgId, isSelected, onToggleSelect, onOpenGraph, onOpenHistory, onDelete, onFoundationalChange }: DocumentCardProps) {
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [foundational, setFoundational] = useState(!!doc.is_foundational)
  const [foundationalLoading, setFoundationalLoading] = useState(false)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)

  // Derive current category from metadata
  const currentCategory = (doc.metadata?.foundational_category ?? null) as FoundationalCategory | null

  const markFoundational = async (category: FoundationalCategory) => {
    setFoundationalLoading(true)
    setShowCategoryPicker(false)
    try {
      const res = await fetch(
        `${INGESTION_URL}/documents/${doc.id}/foundational?org_id=${orgId}&is_foundational=true&category=${category}`,
        { method: 'PATCH' }
      )
      if (!res.ok) throw new Error()
      setFoundational(true)
      // Update local metadata reference so badge reflects immediately
      if (doc.metadata) doc.metadata.foundational_category = category
      onFoundationalChange?.(doc.id, true)
      const cfg = CATEGORY_CONFIG[category]
      toast.success(`Marked as foundational ${cfg.label} — will appear in Foundation Graph`)
    } catch {
      toast.error('Failed to update foundational status')
    } finally {
      setFoundationalLoading(false)
    }
  }

  const removeFoundational = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setFoundationalLoading(true)
    setShowCategoryPicker(false)
    try {
      const res = await fetch(
        `${INGESTION_URL}/documents/${doc.id}/foundational?org_id=${orgId}&is_foundational=false`,
        { method: 'PATCH' }
      )
      if (!res.ok) throw new Error()
      setFoundational(false)
      if (doc.metadata) delete doc.metadata.foundational_category
      onFoundationalChange?.(doc.id, false)
      toast.success('Removed from Foundation Graph')
    } catch {
      toast.error('Failed to update foundational status')
    } finally {
      setFoundationalLoading(false)
    }
  }

  const handleLayersClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (foundational) {
      // Toggle off
      removeFoundational(e)
    } else {
      // Show category picker
      setShowCategoryPicker(v => !v)
    }
  }

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${CONTEXT_GRAPH_URL}/graph/document/${doc.id}?org_id=${orgId}`)
        if (res.ok && alive) {
          const data = await res.json()
          setStats({
            chunk_count: data.chunk_count ?? data.chunks ?? 0,
            entity_count: data.entity_count ?? data.entities ?? 0,
            status: data.build_status ?? data.status ?? 'unknown',
          })
        }
      } catch { /* non-fatal */ } finally {
        if (alive) setStatsLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [doc.id, orgId])

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', doc.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      className={clsx(
        'group relative bg-white border rounded-xl p-3.5 flex flex-col gap-2 transition-all cursor-grab active:cursor-grabbing select-none',
        dragging ? 'opacity-50 scale-95' : '',
        isSelected ? 'border-brand-400 ring-2 ring-brand-100 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
      )}
      onClick={() => { if (!dragging) onToggleSelect(doc.id) }}
    >
      {/* Checkbox — visible when selected or group hovered */}
      <div
        className={clsx(
          'absolute top-2.5 left-2.5 w-4 h-4 rounded border transition-all',
          isSelected
            ? 'bg-brand-600 border-brand-600 flex items-center justify-center'
            : 'border-slate-300 bg-white opacity-0 group-hover:opacity-100'
        )}
      >
        {isSelected && <CheckCircle className="w-3 h-3 text-white" />}
      </div>

      {/* Drag hint — top-right, visible on hover */}
      <div className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <svg className="w-3 h-3 text-slate-300" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
          <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
          <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
        </svg>
      </div>

      {/* File icon */}
      <div className="flex justify-center pt-2">
        <FileIcon type={doc.document_type} />
      </div>

      {/* Doc name */}
      <p className="text-xs font-medium text-slate-900 text-center line-clamp-2 leading-tight">
        {doc.name}
      </p>

      {/* Type + version badges */}
      <div className="flex items-center justify-center gap-1 flex-wrap">
        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', DOC_TYPE_COLORS[doc.document_type] || 'bg-slate-100 text-slate-600')}>
          {DOC_TYPE_LABELS[doc.document_type] || doc.document_type}
        </span>
        {doc.version && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">
            v{doc.version}
          </span>
        )}
        {foundational && (() => {
          const cat = currentCategory
          const cfg = cat ? CATEGORY_CONFIG[cat] : null
          const Icon = cfg?.icon ?? Layers
          return (
            <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5', cfg?.badge ?? 'bg-fuchsia-100 text-fuchsia-700')}>
              <Icon className="w-2.5 h-2.5" />
              {cfg?.label ?? 'foundational'}
            </span>
          )
        })()}
      </div>

      {/* date */}
      <p className="text-[10px] text-slate-400 text-center truncate">
        {relativeDate(doc.created_at)}
      </p>

      {/* Stats row */}
      <div className="text-[10px] text-center text-slate-500">
        {statsLoading ? (
          <span className="text-slate-300">loading…</span>
        ) : stats ? (
          <span>{stats.chunk_count}ch · {stats.entity_count}e</span>
        ) : null}
      </div>

      {/* Status badge */}
      <div className="flex justify-center">
        {doc.status === 'indexed' && (
          <span className="flex items-center gap-1 text-[10px] text-green-600 font-medium">
            <CheckCircle className="w-3 h-3" /> indexed
          </span>
        )}
        {doc.status === 'processing' && (
          <span className="flex items-center gap-1 text-[10px] text-blue-600 font-medium">
            <Loader2 className="w-3 h-3 animate-spin" /> building
          </span>
        )}
        {doc.status === 'pending' && (
          <span className="flex items-center gap-1 text-[10px] text-slate-400 font-medium">
            <Clock className="w-3 h-3" /> pending
          </span>
        )}
        {doc.status === 'error' && (
          <span className="flex items-center gap-1 text-[10px] text-red-500 font-medium">
            <AlertCircle className="w-3 h-3" /> error
          </span>
        )}
      </div>

      {/* Bottom action icons */}
      <div className="flex justify-center gap-3 pt-0.5 border-t border-slate-100">
        {/* Foundational layers button + category picker */}
        <div className="relative">
          <button
            title={foundational ? 'Remove from Foundation Graph' : 'Mark as foundational — choose category'}
            className={clsx(
              'p-1 rounded transition-colors',
              foundationalLoading ? 'opacity-50' : '',
              foundational
                ? (() => {
                    const cfg = currentCategory ? CATEGORY_CONFIG[currentCategory] : null
                    return cfg ? `${cfg.color} bg-opacity-10 hover:bg-slate-100` : 'text-fuchsia-600 bg-fuchsia-50 hover:bg-fuchsia-100'
                  })()
                : showCategoryPicker
                  ? 'text-fuchsia-600 bg-fuchsia-50'
                  : 'text-slate-400 hover:text-fuchsia-600 hover:bg-fuchsia-50'
            )}
            onClick={handleLayersClick}
            disabled={foundationalLoading}
          >
            {foundationalLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
          </button>

          {/* Category picker popover */}
          {showCategoryPicker && !foundational && (
            <div
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 bg-white border border-slate-200 rounded-xl shadow-lg p-2 w-56"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-1.5 px-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Foundation Layer Type</span>
                <button
                  className="text-slate-300 hover:text-slate-500"
                  onClick={e => { e.stopPropagation(); setShowCategoryPicker(false) }}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              {(Object.entries(CATEGORY_CONFIG) as [FoundationalCategory, typeof CATEGORY_CONFIG[FoundationalCategory]][]).map(([key, cfg]) => {
                const Icon = cfg.icon
                return (
                  <button
                    key={key}
                    className="w-full flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors text-left group"
                    onClick={e => { e.stopPropagation(); markFoundational(key) }}
                  >
                    <Icon className={clsx('w-3.5 h-3.5 mt-0.5 flex-shrink-0', cfg.color)} />
                    <div>
                      <div className="text-[11px] font-medium text-slate-800">{cfg.label}</div>
                      <div className="text-[9px] text-slate-400 leading-tight">{cfg.description}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <button
          title="Version history"
          className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
          onClick={e => { e.stopPropagation(); onOpenHistory(doc) }}
        >
          <Clock className="w-3.5 h-3.5" />
        </button>
        <button
          title="View context graph"
          className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
          onClick={e => { e.stopPropagation(); onOpenGraph(doc) }}
        >
          <Network className="w-3.5 h-3.5" />
        </button>
        {confirmDelete ? (
          <>
            <button
              title="Confirm delete"
              className="p-1 rounded text-red-500 hover:bg-red-50 transition-colors text-[10px] font-medium px-1.5"
              onClick={e => { e.stopPropagation(); setConfirmDelete(false); onDelete(doc) }}
            >
              Yes
            </button>
            <button
              title="Cancel"
              className="p-1 rounded text-slate-400 hover:bg-slate-100 transition-colors text-[10px] font-medium px-1.5"
              onClick={e => { e.stopPropagation(); setConfirmDelete(false) }}
            >
              No
            </button>
          </>
        ) : (
          <button
            title="Delete document"
            className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
