'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/components/layout/AuthContext'
import {
  ChevronLeft, CheckCircle, XCircle, Edit2, Save, X, RefreshCw,
  Loader2, AlertCircle, ChevronDown, ChevronRight, FileText,
  Plus, Trash2, Info, Download, Upload, FolderOpen, ShieldCheck, ShieldX,
} from 'lucide-react'
import { AgentInsightTabs } from '@/components/agent/AgentInsightTabs'

const GRAPHQL_URL   = process.env.NEXT_PUBLIC_GRAPHQL_URL   || 'http://localhost:4000/graphql'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const ORG_ID        = process.env.NEXT_PUBLIC_ORG_ID        || '00000000-0000-0000-0000-000000000000'

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
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

function SectionPanel({
  label, sectionKey, value, onChange
}: { label: string; sectionKey: string; value: any; onChange: (v: any) => void }) {
  const [open, setOpen] = useState(sectionKey === 'meta')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

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

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          <span className="text-sm font-medium text-slate-700">{label}</span>
          {isEmpty && <span className="text-xs text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded font-medium">Empty</span>}
          {!isEmpty && Array.isArray(value) && <span className="text-xs text-slate-400">{value.length} item{value.length !== 1 ? 's' : ''}</span>}
        </div>
        {!editing && (
          <button
            onClick={e => { e.stopPropagation(); startEdit() }}
            className="p-1 text-slate-400 hover:text-brand-500 transition-colors"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 bg-white border-t border-slate-100">
          {editing ? (
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

function MetaEditor({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const study = value?.study || {}
  function update(field: string, val: string) {
    onChange({ ...value, study: { ...study, [field]: val } })
  }
  function updateNested(field: string, subField: string, val: string) {
    onChange({ ...value, study: { ...study, [field]: { ...(study[field] || {}), [subField]: val } } })
  }

  return (
    <div className="space-y-3">
      {[
        { label: 'Study Title', field: 'studyTitle', type: 'text' },
        { label: 'Acronym', field: 'studyAcronym', type: 'text' },
        { label: 'Version', field: 'studyVersion', type: 'text' },
        { label: 'Study Rationale', field: 'studyRationale', type: 'textarea' },
      ].map(({ label, field, type }) => (
        <div key={field}>
          <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
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
          <label className="block text-xs font-medium text-slate-600 mb-1">Study Type</label>
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
          <label className="block text-xs font-medium text-slate-600 mb-1">Study Phase</label>
          <select
            value={study.studyPhase?.decode || ''}
            onChange={e => updateNested('studyPhase', 'decode', e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
          >
            <option value="">— select —</option>
            {['Phase 1', 'Phase 1/2', 'Phase 2', 'Phase 2/3', 'Phase 3', 'Phase 4', 'Not Applicable'].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
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
  conversionId, conversionName, orgId, userId,
  approvalId, runId,
  onStarted,
}: {
  conversionId: string
  conversionName: string
  orgId: string
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
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`${INGESTION_URL}/documents?org_id=${orgId}`)
      .then(r => r.json())
      .then(res => {
        const filtered = (res.documents || []).filter((d: any) =>
          /\.(pdf|docx|doc|txt|md)$/i.test(d.file_name || ''))
        setDocs(filtered)
      })
      .catch(() => {})
      .finally(() => setDocsLoading(false))
  }, [orgId])

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
          mutation($runId: String!, $approvalId: String!, $decision: String!, $modifiedSpec: JSON, $decidedBy: String!) {
            resumeAgentRun(runId: $runId, approvalId: $approvalId, decision: $decision, modifiedSpec: $modifiedSpec, decidedBy: $decidedBy)
          }
        `, {
          runId,
          approvalId,
          decision: 'approved',
          modifiedSpec: {
            protocol_doc_id: selectedDoc.id,
            protocol_filename: selectedDoc.file_name,
            protocol_s3_key: selectedDoc.s3_key,
          },
          decidedBy: userId || 'user',
        })
      } else {
        // Draft flow: attach doc and start a new run
        await gql(`
          mutation($id: ID!, $protocolDocId: String!, $protocolFilename: String!, $protocolS3Key: String!, $createdBy: String) {
            beginUsdmConversion(id: $id, protocolDocId: $protocolDocId, protocolFilename: $protocolFilename, protocolS3Key: $protocolS3Key, createdBy: $createdBy) { id }
          }
        `, {
          id: conversionId,
          protocolDocId: selectedDoc.id,
          protocolFilename: selectedDoc.file_name,
          protocolS3Key: selectedDoc.s3_key,
          createdBy: userId,
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
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID

  const [conversion, setConversion] = useState<any>(null)
  const [usdmJson, setUsdmJson] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [showRejectPanel, setShowRejectPanel] = useState(false)
  const [restart, setRestart] = useState(false)
  const [toast, setToast] = useState('')
  const [polling, setPolling] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await gql(
        `query($id: ID!) { usdmConversion(id: $id) {
          id name status protocolFilename protocolDocId runId approvalId
          usdmJson errorMessage createdAt updatedAt
        }}`,
        { id }
      )
      const conv = data.usdmConversion
      setConversion(conv)
      if (conv?.usdmJson && Object.keys(conv.usdmJson).length > 0) {
        setUsdmJson(conv.usdmJson)
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
      `, { id, usdmJson })
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
        await gql(`mutation($id: ID!, $usdmJson: JSON!) { updateUsdmConversion(id: $id, usdmJson: $usdmJson) { id } }`,
          { id, usdmJson })
      }
      await gql(`
        mutation($runId: String!, $approvalId: String!, $decision: String!, $modifiedSpec: JSON, $decidedBy: String!, $note: String, $restart: Boolean) {
          resumeAgentRun(runId: $runId, approvalId: $approvalId, decision: $decision, modifiedSpec: $modifiedSpec, decidedBy: $decidedBy, note: $note, restart: $restart)
        }
      `, {
        runId: conversion.runId,
        approvalId: conversion.approvalId,
        decision,
        modifiedSpec: decision !== 'rejected' ? usdmJson : null,
        decidedBy: user?.id || 'user',
        note: rejectNote,
        restart,
      })
      showToast(decision === 'rejected' ? 'Conversion rejected' : 'USDM mapping approved!')
      setTimeout(load, 1000)
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
  const isReviewable   = conversion.status === 'waiting_approval'
  const isRunning      = ['running', 'pending'].includes(conversion.status)
  const isDone         = ['approved', 'completed', 'rejected', 'failed'].includes(conversion.status)

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
        {/* Download button */}
        {['approved','completed'].includes(conversion.status) && conversion.runId && (
          <a
            href={`${process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'}/runs/${conversion.runId}/artifacts/0/download`}
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
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800">Step 2 of 2 — Review Required</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The AI has converted your protocol to USDM v4. Review each section below, edit where needed,
              then approve or reject the mapping.
            </p>
          </div>
        </div>
      )}

      {/* USDM editor */}
      {Object.keys(usdmJson).length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">USDM v4 Sections</h2>
            {!isDone && (
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

          {USDM_SECTIONS.map(section => {
            const value = section.key === 'meta' ? usdmJson : getPath(usdmJson, section.path!)
            return (
              <SectionPanel
                key={section.key}
                label={section.label}
                sectionKey={section.key}
                value={section.key === 'meta' ? usdmJson : value}
                onChange={v => handleSectionChange(section, v)}
              />
            )
          })}

          <details className="border border-slate-200 rounded-xl overflow-hidden">
            <summary className="px-4 py-3 bg-white text-sm font-medium text-slate-600 cursor-pointer hover:bg-slate-50 flex items-center gap-2">
              <FileText className="w-4 h-4" /> Full USDM v4 JSON
            </summary>
            <div className="px-4 pb-4 bg-white border-t border-slate-100">
              <pre className="mt-3 text-xs text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto max-h-96 overflow-y-auto">
                {JSON.stringify(usdmJson, null, 2)}
              </pre>
            </div>
          </details>
        </div>
      )}

      {/* Approve / Reject actions */}
      {isReviewable && (
        <div className="sticky bottom-0 bg-white border-t border-slate-200 -mx-6 px-6 py-4 flex items-center gap-3">
          <div className="flex-1 text-xs text-slate-500">
            Review all sections above before approving.
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
            Approve & Save
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
