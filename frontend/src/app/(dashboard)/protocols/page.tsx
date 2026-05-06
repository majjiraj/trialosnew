'use client'
import { useState, useEffect, useCallback } from 'react'
import { Upload, RefreshCw, Search, Loader2, FileCode2, Play, Eye, ChevronRight, Clock, CheckCircle2, XCircle, Plus, X, FlaskConical, Link2 } from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'
import Link from 'next/link'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
import { UploadModal } from '@/components/documents/UploadModal'

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const STUDY_GRAPH_URL = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL || 'http://localhost:8013'
const SUPER_AGENT_URL = process.env.NEXT_PUBLIC_SUPER_AGENT_URL || 'http://localhost:8015'

type StudyItem = {
  id: string
  name: string
  protocol_number: string
  phase?: string
  therapeutic_area?: string
  status: string
  created_at: string
}
type ProtocolDoc = {
  id: string; name: string; document_type: string; status: string
  created_at: string; uploaded_by_name?: string; study_id?: string
}
type Conversion = {
  id: string; status: string; confidence?: number; created_at: string
  protocol_doc_id?: string; error_message?: string; retry_count?: number
  client_graph_built?: boolean; run_id?: string; plan_id?: string
}

const PHASES = ['I', 'II', 'III', 'IV', 'Observational']
const STATUSES = ['planning', 'active', 'locked', 'closed']

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
    completed:         { label: 'Completed',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
    waiting_approval:  { label: 'Needs Review', cls: 'bg-amber-50 text-amber-700 border-amber-200',     icon: Clock },
    running:           { label: 'Running',      cls: 'bg-blue-50 text-blue-700 border-blue-200',         icon: Loader2 },
    pending:           { label: 'Pending',      cls: 'bg-slate-50 text-slate-600 border-slate-200',      icon: Clock },
    failed:            { label: 'Failed',       cls: 'bg-red-50 text-red-700 border-red-200',            icon: XCircle },
    indexed:           { label: 'Indexed',      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
    processing:        { label: 'Processing',   cls: 'bg-blue-50 text-blue-700 border-blue-200',         icon: Loader2 },
  }
  const cfg = map[status] ?? { label: status, cls: 'bg-slate-50 text-slate-600 border-slate-200', icon: Clock }
  const Icon = cfg.icon
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', cfg.cls)}>
      <Icon className={clsx('w-3 h-3', status === 'running' || status === 'processing' ? 'animate-spin' : '')} />
      {cfg.label}
    </span>
  )
}

function studyStatusDot(status: string) {
  const colors: Record<string, string> = {
    active: 'bg-emerald-500',
    planning: 'bg-amber-400',
    locked: 'bg-slate-400',
    closed: 'bg-red-400',
  }
  return <span className={clsx('inline-block w-2 h-2 rounded-full flex-shrink-0', colors[status] ?? 'bg-slate-300')} />
}

export default function ProtocolsPage() {
  const orgId = useOrgId()
  const fallbackOrgId = '00000000-0000-0000-0000-000000000000'
  const { user } = useAuth()
  const userId = user?.id ?? '00000000-0000-0000-0000-000000000002'
  const userName = user?.name ?? ''
  const [activeOrgId, setActiveOrgId] = useState(orgId)

  const [studies, setStudies] = useState<StudyItem[]>([])
  const [loadingStudies, setLoadingStudies] = useState(false)
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null)
  const [studySearch, setStudySearch] = useState('')

  // New study form
  const [showNewStudy, setShowNewStudy] = useState(false)
  const [newStudyForm, setNewStudyForm] = useState({
    name: '', protocol_number: '', phase: '', therapeutic_area: '', status: 'planning',
  })
  const [creatingStudy, setCreatingStudy] = useState(false)

  const [protocols, setProtocols] = useState<ProtocolDoc[]>([])
  const [loadingProtocols, setLoadingProtocols] = useState(false)

  const [conversions, setConversions] = useState<Conversion[]>([])
  const [loadingConversions, setLoadingConversions] = useState(false)
  const [selectedProtocolId, setSelectedProtocolId] = useState<string | null>(null)

  const [showUpload, setShowUpload] = useState(false)
  const [converting, setConverting] = useState<string | null>(null)

  // Create-study modal state
  const [createStep, setCreateStep] = useState<1 | 2>(1)  // 1=details, 2=protocol
  const [protocolMode, setProtocolMode] = useState<'attach' | 'upload'>('upload')
  const [existingProtocols, setExistingProtocols] = useState<ProtocolDoc[]>([])
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [attachingDocId, setAttachingDocId] = useState<string | null>(null)
  const [pendingStudyId, setPendingStudyId] = useState<string | null>(null) // newly created study awaiting protocol

  const loadStudies = useCallback(async () => {
    setLoadingStudies(true)
    try {
      const tryLoad = async (candidateOrgId: string) => {
        const res = await fetch(`${STUDY_GRAPH_URL}/studies?org_id=${candidateOrgId}`)
        if (!res.ok) return null
        const data = await res.json()
        return (data.studies || []) as StudyItem[]
      }

      let loadedStudies = await tryLoad(orgId)
      let resolvedOrgId = orgId

      if ((loadedStudies?.length || 0) === 0 && orgId !== fallbackOrgId) {
        const fallbackStudies = await tryLoad(fallbackOrgId)
        if ((fallbackStudies?.length || 0) > 0) {
          loadedStudies = fallbackStudies
          resolvedOrgId = fallbackOrgId
          toast.info('Showing studies from default tenant (org fallback)')
        }
      }

      setActiveOrgId(resolvedOrgId)
      setStudies(loadedStudies || [])
    } catch { /* non-fatal */ } finally {
      setLoadingStudies(false)
    }
  }, [orgId, fallbackOrgId])

  const loadProtocols = useCallback(async (studyId: string) => {
    setLoadingProtocols(true)
    try {
      const res = await fetch(`${INGESTION_URL}/documents?org_id=${activeOrgId}&document_type=protocol&study_id=${studyId}`)
      if (!res.ok) return
      const data = await res.json()
      // filter client-side as a safety net — only show documents explicitly of type 'protocol'
      setProtocols((data.documents || []).filter((d: ProtocolDoc) => d.document_type === 'protocol'))
    } catch { /* non-fatal */ } finally {
      setLoadingProtocols(false)
    }
  }, [activeOrgId])

  const loadConversions = useCallback(async (protocolDocId: string) => {
    setLoadingConversions(true)
    try {
      const res = await fetch(`${AGENT_RUNTIME_URL}/usdm?org_id=${activeOrgId}&protocol_doc_id=${protocolDocId}`)
      if (!res.ok) return
      const data = await res.json()
      // Only show L4 Super Agent orchestrated conversions (plan_id present), never failed ones
      const all: Conversion[] = data.conversions || data || []
      setConversions(all.filter(c => c.plan_id && c.status !== 'failed'))
    } catch { /* non-fatal */ } finally {
      setLoadingConversions(false)
    }
  }, [activeOrgId])

  useEffect(() => { loadStudies() }, [loadStudies])

  useEffect(() => {
    if (selectedStudyId) loadProtocols(selectedStudyId)
    else setProtocols([])
    setSelectedProtocolId(null)
    setConversions([])
  }, [selectedStudyId, loadProtocols])

  useEffect(() => {
    if (selectedProtocolId) loadConversions(selectedProtocolId)
    else setConversions([])
  }, [selectedProtocolId, loadConversions])

  // Poll active conversions
  useEffect(() => {
    const active = conversions.filter(c => c.status === 'running' || c.status === 'pending')
    if (!active.length || !selectedProtocolId) return
    const id = setInterval(() => loadConversions(selectedProtocolId), 3000)
    return () => clearInterval(id)
  }, [conversions, selectedProtocolId, loadConversions])

  const handleConvert = async (protocolDocId: string) => {
    setConverting(protocolDocId)
    try {
      const res = await fetch(`${SUPER_AGENT_URL}/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent_text: 'Convert protocol document to USDM',
          org_id: activeOrgId,
          study_id: selectedStudyId || undefined,
          initiated_by: 'user',
          context: { protocol_doc_id: protocolDocId },
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Orchestration failed')
      }
      const data = await res.json()
      toast.success(`USDM conversion started (plan ${data.plan_id?.slice(0, 8)}…)`)
      setSelectedProtocolId(protocolDocId)
      loadConversions(protocolDocId)
      // Link to orchestrator after a short delay so the row is visible
      setTimeout(() => loadConversions(protocolDocId), 2000)
    } catch (e: any) {
      toast.error(e.message || 'Conversion failed')
    } finally {
      setConverting(null)
    }
  }

  const filteredStudies = studies.filter(s =>
    !studySearch ||
    s.name.toLowerCase().includes(studySearch.toLowerCase()) ||
    s.protocol_number.toLowerCase().includes(studySearch.toLowerCase())
  )

  const selectedStudy = studies.find(s => s.id === selectedStudyId)

  const loadExistingProtocols = useCallback(async () => {
    setLoadingExisting(true)
    try {
      // fetch all protocol docs for this org with no study assigned
      const res = await fetch(`${INGESTION_URL}/documents?org_id=${activeOrgId}&document_type=protocol`)
      if (!res.ok) return
      const data = await res.json()
      setExistingProtocols(
        (data.documents || []).filter((d: ProtocolDoc) => d.document_type === 'protocol' && !d.study_id)
      )
    } catch { /* non-fatal */ } finally {
      setLoadingExisting(false)
    }
  }, [activeOrgId])

  const resetNewStudy = () => {
    setShowNewStudy(false)
    setCreateStep(1)
    setProtocolMode('upload')
    setPendingStudyId(null)
    setNewStudyForm({ name: '', protocol_number: '', phase: '', therapeutic_area: '', status: 'planning' })
  }

  const handleCreateStudy = async () => {
    if (!newStudyForm.name.trim() || !newStudyForm.protocol_number.trim()) {
      toast.error('Study name and protocol number are required')
      return
    }
    setCreatingStudy(true)
    try {
      const res = await fetch(`${STUDY_GRAPH_URL}/studies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newStudyForm, org_id: activeOrgId }),
      })
      if (!res.ok) throw new Error('Failed to create study')
      const created = await res.json()
      setStudies(prev => [created, ...prev])
      setSelectedStudyId(created.id)
      setPendingStudyId(created.id)
      setCreateStep(2)
      loadExistingProtocols()
      toast.success('Study created — now attach or upload a protocol')
    } catch (e: any) {
      toast.error(e.message || 'Could not create study')
    } finally {
      setCreatingStudy(false)
    }
  }

  const handleAttachProtocol = async (docId: string) => {
    if (!pendingStudyId) return
    setAttachingDocId(docId)
    try {
      const res = await fetch(
        `${INGESTION_URL}/documents/${docId}/study?org_id=${activeOrgId}&study_id=${pendingStudyId}`,
        { method: 'PATCH' }
      )
      if (!res.ok) throw new Error('Failed to assign document')
      toast.success('Protocol attached to study')
      resetNewStudy()
      loadProtocols(pendingStudyId)
    } catch (e: any) {
      toast.error(e.message || 'Could not attach protocol')
    } finally {
      setAttachingDocId(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Protocol Hub</h1>
          <p className="text-sm text-slate-500 mt-0.5">Upload protocol documents, trigger USDM conversion, and observe AI reasoning</p>
        </div>
        {selectedStudyId && (
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
          >
            <Upload className="w-4 h-4" /> Upload Protocol
          </button>
        )}
      </div>

      <div className="flex flex-1 gap-4 min-h-0 overflow-hidden">
        {/* Left — Studies */}
        <div className="w-64 flex-shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Studies</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                value={studySearch} onChange={e => setStudySearch(e.target.value)}
                placeholder="Search name or protocol…" className="w-full pl-7 pr-2 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingStudies ? (
              <div className="flex items-center justify-center h-24 text-xs text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Loading…
              </div>
            ) : filteredStudies.length === 0 && !showNewStudy ? (
              <div className="flex flex-col items-center justify-center h-32 text-xs text-slate-400 gap-1 px-3 text-center">
                <FlaskConical className="w-6 h-6 text-slate-200" />
                No studies yet — create one to upload protocols
              </div>
            ) : filteredStudies.map(s => (
              <button
                key={s.id}
                onClick={() => setSelectedStudyId(s.id)}
                className={clsx(
                  'w-full text-left px-3 py-2.5 border-b border-slate-50 hover:bg-slate-50 transition-colors',
                  selectedStudyId === s.id && 'bg-brand-50 border-l-2 border-l-brand-500',
                )}
              >
                <div className="flex items-center gap-1.5">
                  {studyStatusDot(s.status)}
                  <p className="text-xs font-medium text-slate-800 truncate">{s.name}</p>
                </div>
                <p className="text-xs text-slate-400 mt-0.5 truncate">{s.protocol_number}{s.phase ? ` · Phase ${s.phase}` : ''}</p>
              </button>
            ))}
          </div>

          {/* New study modal */}
          {showNewStudy && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{createStep === 1 ? 'New Study' : 'Add Protocol'}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{createStep === 1 ? 'Step 1 of 2 — Study details' : 'Step 2 of 2 — Attach or upload a protocol'}</p>
                  </div>
                  <button onClick={resetNewStudy} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Step 1 — Study details */}
                {createStep === 1 && (
                  <div className="px-5 py-4 space-y-3">
                    <input
                      autoFocus
                      value={newStudyForm.name}
                      onChange={e => setNewStudyForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Study name *"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <input
                      value={newStudyForm.protocol_number}
                      onChange={e => setNewStudyForm(f => ({ ...f, protocol_number: e.target.value }))}
                      placeholder="Protocol number * (e.g. TRL-001)"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="flex gap-2">
                      <select
                        value={newStudyForm.phase}
                        onChange={e => setNewStudyForm(f => ({ ...f, phase: e.target.value }))}
                        className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                      >
                        <option value="">Phase…</option>
                        {PHASES.map(p => <option key={p} value={p}>Phase {p}</option>)}
                      </select>
                      <select
                        value={newStudyForm.status}
                        onChange={e => setNewStudyForm(f => ({ ...f, status: e.target.value }))}
                        className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                      >
                        {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                      </select>
                    </div>
                    <input
                      value={newStudyForm.therapeutic_area}
                      onChange={e => setNewStudyForm(f => ({ ...f, therapeutic_area: e.target.value }))}
                      placeholder="Therapeutic area (optional)"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      onClick={handleCreateStudy}
                      disabled={creatingStudy || !newStudyForm.name.trim() || !newStudyForm.protocol_number.trim()}
                      className="w-full py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {creatingStudy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      Next — Add Protocol
                    </button>
                  </div>
                )}

                {/* Step 2 — Attach or upload protocol */}
                {createStep === 2 && (
                  <div className="px-5 py-4 space-y-3">
                    {/* Tab toggle */}
                    <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
                      <button
                        onClick={() => setProtocolMode('attach')}
                        className={clsx(
                          'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors',
                          protocolMode === 'attach' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700',
                        )}
                      >
                        <Link2 className="w-3.5 h-3.5" /> Attach Existing
                      </button>
                      <button
                        onClick={() => setProtocolMode('upload')}
                        className={clsx(
                          'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors',
                          protocolMode === 'upload' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700',
                        )}
                      >
                        <Upload className="w-3.5 h-3.5" /> Upload New
                      </button>
                    </div>

                    {/* Attach existing */}
                    {protocolMode === 'attach' && (
                      <div className="space-y-2">
                        {loadingExisting ? (
                          <div className="flex items-center justify-center py-6 text-sm text-slate-400">
                            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading protocols…
                          </div>
                        ) : existingProtocols.length === 0 ? (
                          <div className="text-center py-6 text-sm text-slate-400">
                            No unassigned protocol documents found.
                          </div>
                        ) : (
                          <div className="max-h-52 overflow-y-auto space-y-1.5">
                            {existingProtocols.map(doc => (
                              <div key={doc.id} className="flex items-center gap-2 p-2.5 border border-slate-200 rounded-lg hover:border-brand-300 hover:bg-brand-50 transition-colors">
                                <FileCode2 className="w-4 h-4 text-purple-500 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium text-slate-800 truncate">{doc.name}</p>
                                  <p className="text-xs text-slate-400">{new Date(doc.created_at).toLocaleDateString()}</p>
                                </div>
                                <button
                                  onClick={() => handleAttachProtocol(doc.id)}
                                  disabled={attachingDocId === doc.id}
                                  className="flex-shrink-0 px-2.5 py-1 bg-brand-600 text-white rounded-md text-xs font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {attachingDocId === doc.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                  Attach
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Upload new */}
                    {protocolMode === 'upload' && (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-500">Upload a new protocol document and associate it with this study.</p>
                        <button
                          onClick={() => { resetNewStudy(); setShowUpload(true) }}
                          className="w-full py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 flex items-center justify-center gap-2"
                        >
                          <Upload className="w-4 h-4" /> Open Upload Dialog
                        </button>
                      </div>
                    )}

                    <button
                      onClick={resetNewStudy}
                      className="w-full py-2 text-xs text-slate-400 hover:text-slate-600"
                    >
                      Skip for now
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between">
            <button onClick={loadStudies} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
            <button
              onClick={() => setShowNewStudy(true)}
              className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
            >
              <Plus className="w-3 h-3" /> New Study
            </button>
          </div>
        </div>

        {/* Center — Protocols */}
        <div className="flex-1 bg-white border border-slate-200 rounded-xl flex flex-col min-w-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-slate-400" />
            <div className="flex flex-col">
              <span className="text-sm font-medium text-slate-700">
                {selectedStudy ? selectedStudy.name : 'Select a study'}
              </span>
              {selectedStudy && (
                <span className="text-xs text-slate-400">{selectedStudy.protocol_number}{selectedStudy.phase ? ` · Phase ${selectedStudy.phase}` : ''}</span>
              )}
            </div>
            {selectedStudyId && (
              <button onClick={() => { if (selectedStudyId) loadProtocols(selectedStudyId) }} className="ml-auto p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {!selectedStudyId ? (
              <div className="flex flex-col items-center justify-center h-full text-sm text-slate-400 gap-2">
                <FileCode2 className="w-10 h-10 text-slate-200" />
                Select a study from the left panel
              </div>
            ) : loadingProtocols ? (
              <div className="flex items-center justify-center h-32 text-sm text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
              </div>
            ) : protocols.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-sm text-slate-400 gap-3">
                <FileCode2 className="w-10 h-10 text-slate-200" />
                <p>No protocols uploaded for this study</p>
                <button
                  onClick={() => setShowUpload(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
                >
                  <Upload className="w-4 h-4" /> Upload Protocol
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {protocols.map(p => (
                  <div
                    key={p.id}
                    onClick={() => setSelectedProtocolId(p.id === selectedProtocolId ? null : p.id)}
                    className={clsx(
                      'p-4 rounded-xl border cursor-pointer transition-all hover:shadow-sm',
                      selectedProtocolId === p.id
                        ? 'border-brand-300 bg-brand-50 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                        <FileCode2 className="w-4 h-4 text-purple-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{p.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {statusBadge(p.status)}
                          {p.uploaded_by_name && (
                            <span className="text-xs text-slate-400">{p.uploaded_by_name}</span>
                          )}
                          <span className="text-xs text-slate-400 ml-auto">
                            {new Date(p.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={e => { e.stopPropagation(); handleConvert(p.id) }}
                        disabled={converting === p.id || p.status === 'processing'}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
                      >
                        {converting === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Convert to USDM
                      </button>
                      <a
                        href={`${INGESTION_URL}/documents/${p.id}/serve`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-50 transition-colors"
                      >
                        View Document
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right — Conversions */}
        <div className="w-80 flex-shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm font-medium text-slate-700">USDM Conversions</p>
            {selectedProtocolId && (
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                {protocols.find(p => p.id === selectedProtocolId)?.name}
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {!selectedProtocolId ? (
              <div className="flex flex-col items-center justify-center h-full text-xs text-slate-400 gap-1 p-4 text-center">
                <Eye className="w-8 h-8 text-slate-200" />
                Select a protocol to see its conversions
              </div>
            ) : loadingConversions ? (
              <div className="flex items-center justify-center h-20">
                <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
              </div>
            ) : conversions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-xs text-slate-400 gap-1 p-4 text-center">
                <Eye className="w-8 h-8 text-slate-200" />
                No conversions yet — click "Convert to USDM"
              </div>
            ) : (
              <div className="divide-y divide-slate-50">
                {conversions.map(c => (
                  <div key={c.id} className="px-4 py-3 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center justify-between mb-1.5">
                      {statusBadge(c.status)}
                      {c.confidence != null && (
                        <span className="text-xs font-medium text-slate-600">
                          {Math.round(c.confidence * 100)}% conf.
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mb-2">
                      {new Date(c.created_at).toLocaleString()}
                      {c.retry_count ? ` · ${c.retry_count} retries` : ''}
                    </p>
                    <div className="flex gap-2">
                      <Link
                        href={`/protocols/observe/${c.id}`}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-brand-50 text-brand-700 rounded-lg text-xs font-medium hover:bg-brand-100 transition-colors"
                      >
                        <Eye className="w-3 h-3" /> Observe
                      </Link>
                      <Link
                        href={`/usdm/${c.id}`}
                        className="flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-50 transition-colors"
                      >
                        <ChevronRight className="w-3 h-3" /> Review USDM
                      </Link>
                      {c.plan_id && (
                        <Link
                          href={`/orchestrator?plan_id=${c.plan_id}`}
                          className="flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 text-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-50 transition-colors"
                        >
                          <FlaskConical className="w-3 h-3" /> View in Agent Console
                        </Link>
                      )}
                    </div>
                    {c.client_graph_built && (
                      <p className="text-xs text-emerald-600 mt-1.5">Context graph built</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showUpload && selectedStudyId && (
        <UploadModal
          orgId={orgId}
          userId={userId}
          userName={userName}
          forcedDocType="protocol"
          studyId={selectedStudyId}
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false)
            loadStudies()
            if (selectedStudyId) loadProtocols(selectedStudyId)
          }}
        />
      )}
    </div>
  )
}
