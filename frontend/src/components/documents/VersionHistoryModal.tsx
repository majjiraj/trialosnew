'use client'
import { useState, useEffect } from 'react'
import { X, Clock, Upload, RefreshCw, Zap } from 'lucide-react'
import { clsx } from 'clsx'

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

interface LineageEntry {
  id: string
  document_id: string
  tenant_id: string
  version: string
  file_name: string
  sha256_hash: string
  file_size_bytes: number
  uploaded_by_id: string
  uploaded_by_name: string
  uploaded_at: string
  event: 'initial_upload' | 'reprocess' | 'reembed' | string
  notes: string
}

interface VersionHistoryModalProps {
  documentId: string
  documentName: string
  orgId: string
  onClose: () => void
}

const EVENT_LABELS: Record<string, string> = {
  initial_upload: 'Uploaded',
  reprocess: 'Reprocessed',
  reembed: 'Re-embedded',
}

const EVENT_COLORS: Record<string, string> = {
  initial_upload: 'bg-blue-100 text-blue-700',
  reprocess: 'bg-amber-100 text-amber-700',
  reembed: 'bg-purple-100 text-purple-700',
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  initial_upload: <Upload className="w-3 h-3" />,
  reprocess: <RefreshCw className="w-3 h-3" />,
  reembed: <Zap className="w-3 h-3" />,
}

function fmt(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function VersionHistoryModal({ documentId, documentName, orgId, onClose }: VersionHistoryModalProps) {
  const [entries, setEntries] = useState<LineageEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${INGESTION_URL}/documents/${documentId}/lineage?org_id=${orgId}`)
        if (res.ok) {
          const data = await res.json()
          setEntries(data.lineage || [])
        }
      } catch { /* non-fatal */ } finally {
        setLoading(false)
      }
    }
    load()
  }, [documentId, orgId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Version History</h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate max-w-xs">{documentName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-sm text-slate-400 text-center py-8">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-8">No history available</div>
          ) : (
            <div className="relative">
              {/* vertical line */}
              <div className="absolute left-3.5 top-4 bottom-4 w-px bg-slate-200" />

              <div className="space-y-5">
                {entries.map((entry, idx) => (
                  <div key={entry.id} className="flex gap-4">
                    {/* timeline dot */}
                    <div className={clsx(
                      'relative z-10 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0',
                      idx === 0 ? 'bg-brand-600 text-white' : 'bg-white border-2 border-slate-200 text-slate-400'
                    )}>
                      {EVENT_ICONS[entry.event] ?? <Clock className="w-3 h-3" />}
                    </div>

                    {/* content */}
                    <div className="flex-1 pb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {idx === 0 && (
                          <span className="text-[10px] font-bold bg-brand-600 text-white px-1.5 py-0.5 rounded">
                            CURRENT
                          </span>
                        )}
                        <span className="text-xs font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          v{entry.version}
                        </span>
                        <span className={clsx(
                          'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium',
                          EVENT_COLORS[entry.event] || 'bg-slate-100 text-slate-600'
                        )}>
                          {EVENT_LABELS[entry.event] || entry.event}
                        </span>
                      </div>

                      <p className="text-xs text-slate-700 mt-1 font-medium truncate">{entry.file_name}</p>

                      <div className="flex items-center gap-3 mt-1">
                        {entry.uploaded_by_name && (
                          <span className="text-[10px] text-slate-500">{entry.uploaded_by_name}</span>
                        )}
                        <span className="text-[10px] text-slate-400">{fmtDate(entry.uploaded_at)}</span>
                        {entry.file_size_bytes > 0 && (
                          <span className="text-[10px] text-slate-400">{fmt(entry.file_size_bytes)}</span>
                        )}
                      </div>

                      {entry.notes && (
                        <p className="text-[10px] text-slate-400 mt-1 italic">{entry.notes}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
