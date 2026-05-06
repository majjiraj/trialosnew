'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, CheckCircle, Clock, AlertCircle, Plus, X, Upload, ChevronDown, Loader2, PauseCircle, UserCheck, Play, Edit2, History, Globe, EyeOff, Settings } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { clsx } from 'clsx'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t) }, [onDone])
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-slate-900 text-white text-sm px-4 py-3 rounded-xl shadow-xl animate-in slide-in-from-bottom-2">
      <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
      {message}
    </div>
  )
}

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'
const STUDY_ID = '00000000-0000-0000-0000-000000000003'

// Full SDTM IG domain list (v3.4)
const SDTM_DOMAINS = [
  // Special Purpose
  'DM','CO','SE','SM',
  // Interventions
  'CM','EC','EX','ML','PR','SU',
  // Events
  'AE','CE','DS','DV','HO','MH',
  // Findings
  'BS','CP','CV','DA','DD','EG','FA','FT','GF','IE','IS','LB','MB','MI','MK','MS',
  'NV','OE','PC','PE','PP','QS','RE','RP','RS','SC','SR','SS','TU','UR','VS',
]

const SDTM_DOMAIN_GROUPS = [
  { label: 'Special Purpose', domains: ['DM','CO','SE','SM'] },
  { label: 'Interventions', domains: ['CM','EC','EX','ML','PR','SU'] },
  { label: 'Events', domains: ['AE','CE','DS','DV','HO','MH'] },
  { label: 'Findings', domains: ['BS','CP','CV','DA','DD','EG','FA','FT','GF','IE','IS','LB','MB','MI','MK','MS','NV','OE','PC','PE','PP','QS','RE','RP','RS','SC','SR','SS','TU','UR','VS'] },
]

async function gql(query: string, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

const statusConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  completed:        { icon: <CheckCircle className="w-4 h-4 text-green-500" />, color: 'text-green-600', label: 'Completed' },
  running:          { icon: <Clock className="w-4 h-4 text-blue-500 animate-pulse" />, color: 'text-blue-600', label: 'Running' },
  failed:           { icon: <AlertCircle className="w-4 h-4 text-red-500" />, color: 'text-red-600', label: 'Failed' },
  cancelled:        { icon: <X className="w-4 h-4 text-slate-400" />, color: 'text-slate-500', label: 'Cancelled' },
  pending:          { icon: <Clock className="w-4 h-4 text-slate-400" />, color: 'text-slate-500', label: 'Pending' },
  waiting_approval:   { icon: <PauseCircle className="w-4 h-4 text-amber-500" />, color: 'text-amber-600', label: 'Needs Review' },
  waiting_human_task: { icon: <UserCheck className="w-4 h-4 text-purple-500" />, color: 'text-purple-600', label: 'Awaiting Human' },
}

function ManageDropdown({ agentId, agentSlug, orgId, userId, isPlatformAdmin }: {
  agentId: string; agentSlug?: string; orgId: string; userId?: string; isPlatformAdmin: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [published, setPublished] = useState<boolean | null>(null)

  async function togglePublish() {
    setToggling(true)
    const isCurrentlyPublished = published ?? false
    const endpoint = isCurrentlyPublished ? 'unpublish' : 'publish'
    try {
      const res = await fetch(`${MARKETPLACE_URL}/agents/${agentId}/${endpoint}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, is_platform_admin: isPlatformAdmin }),
      })
      if (res.ok) setPublished(!isCurrentlyPublished)
    } catch (e) { console.error(e) }
    setToggling(false)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
      >
        <Settings className="w-3.5 h-3.5" /> Manage <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-xl shadow-lg border border-slate-200 w-48 py-1 text-sm">
            <button
              onClick={() => { router.push(`/agents/build?edit_id=${agentId}`); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 text-left"
            >
              <Bot className="w-3.5 h-3.5 text-slate-400" /> Edit with AI
            </button>
            {agentSlug && (
              <button
                onClick={() => { router.push(`/agents/create-flow?edit_id=${agentId}`); setOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 text-left"
              >
                <Edit2 className="w-3.5 h-3.5 text-slate-400" /> Edit in Flow Editor
              </button>
            )}
            <button
              onClick={() => { router.push(`/agents/${agentId}/versions`); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 text-left"
            >
              <History className="w-3.5 h-3.5 text-slate-400" /> Version History
            </button>
            <div className="border-t border-slate-100 my-1" />
            <button
              onClick={togglePublish}
              disabled={toggling}
              className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 text-left disabled:opacity-50"
            >
              {published ? <EyeOff className="w-3.5 h-3.5 text-red-400" /> : <Globe className="w-3.5 h-3.5 text-green-500" />}
              {toggling ? 'Working…' : published ? 'Unpublish' : 'Publish'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function AgentsPage() {
  const router = useRouter()
  const orgId = useOrgId()
  const { user } = useAuth()
  const [runs, setRuns] = useState<any[]>([])
  const [installations, setInstallations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  // Modal state
  const [selectedInstall, setSelectedInstall] = useState<any>(null)
  const [files, setFiles] = useState<File[]>([])
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [domains, setDomains] = useState<string[]>(['AE'])
  const [starting, setStarting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (orgId) loadData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  async function loadData() {
    setLoading(true)
    try {
      const [runsData, instData] = await Promise.all([
        gql(`query { agentRunsForOrg(orgId: "${orgId}", limit: 30, topLevelOnly: true) {
          id status agentName agentType agentSlug studyId
          outputSummary errorMessage startedAt createdAt
        }}`),
        gql(`query { installations(orgId: "${orgId}") {
          id agentId installedVersion isActive installedAt
          agent { id name agentType slug publisherOrgId }
        }}`),
      ])
      setRuns(runsData.agentRunsForOrg || [])
      setInstallations((instData.installations || []).filter((i: any) => i.isActive))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || [])
    if (!picked.length) return
    // Merge new files with existing (deduplicate by name)
    const existingNames = new Set(files.map(f => f.name))
    const newFiles = picked.filter(f => !existingNames.has(f.name))
    if (!newFiles.length) return
    setFiles(prev => [...prev, ...newFiles])
    setUploading(true)
    setUploadError(null)
    // Reset input so the same file can be re-picked if removed
    if (fileInputRef.current) fileInputRef.current.value = ''
    try {
      const results: any[] = []
      for (const f of newFiles) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('org_id', orgId)
        fd.append('study_id', STUDY_ID)
        fd.append('document_type', 'other')
        fd.append('uploaded_by', user?.id ?? '00000000-0000-0000-0000-000000000002')
        const res = await fetch(`${INGESTION_URL}/documents/upload`, { method: 'POST', body: fd })
        const data = await res.json()
        if (res.status === 409 && data.duplicate) {
          results.push({ doc_id: data.existing_document_id, filename: f.name, s3_key: data.s3_key || `raw/${orgId}/${f.name}` })
        } else if (!res.ok) {
          throw new Error(data.detail ? JSON.stringify(data.detail) : `Upload failed: ${res.status}`)
        } else {
          results.push({ doc_id: data.document_id, filename: f.name, s3_key: data.s3_key || data.bronze_s3_key || `raw/${orgId}/${f.name}` })
        }
      }
      setUploadedFiles(prev => [...prev, ...results])
    } catch (e: any) {
      console.error('Upload failed', e)
      setUploadError(e.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function removeFile(filename: string) {
    setFiles(prev => prev.filter(f => f.name !== filename))
    setUploadedFiles(prev => prev.filter(f => f.filename !== filename))
  }

  async function handleStartRun() {
    if (!selectedInstall || starting) return
    setStarting(true)
    try {
      const isSdtm = selectedInstall.agent?.agentType === 'sdtm_mapper'
      const inputContext: any = { created_by: user?.id ?? '00000000-0000-0000-0000-000000000002' }
      if (isSdtm) {
        inputContext.files = uploadedFiles
        inputContext.target_domains = domains
      }
      const data = await gql(`
        mutation StartRun($instId: String!, $studyId: String!, $orgId: String!, $ctx: JSON!) {
          startAgentRun(installationId: $instId, studyId: $studyId, orgId: $orgId, inputContext: $ctx) { id status }
        }`, { instId: selectedInstall.id, studyId: STUDY_ID, orgId: orgId, ctx: inputContext })
      setShowModal(false)
      setToast('Run started — opening session view…')
      setTimeout(() => router.push(`/agents/runs/${data.startAgentRun.id}`), 800)
    } catch (e) {
      console.error('Start run failed', e)
      setStarting(false)
    }
  }

  const selectedAgent = selectedInstall?.agent

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Agent Console</h1>
          <p className="text-sm text-slate-500 mt-1">Monitor agent runs, manage triggers, review approvals</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors">
            <Play className="w-4 h-4" /> New Run
          </button>
          <Link href="/agents/build"
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors">
            <Bot className="w-4 h-4" /> Build Agent with AI
          </Link>
        </div>
      </div>

      <div className="card divide-y divide-slate-50">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Recent Agent Runs</h2>
          <button onClick={loadData} className="text-xs text-brand-500 hover:underline">Refresh</button>
        </div>
        {loading ? (
          <div className="px-5 py-8 flex items-center gap-2 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading runs...
          </div>
        ) : runs.length === 0 ? (
          <div className="px-5 py-8 text-center text-slate-400 text-sm">
            No runs yet. Click <strong>New Run</strong> to start.
          </div>
        ) : (
          runs.map(run => {
            const s = statusConfig[run.status] || statusConfig.pending
            return (
              <div key={run.id} onClick={() => router.push(`/agents/runs/${run.id}`)}
                className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50 transition-colors cursor-pointer">
                <div className="w-9 h-9 bg-brand-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-brand-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{run.agentName || 'Agent Run'}</span>
                    {s.icon}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">
                    {run.outputSummary || run.errorMessage || (run.status === 'running' ? 'Running…' : '')}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className={clsx('text-xs font-medium', s.color)}>{s.label}</span>
                  <p className="text-xs text-slate-400 mt-0.5">{timeAgo(run.createdAt)}</p>
                  {run.agentSlug && (
                    <button
                      onClick={e => { e.stopPropagation(); router.push(`/agents/flow-view/${run.agentSlug}`) }}
                      className="text-xs text-brand-500 hover:underline mt-0.5 block"
                    >
                      View Flow
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Installed Agents block hidden */}

      {/* Launch Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Start New Run</h2>
              <button onClick={() => { setShowModal(false); setFiles([]); setUploadedFiles([]); setUploadError(null); setSelectedInstall(null); setStarting(false) }}
                className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Installation picker */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Agent</label>
                <div className="relative">
                  <select
                    className="w-full appearance-none border border-slate-200 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    value={selectedInstall?.id || ''}
                    onChange={e => setSelectedInstall(installations.find(i => i.id === e.target.value) || null)}>
                    <option value="">Select installed agent…</option>
                    {installations.map(i => (
                      <option key={i.id} value={i.id}>{i.agent?.name || i.agentId}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              {/* SDTM-specific options */}
              {selectedAgent?.agentType === 'sdtm_mapper' && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium text-slate-600">
                        Upload Raw EDC Files <span className="text-slate-400">(CSV, XLS, XLSX)</span>
                      </label>
                      {files.length > 0 && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium"
                        >
                          <Plus className="w-3 h-3" /> Add more
                        </button>
                      )}
                    </div>
                    {files.length === 0 ? (
                      <div
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-brand-300 transition-colors">
                        <Upload className="w-5 h-5 text-slate-300 mx-auto mb-1" />
                        <p className="text-xs text-slate-400">Click to select files</p>
                        <p className="text-xs text-slate-300 mt-0.5">You can select multiple files at once</p>
                      </div>
                    ) : (
                      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                        {files.map(f => {
                          const uploaded = uploadedFiles.find(u => u.filename === f.name)
                          return (
                            <div key={f.name} className="flex items-center gap-2 px-3 py-2">
                              {uploaded ? (
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                              ) : (
                                <Loader2 className="w-3.5 h-3.5 text-slate-300 animate-spin flex-shrink-0" />
                              )}
                              <span className="text-xs text-slate-700 flex-1 truncate">{f.name}</span>
                              <button
                                type="button"
                                onClick={() => removeFile(f.name)}
                                className="p-0.5 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 flex-shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          )
                        })}
                        {uploading && (
                          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400">
                            <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
                          </div>
                        )}
                      </div>
                    )}
                    <input ref={fileInputRef} type="file" multiple accept=".csv,.xls,.xlsx" className="hidden" onChange={handleFileChange} />
                    {uploadError && (
                      <div className="mt-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{uploadError}</div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium text-slate-600">
                        Target SDTM Domains <span className="text-slate-400">(select one or more)</span>
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setDomains([...SDTM_DOMAINS])} className="text-xs text-brand-500 hover:underline">All</button>
                        <button type="button" onClick={() => setDomains([])} className="text-xs text-slate-400 hover:underline">None</button>
                      </div>
                    </div>
                    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                      {SDTM_DOMAIN_GROUPS.map(group => (
                        <div key={group.label}>
                          <p className="text-xs text-slate-400 font-medium mb-1">{group.label}</p>
                          <div className="flex flex-wrap gap-1">
                            {group.domains.map(d => {
                              const checked = domains.includes(d)
                              return (
                                <button
                                  key={d}
                                  type="button"
                                  onClick={() => setDomains(prev =>
                                    prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                                  )}
                                  className={`px-2 py-1 rounded text-xs font-semibold border transition-colors ${
                                    checked
                                      ? 'bg-brand-500 text-white border-brand-500'
                                      : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300'
                                  }`}
                                >
                                  {d}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    {domains.length === 0 && (
                      <p className="text-xs text-red-500 mt-1">Select at least one domain</p>
                    )}
                    {domains.length > 0 && (
                      <p className="text-xs text-slate-400 mt-1">{domains.length} domain{domains.length > 1 ? 's' : ''} selected</p>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={handleStartRun}
                disabled={!selectedInstall || starting || (selectedAgent?.agentType === 'sdtm_mapper' && (uploadedFiles.length === 0 || domains.length === 0))}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Start Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
