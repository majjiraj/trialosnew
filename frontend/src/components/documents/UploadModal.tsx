'use client'
import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, AlertTriangle, Loader2, Sparkles, GitBranch } from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'

const DOC_TYPES = [
  { value: 'auto',         label: 'Auto-detect (AI)' },
  { value: 'protocol',     label: 'Protocol' },
  { value: 'sap',          label: 'Statistical Analysis Plan' },
  { value: 'crf',          label: 'CRF' },
  { value: 'csr',          label: 'Clinical Study Report' },
  { value: 'sdtm_ig',      label: 'SDTM Implementation Guide' },
  { value: 'adam_ig',      label: 'ADaM Implementation Guide' },
  { value: 'usdm_ig',             label: 'USDM Implementation Guide' },
  { value: 'ich_guideline',        label: 'ICH Guideline' },
  { value: 'controlled_terminology', label: 'Controlled Terminology' },
  { value: 'sdtm_dataset',         label: 'SDTM Dataset (.xpt)' },
  { value: 'adam_dataset', label: 'ADaM Dataset (.xpt)' },
  { value: 'lab_manual',   label: 'Lab Manual' },
  { value: 'lab_report',   label: 'Lab Report' },
  { value: 'study_budget', label: 'Study Budget' },
  { value: 'dmp',          label: 'Data Management Plan' },
  { value: 'icf',          label: 'Informed Consent Form' },
  { value: 'other',        label: 'Other' },
]

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

export interface UploadModalProps {
  orgId: string
  userId: string
  userName: string
  defaultFolderId?: string | null
  /** When set, locks the type selector to this value and hides it */
  forcedDocType?: string
  studyId?: string | null
  onClose: () => void
  onUploaded: (doc?: { id: string; name: string }) => void
}

export function UploadModal({
  orgId, userId, userName,
  defaultFolderId = null,
  forcedDocType,
  studyId,
  onClose, onUploaded,
}: UploadModalProps) {
  const [selectedType, setSelectedType] = useState(forcedDocType || 'auto')
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
      if (studyId) form.append('study_id', studyId)
      if (selectedType === 'lab_report') form.append('lab_type', labType)

      const res = await fetch(`${INGESTION_URL}/documents/upload`, { method: 'POST', body: form })
      if (res.status === 409) {
        const data = await res.json()
        setDuplicate({ existingId: data.existing_document_id, existingName: data.existing_document_name })
        return
      }
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json().catch(() => ({}))
      if (data.is_new_version) {
        toast.success(`Protocol v${data.version} uploaded — new version created`, { duration: 5000 })
      } else {
        toast.success(selectedType === 'auto' ? 'Document uploaded — AI classifying now' : 'Document uploaded and processing started')
      }
      onUploaded(data.document_id ? { id: data.document_id, name: file.name } : undefined)
      onClose()
    } catch {
      toast.error('Upload failed — check ingestion service')
    } finally {
      setUploading(false)
    }
  }, [selectedType, labType, orgId, userId, userName, defaultFolderId, studyId, onUploaded, onClose])

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
      'application/msword': ['.doc'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'text/csv': ['.csv'],
      'application/octet-stream': ['.xpt'],
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
          <h2 className="text-sm font-semibold text-slate-900">
            {forcedDocType === 'protocol' ? 'Upload Protocol' : 'Upload Document'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        {!forcedDocType && (
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
        )}

        {forcedDocType === 'protocol' && (
          <div className="flex items-center gap-2 px-3 py-2 bg-brand-50 rounded-lg">
            <span className="text-xs font-medium text-brand-700">Type: Protocol</span>
            <span className="text-xs text-brand-500">— locked for USDM conversion workflow</span>
          </div>
        )}

        {(selectedType === 'protocol' || forcedDocType === 'protocol') && studyId && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-sky-50 border border-sky-200 rounded-lg">
            <GitBranch className="w-3.5 h-3.5 text-sky-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-sky-700">
              If a protocol already exists for this study, uploading a new file will automatically create a new version and link it in the lineage chain. The document date will be extracted from the file.
            </p>
          </div>
        )}

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
                  <p className="text-xs text-slate-400 mt-1">PDF, DOCX, DOC, TXT — max 500MB</p></>}
        </div>
      </div>
    </div>
  )
}
