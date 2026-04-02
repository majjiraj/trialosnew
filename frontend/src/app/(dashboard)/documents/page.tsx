'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import {
  Upload, Search, RefreshCw, Tag, Sparkles, AlertTriangle, Loader2,
  X, CheckCircle, Network, ChevronRight, FileText
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'
import Link from 'next/link'
import { DocumentGraphModal } from '@/components/context/DocumentGraphView'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
import { FolderTree } from '@/components/documents/FolderTree'
import { DocumentCard, DocRecord } from '@/components/documents/DocumentCard'
import { VersionHistoryModal } from '@/components/documents/VersionHistoryModal'

const DOC_TYPES = [
  { value: 'auto', label: 'Auto-detect (AI)' },
  { value: 'protocol', label: 'Protocol' },
  { value: 'sap', label: 'Statistical Analysis Plan' },
  { value: 'crf', label: 'CRF' },
  { value: 'csr', label: 'Clinical Study Report' },
  { value: 'sdtm_ig', label: 'SDTM Implementation Guide' },
  { value: 'adam_ig', label: 'ADaM Implementation Guide' },
  { value: 'sdtm_dataset', label: 'SDTM Dataset (.xpt)' },
  { value: 'adam_dataset', label: 'ADaM Dataset (.xpt)' },
  { value: 'lab_manual', label: 'Lab Manual' },
  { value: 'lab_report', label: 'Lab Report' },
  { value: 'study_budget', label: 'Study Budget' },
  { value: 'dmp', label: 'Data Management Plan' },
  { value: 'icf', label: 'Informed Consent Form' },
  { value: 'other', label: 'Other' },
]

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

// ── Upload modal ─────────────────────────────────────────────────────────────

interface UploadModalProps {
  orgId: string
  userId: string
  userName: string
  defaultFolderId: string | null
  onClose: () => void
  onUploaded: () => void
}

function UploadModal({ orgId, userId, userName, defaultFolderId, onClose, onUploaded }: UploadModalProps) {
  const [selectedType, setSelectedType] = useState('auto')
  const [labType, setLabType] = useState<'central' | 'site'>('central')
  const [uploading, setUploading] = useState(false)
  const [duplicate, setDuplicate] = useState<{ existingId: string; existingName: string } | null>(null)
  const [reprocessing, setReprocessing] = useState(false)

  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('org_id', orgId)
      form.append('document_type', selectedType)
      form.append('uploaded_by', userId)
      form.append('uploaded_by_name', userName)
      if (defaultFolderId) form.append('folder_id', defaultFolderId)
      if (selectedType === 'lab_report') form.append('lab_type', labType)

      const res = await fetch(`${INGESTION_URL}/documents/upload`, { method: 'POST', body: form })
      if (res.status === 409) {
        const data = await res.json()
        setDuplicate({ existingId: data.existing_document_id, existingName: data.existing_document_name })
        return
      }
      if (!res.ok) throw new Error('Upload failed')
      toast.success(selectedType === 'auto' ? 'Document uploaded — AI classifying now' : 'Document uploaded and processing started')
      onUploaded()
      onClose()
    } catch {
      toast.error('Upload failed — check ingestion service')
    } finally {
      setUploading(false)
    }
  }, [selectedType, labType, orgId, userId, userName, defaultFolderId, onUploaded, onClose])

  const confirmReprocess = useCallback(async () => {
    if (!duplicate) return
    setReprocessing(true)
    try {
      const res = await fetch(`${INGESTION_URL}/documents/${duplicate.existingId}/reprocess`, { method: 'POST' })
      if (!res.ok) throw new Error()
      toast.success('Document queued for reprocessing')
      setDuplicate(null)
      onUploaded()
      onClose()
    } catch {
      toast.error('Reprocess failed')
    } finally {
      setReprocessing(false)
    }
  }, [duplicate, onUploaded, onClose])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, multiple: false,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'text/csv': ['.csv'],
      'application/octet-stream': ['.xpt'],
      'application/x-sas-xport': ['.xpt']
    }
  })

  if (duplicate) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setDuplicate(null)} />
        <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Duplicate document detected</h3>
              <p className="text-sm text-slate-500 mt-1">A document with identical content already exists:</p>
              <p className="text-sm font-medium text-slate-800 mt-1 truncate">{duplicate.existingName}</p>
            </div>
          </div>
          <p className="text-sm text-slate-600 mb-5">
            Would you like to reprocess the existing document? This deletes its current chunks, vectors, and graph nodes, then re-extracts everything from scratch.
          </p>
          <div className="flex gap-3 justify-end">
            <button onClick={() => setDuplicate(null)} className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
            <button onClick={confirmReprocess} disabled={reprocessing}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-60">
              {reprocessing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Reprocess document
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Upload Document</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Document Type</label>
            <select value={selectedType} onChange={e => setSelectedType(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
              {DOC_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {selectedType === 'auto' && (
              <p className="flex items-center gap-1 text-xs text-blue-600 mt-1.5">
                <Sparkles className="w-3 h-3" /> AI will detect document type
              </p>
            )}
          </div>
          {selectedType === 'lab_report' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Lab Type</label>
              <div className="flex gap-2">
                {(['central', 'site'] as const).map(lt => (
                  <button key={lt} onClick={() => setLabType(lt)}
                    className={clsx('flex-1 py-2 px-3 rounded-lg text-sm font-medium border-2 transition-colors capitalize',
                      labType === lt ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}>
                    {lt} Lab
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div {...getRootProps()} className={clsx(
          'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
          isDragActive ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
          uploading && 'opacity-60 pointer-events-none'
        )}>
          <input {...getInputProps()} />
          <Upload className={clsx('w-8 h-8 mx-auto mb-3', isDragActive ? 'text-brand-500' : 'text-slate-400')} />
          {uploading
            ? <p className="text-sm text-brand-600 font-medium">Uploading & processing…</p>
            : isDragActive
              ? <p className="text-sm text-brand-600 font-medium">Drop to upload</p>
              : <><p className="text-sm font-medium text-slate-700">Drop file here or click to browse</p>
                  <p className="text-xs text-slate-400 mt-1">PDF, DOCX, XLSX, CSV, XPT — max 500MB</p></>}
        </div>
      </div>
    </div>
  )
}

// ── Create Context Graph modal ────────────────────────────────────────────────

interface CreateGraphModalProps {
  orgId: string
  selectedDocs: DocRecord[]
  onRemoveDoc: (id: string) => void
  onClose: () => void
  onCreated: () => void
}

function CreateGraphModal({ orgId, selectedDocs, onRemoveDoc, onClose, onCreated }: CreateGraphModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim() || selectedDocs.length === 0) return
    setSubmitting(true)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/standard-graphs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          document_ids: selectedDocs.map(d => d.id),
          org_id: orgId,
        })
      })
      if (!res.ok) throw new Error()
      toast.success(`Context graph "${name.trim()}" created`)
      onCreated()
      onClose()
    } catch {
      toast.error('Failed to create context graph')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Create Context Graph</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Name <span className="text-red-400">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Phase 1 Study Context"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Optional description…"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none" />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-slate-600 mb-2">{selectedDocs.length} document{selectedDocs.length !== 1 ? 's' : ''} selected</p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {selectedDocs.map(doc => (
              <div key={doc.id} className="flex items-center gap-2 px-2 py-1.5 bg-slate-50 rounded-lg">
                <FileText className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                <span className="text-xs text-slate-700 flex-1 truncate">{doc.name}</span>
                <button onClick={() => onRemoveDoc(doc.id)} className="text-slate-400 hover:text-red-500">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={!name.trim() || selectedDocs.length === 0 || submitting}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Create Graph
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const orgId = useOrgId()
  const { user } = useAuth()
  const userId = user?.id ?? '00000000-0000-0000-0000-000000000002'
  const userName = user?.name ?? ''

  // folder selection
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedFolderName, setSelectedFolderName] = useState('All Documents')

  // docs
  const [docs, setDocs] = useState<DocRecord[]>([])
  const [loadingDocs, setLoadingDocs] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [pendingCount, setPendingCount] = useState(0)

  // folder-file assignments map: docId → folderId | null (null = unassigned/root)
  const [docFolders, setDocFolders] = useState<Record<string, string | null>>({})

  // multi-select
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set())

  // modals
  const [showUpload, setShowUpload] = useState(false)
  const [graphDoc, setGraphDoc] = useState<DocRecord | null>(null)
  const [historyDoc, setHistoryDoc] = useState<DocRecord | null>(null)
  const [showCreateGraph, setShowCreateGraph] = useState(false)

  // folder tree refresh trigger
  const folderTreeKeyRef = useRef(0)
  const [folderTreeKey, setFolderTreeKey] = useState(0)

  const loadDocs = useCallback(async () => {
    setLoadingDocs(true)
    try {
      const res = await fetch(`${INGESTION_URL}/documents?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setDocs(data.documents || [])
      }
    } catch { /* non-fatal */ } finally {
      setLoadingDocs(false)
    }
  }, [orgId])

  const loadPendingCount = useCallback(async () => {
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/classify/pending?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setPendingCount((data.pending || []).length)
      }
    } catch { /* non-fatal */ }
  }, [orgId])

  // Single bulk fetch for all folder assignments — replaces N individual calls
  const loadFolderAssignments = useCallback(async () => {
    try {
      const res = await fetch(`${INGESTION_URL}/folder-files?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        const map: Record<string, string | null> = {}
        for (const f of (data.files || [])) map[f.document_id] = f.folder_id ?? null
        setDocFolders(map)
      }
    } catch { /* non-fatal */ }
  }, [orgId])

  useEffect(() => {
    loadDocs()
    loadPendingCount()
    loadFolderAssignments()
  }, [loadDocs, loadPendingCount, loadFolderAssignments])

  // Auto-refresh while any doc is processing
  useEffect(() => {
    if (!docs.some(d => d.status === 'processing')) return
    const id = setInterval(loadDocs, 3000)
    return () => clearInterval(id)
  }, [docs, loadDocs])

  // Drag-and-drop file move handler
  const handleFileDrop = useCallback(async (docId: string, targetFolderId: string | null) => {
    const currentFolderId = docFolders[docId] ?? null
    if (currentFolderId === targetFolderId) return

    // Optimistic update — card disappears from current folder immediately
    setDocFolders(prev => ({ ...prev, [docId]: targetFolderId }))

    try {
      const res = await fetch(`${INGESTION_URL}/documents/${docId}/folder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, folder_id: targetFolderId }),
      })
      if (!res.ok) throw new Error()
      // Refresh folder tree counts + re-fetch assignments from backend to confirm
      setFolderTreeKey(k => k + 1)
      loadFolderAssignments()
    } catch {
      // Roll back optimistic update on failure
      setDocFolders(prev => ({ ...prev, [docId]: currentFolderId }))
      toast.error('Failed to move document')
    }
  }, [orgId, docFolders, loadFolderAssignments])

  const handleFolderSelect = (id: string | null, name: string) => {
    setSelectedFolderId(id)
    setSelectedFolderName(name)
    setSelectedDocIds(new Set())
  }

  const handleFolderRefresh = () => {
    folderTreeKeyRef.current += 1
    setFolderTreeKey(folderTreeKeyRef.current)
    loadDocs()
    loadFolderAssignments()
  }

  const toggleSelect = (id: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Filter docs by folder selection + search + type
  // A doc with no entry in docFolders is treated as unassigned (null)
  const filtered = docs.filter(d => {
    if (filterType !== 'all' && d.document_type !== filterType) return false
    if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false
    return (docFolders[d.id] ?? null) === selectedFolderId
  })

  const selectedDocs = docs.filter(d => selectedDocIds.has(d.id))

  const handleRemoveFromSelection = (id: string) => {
    setSelectedDocIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Document Library</h1>
          <p className="text-sm text-slate-500 mt-0.5">Organize and manage your clinical trial documents</p>
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <Link href="/documents/classify"
              className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs font-medium text-amber-700 hover:bg-amber-100">
              <Tag className="w-3.5 h-3.5" />
              {pendingCount} need classification
            </Link>
          )}
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
          >
            <Upload className="w-4 h-4" /> Upload
          </button>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex flex-1 gap-4 min-h-0 overflow-hidden">

        {/* Left: Folder tree panel */}
        <div className="w-64 flex-shrink-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <FolderTree
            key={folderTreeKey}
            orgId={orgId}
            userId={userId}
            userName={userName}
            selectedId={selectedFolderId}
            onSelect={handleFolderSelect}
            onFileDrop={handleFileDrop}
            onRefresh={handleFolderRefresh}
          />
        </div>

        {/* Right: Document grid panel */}
        <div className="flex-1 bg-white border border-slate-200 rounded-xl flex flex-col min-w-0 overflow-hidden">
          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-shrink-0">
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-sm text-slate-500 flex-shrink-0">
              <span className="text-slate-400">Documents</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
              <span className="font-medium text-slate-700">{selectedFolderName}</span>
            </div>

            <div className="flex-1" />

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input type="text" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none w-48" />
            </div>

            {/* Type filter */}
            <select value={filterType} onChange={e => setFilterType(e.target.value)}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none">
              <option value="all">All Types</option>
              {DOC_TYPES.filter(o => o.value !== 'auto').map(o =>
                <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {/* Refresh */}
            <button onClick={() => { loadDocs(); loadPendingCount() }}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Doc count */}
            <span className="text-xs text-slate-400 flex-shrink-0">{filtered.length} files</span>
          </div>

          {/* Document grid */}
          <div className="flex-1 overflow-y-auto p-4">
            {loadingDocs ? (
              <div className="flex items-center justify-center h-32 text-sm text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-sm text-slate-400 gap-2">
                <FileText className="w-8 h-8 text-slate-200" />
                {selectedFolderId ? 'No documents in this folder' : 'No documents found'}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {filtered.map(doc => (
                  <DocumentCard
                    key={doc.id}
                    doc={doc}
                    orgId={orgId}
                    isSelected={selectedDocIds.has(doc.id)}
                    onToggleSelect={toggleSelect}
                    onOpenGraph={setGraphDoc}
                    onOpenHistory={setHistoryDoc}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Multi-select bottom bar */}
          {selectedDocIds.size > 0 && (
            <div className="px-4 py-3 border-t border-slate-100 bg-slate-50 flex items-center gap-3 flex-shrink-0">
              <span className="text-sm font-medium text-slate-700">
                {selectedDocIds.size} file{selectedDocIds.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setShowCreateGraph(true)}
                className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
              >
                <Network className="w-4 h-4" />
                Create Context Graph
              </button>
              <button
                onClick={() => setSelectedDocIds(new Set())}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showUpload && (
        <UploadModal
          orgId={orgId}
          userId={userId}
          userName={userName}
          defaultFolderId={selectedFolderId}
          onClose={() => setShowUpload(false)}
          onUploaded={() => { loadDocs(); setFolderTreeKey(k => k + 1) }}
        />
      )}

      {graphDoc && (
        <DocumentGraphModal
          documentId={graphDoc.id}
          documentName={graphDoc.name}
          orgId={orgId}
          onClose={() => setGraphDoc(null)}
        />
      )}

      {historyDoc && (
        <VersionHistoryModal
          documentId={historyDoc.id}
          documentName={historyDoc.name}
          orgId={orgId}
          onClose={() => setHistoryDoc(null)}
        />
      )}


      {showCreateGraph && (
        <CreateGraphModal
          orgId={orgId}
          selectedDocs={selectedDocs}
          onRemoveDoc={handleRemoveFromSelection}
          onClose={() => setShowCreateGraph(false)}
          onCreated={() => setSelectedDocIds(new Set())}
        />
      )}
    </div>
  )
}
