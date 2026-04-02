'use client'
import { useState, useEffect } from 'react'
import { FileText, FileSpreadsheet, Clock, Network, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

export interface DocRecord {
  id: string
  name: string
  document_type: string
  status: string
  version: string
  file_size_bytes: number
  created_at: string
  uploaded_by?: string
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
}

const DOC_TYPE_LABELS: Record<string, string> = {
  protocol: 'Protocol', sap: 'SAP', crf: 'CRF', csr: 'CSR',
  sdtm_ig: 'SDTM IG', adam_ig: 'ADaM IG', sdtm_dataset: 'SDTM XPT',
  adam_dataset: 'ADaM XPT', lab_manual: 'Lab Manual', lab_report: 'Lab Report',
  study_budget: 'Budget', dmp: 'DMP', icf: 'ICF', other: 'Other',
}

const DOC_TYPE_COLORS: Record<string, string> = {
  protocol: 'bg-blue-100 text-blue-700',
  sap: 'bg-purple-100 text-purple-700',
  crf: 'bg-teal-100 text-teal-700',
  csr: 'bg-indigo-100 text-indigo-700',
  sdtm_ig: 'bg-orange-100 text-orange-700',
  adam_ig: 'bg-amber-100 text-amber-700',
  sdtm_dataset: 'bg-rose-100 text-rose-700',
  adam_dataset: 'bg-pink-100 text-pink-700',
  lab_manual: 'bg-cyan-100 text-cyan-700',
  lab_report: 'bg-green-100 text-green-700',
  study_budget: 'bg-lime-100 text-lime-700',
  dmp: 'bg-violet-100 text-violet-700',
  icf: 'bg-sky-100 text-sky-700',
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

export function DocumentCard({ doc, orgId, isSelected, onToggleSelect, onOpenGraph, onOpenHistory }: DocumentCardProps) {
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [dragging, setDragging] = useState(false)

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
      </div>
    </div>
  )
}
