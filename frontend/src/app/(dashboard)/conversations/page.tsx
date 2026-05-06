'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Loader2, Send, Plus, Search, X, MessageSquare, ChevronRight, ChevronDown, Folder, ThumbsUp, ThumbsDown, FileText, Activity } from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'
import { clsx } from 'clsx'

// ============================================================
// TYPES
// ============================================================

interface Message {
  role: 'user' | 'assistant'
  content: string
  runId?: string  // for assistant messages, enables feedback
}

interface ConversationRecord {
  id: string
  orgId: string
  agentInstallationId: string
  agentName: string
  selectedDocumentIds: string[]
  messages: Message[]
  createdAt: string
  updatedAt: string
}

interface Installation {
  id: string
  agentId: string
  installedVersion: string
  isActive: boolean
  agent: { id: string; name: string; agentType: string; slug: string; publisherOrgId: string }
}

interface Document {
  id: string
  name: string
  document_type: string
  status: string
  file_size_bytes: number
}

interface FolderNode {
  id: string
  name: string
  parent_id: string | null
  doc_count: number
  children?: FolderNode[]
}

interface WizardState {
  step: 'agent' | 'context' | 'files'
  selectedInstallation: Installation | null
  contextChoice: 'none' | 'files' | null
  selectedDocumentIds: string[]
}

// ============================================================
// CONSTANTS & HELPERS
// ============================================================

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const STUDY_ID = '00000000-0000-0000-0000-000000000003'
const ACTIVE_STATUSES = new Set(['running', 'pending'])
const LS_KEY = 'trialo_conversations'

async function gql(query: string, variables = {}) {
  const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
  console.log('GraphQL Request:', { query, variables, hasToken: !!token })
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  console.log('GraphQL Response:', { data, errors })
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

function loadConversations(): ConversationRecord[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]')
  } catch {
    return []
  }
}

function saveConversations(list: ConversationRecord[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

function formatHistory(messages: Message[]): string {
  return messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function ConversationListPanel({
  conversations,
  activeId,
  orgId,
  onSelect,
  onNewConversation,
}: {
  conversations: ConversationRecord[]
  activeId: string | null
  orgId: string
  onSelect: (id: string) => void
  onNewConversation: () => void
}) {
  const filtered = conversations.filter(c => c.orgId === orgId).sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )

  return (
    <div className="w-64 border-r border-slate-200 overflow-y-auto bg-slate-50 flex flex-col">
      <button
        onClick={onNewConversation}
        className="m-4 flex items-center justify-center gap-2 px-3 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors text-sm font-medium"
      >
        <Plus className="w-4 h-4" />
        New Conversation
      </button>

      <div className="flex-1 overflow-y-auto px-2">
        {filtered.length === 0 ? (
          <p className="text-xs text-slate-400 text-center mt-8">No conversations yet.</p>
        ) : (
          <div className="space-y-1">
            {filtered.map(conv => {
              const preview = conv.messages[0]?.content?.slice(0, 40) || '(empty)'
              const isActive = conv.id === activeId
              return (
                <button
                  key={conv.id}
                  onClick={() => onSelect(conv.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-lg border-l-2 transition-colors text-xs',
                    isActive
                      ? 'bg-brand-50 border-brand-500 text-brand-700'
                      : 'border-transparent hover:bg-slate-100'
                  )}
                >
                  <div className="font-medium text-slate-700">{conv.agentName}</div>
                  <div className="text-slate-500 truncate">{preview}</div>
                  <div className="text-slate-400 text-xs">{timeAgo(conv.updatedAt)}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentPickerStep({
  installations,
  selected,
  onSelect,
  onNext,
}: {
  installations: Installation[]
  selected: Installation | null
  onSelect: (inst: Installation) => void
  onNext: () => void
}) {
  const [search, setSearch] = useState('')

  if (installations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center px-6">
        <MessageSquare className="w-16 h-16 text-slate-300 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700 mb-2">No Agents Installed</h2>
        <p className="text-sm text-slate-500 mb-6">Visit the Marketplace to install an agent and start conversing.</p>
        <Link href="/marketplace" className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium">
          Browse Marketplace
        </Link>
      </div>
    )
  }

  const filtered = installations.filter(inst =>
    inst.agent.name.toLowerCase().includes(search.toLowerCase()) ||
    inst.agent.agentType.toLowerCase().includes(search.toLowerCase()) ||
    inst.agent.slug.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 flex flex-col min-h-0 flex-1">
      <h2 className="text-2xl font-bold text-slate-700 mb-1">Select an Agent</h2>
      <p className="text-sm text-slate-500 mb-4">Choose which agent you'd like to converse with.</p>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search agents..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
          autoFocus
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-2 top-2 p-0.5 hover:bg-slate-100 rounded">
            <X className="w-3.5 h-3.5 text-slate-400" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto mb-4">
        {filtered.length === 0 ? (
          <p className="text-xs text-slate-400 text-center mt-8">No agents match &ldquo;{search}&rdquo;.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map(inst => (
              <button
                key={inst.id}
                onClick={() => onSelect(inst)}
                className={clsx(
                  'p-4 rounded-xl border-2 transition-colors text-left',
                  selected?.id === inst.id
                    ? 'border-brand-500 bg-brand-50'
                    : 'border-slate-200 hover:border-slate-300'
                )}
              >
                <Bot className={clsx('w-6 h-6 mb-2', selected?.id === inst.id ? 'text-brand-500' : 'text-slate-400')} />
                <div className="font-semibold text-slate-700 text-sm">{inst.agent.name}</div>
                <div className="text-xs text-slate-500">{inst.agent.agentType}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onNext}
        disabled={!selected}
        className="w-full px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-40 font-medium text-sm"
      >
        Next
      </button>
    </div>
  )
}

function ContextSourceStep({
  onChoice,
  onBack,
}: {
  onChoice: (c: 'none' | 'files') => void
  onBack: () => void
}) {
  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold text-slate-700 mb-2">Choose Context Source</h2>
      <p className="text-sm text-slate-500 mb-8">What data would you like to provide as context?</p>

      <div className="space-y-4 mb-6">
        <button
          onClick={() => onChoice('none')}
          className="w-full p-4 rounded-xl border-2 border-slate-200 hover:border-brand-500 transition-colors text-left hover:bg-brand-50"
        >
          <div className="font-semibold text-slate-700 mb-1">No Context</div>
          <div className="text-xs text-slate-500">Start a conversation without any document context</div>
        </button>

        <button
          onClick={() => onChoice('files')}
          className="w-full p-4 rounded-xl border-2 border-slate-200 hover:border-brand-500 transition-colors text-left hover:bg-brand-50"
        >
          <div className="font-semibold text-slate-700 mb-1">Use Files from Library</div>
          <div className="text-xs text-slate-500">Select documents to use as context for the conversation</div>
        </button>
      </div>

      <button
        onClick={onBack}
        className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium text-sm"
      >
        Back
      </button>
    </div>
  )
}

function FolderTreeItem({
  folder,
  selectedIds,
  folderDocs,
  expandedFolders,
  onToggleFolder,
  onToggleFolderExpand,
}: {
  folder: FolderNode
  selectedIds: Set<string>
  folderDocs: Map<string, string[]>
  expandedFolders: Set<string>
  onToggleFolder: (folderId: string) => void
  onToggleFolderExpand: (folderId: string) => void
}) {
  const checkboxRef = useRef<HTMLInputElement>(null)
  const docIds = folderDocs.get(folder.id) || []
  const allSelected = docIds.length > 0 && docIds.every(id => selectedIds.has(id))
  const someSelected = docIds.some(id => selectedIds.has(id))
  const isExpanded = expandedFolders.has(folder.id)

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = someSelected && !allSelected
    }
  }, [someSelected, allSelected])

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-100 rounded">
        {folder.children && folder.children.length > 0 ? (
          <button onClick={() => onToggleFolderExpand(folder.id)} className="p-0.5">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
            )}
          </button>
        ) : (
          <div className="w-4" />
        )}
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allSelected}
          onChange={() => onToggleFolder(folder.id)}
          className="w-4 h-4 rounded border-slate-300 text-brand-500 focus:ring-2 focus:ring-brand-500 cursor-pointer"
        />
        <Folder className="w-4 h-4 text-slate-500" />
        <span className="flex-1 text-xs font-medium text-slate-700">{folder.name}</span>
        <span className="text-xs text-slate-500">({folder.doc_count})</span>
      </div>
      {isExpanded && folder.children && folder.children.length > 0 && (
        <div className="ml-4 space-y-1">
          {folder.children.map(child => (
            <FolderTreeItem
              key={child.id}
              folder={child}
              selectedIds={selectedIds}
              folderDocs={folderDocs}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onToggleFolderExpand={onToggleFolderExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilePickerStep({
  orgId,
  selectedIds,
  onToggle,
  onConfirm,
  onBack,
}: {
  orgId: string
  selectedIds: Set<string>
  onToggle: (id: string) => void
  onConfirm: () => void
  onBack: () => void
}) {
  const [docs, setDocs] = useState<Document[]>([])
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [folderDocs, setFolderDocs] = useState<Map<string, string[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [docRes, treeRes] = await Promise.all([
          fetch(`${INGESTION_URL}/documents?org_id=${orgId}`),
          fetch(`${INGESTION_URL}/folders/tree?org_id=${orgId}`),
        ])
        const { documents } = await docRes.json()
        const { tree, folder_doc_map } = await treeRes.json()
        setDocs(documents || [])
        setFolders(tree || [])
        if (folder_doc_map) {
          setFolderDocs(new Map(Object.entries(folder_doc_map as Record<string, string[]>)))
        }
      } catch (e) {
        console.error('Failed to fetch documents/folders:', e)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [orgId])

  const toggleFolder = (folderId: string) => {
    const docIds = folderDocs.get(folderId) || []
    const allSelected = docIds.every(id => selectedIds.has(id))
    docIds.forEach(id => {
      const shouldBeSelected = !allSelected
      const isCurrentlySelected = selectedIds.has(id)
      if (shouldBeSelected !== isCurrentlySelected) {
        onToggle(id)
      }
    })
  }

  const toggleFolderExpand = (folderId: string) => {
    const updated = new Set(expandedFolders)
    if (updated.has(folderId)) {
      updated.delete(folderId)
    } else {
      updated.add(folderId)
    }
    setExpandedFolders(updated)
  }

  const filtered = docs.filter(
    d => d.name.toLowerCase().includes(search.toLowerCase()) ||
         d.document_type.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 flex flex-col min-h-0 flex-1">
      <h2 className="text-2xl font-bold text-slate-700 mb-2">Select Files</h2>
      <p className="text-sm text-slate-500 mb-4">Click a folder to select all files in it, or search and select individual files.</p>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search documents..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="flex-1 overflow-y-auto mb-4 border border-slate-200 rounded-lg bg-slate-50">
        {loading ? (
          <div className="text-xs text-slate-400 text-center mt-8">Loading documents...</div>
        ) : search ? (
          <div className="p-3 space-y-2">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center mt-4">No documents found.</p>
            ) : (
              filtered.map(doc => (
                <label key={doc.id} className="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(doc.id)}
                    onChange={() => onToggle(doc.id)}
                    className="w-4 h-4 rounded border-slate-300 text-brand-500 focus:ring-2 focus:ring-brand-500"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-slate-700">{doc.name}</div>
                    <div className="text-slate-500">{doc.document_type}</div>
                  </div>
                </label>
              ))
            )}
          </div>
        ) : (
          <div className="p-3 space-y-1">
            {folders.length === 0 ? (
              <div className="space-y-2">
                {docs.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center mt-4">No documents available.</p>
                ) : (
                  <div>
                    <p className="text-xs text-slate-500 font-medium mb-2">Documents</p>
                    {docs.map(doc => (
                      <label key={doc.id} className="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(doc.id)}
                          onChange={() => onToggle(doc.id)}
                          className="w-4 h-4 rounded border-slate-300 text-brand-500 focus:ring-2 focus:ring-brand-500"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-slate-700">{doc.name}</div>
                          <div className="text-slate-500">{doc.document_type}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              folders.map(folder => (
                <FolderTreeItem
                  key={folder.id}
                  folder={folder}
                  selectedIds={selectedIds}
                  folderDocs={folderDocs}
                  expandedFolders={expandedFolders}
                  onToggleFolder={toggleFolder}
                  onToggleFolderExpand={toggleFolderExpand}
                />
              ))
            )}
          </div>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 max-h-20 overflow-y-auto">
          {Array.from(selectedIds).map(id => {
            const doc = docs.find(d => d.id === id)
            return (
              <div key={id} className="inline-flex items-center gap-2 bg-brand-100 text-brand-700 px-2 py-1 rounded-full text-xs whitespace-nowrap">
                {doc?.name || 'Unknown'}
                <button
                  onClick={() => onToggle(id)}
                  className="hover:bg-brand-200 rounded-full p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="space-y-3">
        <button
          onClick={onConfirm}
          className="w-full px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 font-medium text-sm"
        >
          Start Conversation ({selectedIds.size} files)
        </button>
        <button
          onClick={onBack}
          className="w-full px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium text-sm"
        >
          Back
        </button>
      </div>
    </div>
  )
}

function NewConversationWizard({
  installations,
  orgId,
  onComplete,
  onCancel,
}: {
  installations: Installation[]
  orgId: string
  onComplete: (inst: Installation, docIds: string[]) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<'agent' | 'context' | 'files'>('agent')
  const [selectedInstallation, setSelectedInstallation] = useState<Installation | null>(null)
  const [contextChoice, setContextChoice] = useState<'none' | 'files' | null>(null)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(new Set<string>())

  const handleContextChoice = (choice: 'none' | 'files') => {
    setContextChoice(choice)
    if (choice === 'none') {
      onComplete(selectedInstallation!, [])
    } else {
      setStep('files')
    }
  }

  const handleDocumentToggle = (id: string) => {
    setSelectedDocumentIds(prev => {
      const updated = new Set(prev)
      if (updated.has(id)) {
        updated.delete(id)
      } else {
        updated.add(id)
      }
      return updated
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {step === 'agent' && (
          <AgentPickerStep
            installations={installations}
            selected={selectedInstallation}
            onSelect={setSelectedInstallation}
            onNext={() => setStep('context')}
          />
        )}
        {step === 'context' && selectedInstallation && (
          <ContextSourceStep
            onChoice={handleContextChoice}
            onBack={() => setStep('agent')}
          />
        )}
        {step === 'files' && selectedInstallation && (
          <FilePickerStep
            orgId={orgId}
            selectedIds={selectedDocumentIds}
            onToggle={handleDocumentToggle}
            onConfirm={() => onComplete(selectedInstallation, Array.from(selectedDocumentIds))}
            onBack={() => setStep('context')}
          />
        )}
      </div>
    </div>
  )
}

interface SourceCitation {
  doc_name?: string
  section?: string
  score?: number
  excerpt?: string
  chunk_id?: string
}

function MessageSources({ runId }: { runId: string }) {
  const [sources, setSources] = useState<SourceCitation[]>([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const loadSources = async () => {
    if (loaded) { setOpen(o => !o); return }
    try {
      // Try provenance manifest first (most complete)
      const res = await fetch(`${RUNTIME_URL}/runs/${runId}/provenance-manifest`)
      if (res.ok) {
        const data = await res.json()
        setSources(data.sources_cited || [])
      }
    } catch {
      // Fallback: context-graph traces
      try {
        const res2 = await fetch(`${CONTEXT_GRAPH_URL}/traces/${runId}`)
        if (res2.ok) {
          const data2 = await res2.json()
          const traces = data2.traces || [data2]
          const srcs: SourceCitation[] = []
          for (const t of traces) {
            const cited = t.sources_cited || []
            srcs.push(...(Array.isArray(cited) ? cited : []))
          }
          setSources(srcs.slice(0, 10))
        }
      } catch { /* silent */ }
    }
    setLoaded(true)
    setOpen(true)
  }

  if (sources.length === 0 && loaded) return null

  return (
    <div className="mt-1">
      <button
        onClick={loadSources}
        className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 transition-colors"
      >
        <FileText className="w-3 h-3" />
        {loaded ? (open ? 'Hide sources' : `${sources.length} sources`) : 'Show sources'}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && sources.length > 0 && (
        <div className="mt-1.5 space-y-1 border-l-2 border-indigo-100 pl-3">
          {sources.slice(0, 6).map((s, i) => {
            const score = typeof s.score === 'number' ? s.score : 0
            const scoreColor = score >= 0.7 ? 'text-green-600' : score >= 0.4 ? 'text-amber-500' : 'text-gray-400'
            return (
              <div key={i} className="text-xs text-gray-600">
                <span className="font-medium text-gray-700">{s.doc_name || 'Document'}</span>
                {s.section && <span className="text-gray-400 ml-1">§ {s.section}</span>}
                <span className={`ml-2 font-mono ${scoreColor}`}>{(score * 100).toFixed(0)}%</span>
                {s.excerpt && (
                  <p className="text-gray-500 mt-0.5 line-clamp-2">"{s.excerpt.slice(0, 100)}"</p>
                )}
              </div>
            )
          })}
          {sources.length > 6 && (
            <p className="text-xs text-gray-400">+{sources.length - 6} more sources</p>
          )}
        </div>
      )}
    </div>
  )
}

function MessageFeedback({
  runId,
  orgId,
  userId,
}: {
  runId: string
  orgId: string
  userId: string
}) {
  const [state, setState] = useState<'idle' | 'correcting' | 'done'>('idle')
  const [correction, setCorrection] = useState('')
  const [loading, setLoading] = useState(false)

  const sendFeedback = async (
    type: 'endorsement' | 'rejection' | 'correction',
    value: Record<string, unknown>
  ) => {
    setLoading(true)
    try {
      await gql(
        `mutation($input: ContextFeedbackInput!) { submitContextFeedback(input: $input) }`,
        {
          input: {
            agentRunId: runId,
            orgId,
            feedbackType: type,
            feedbackValue: value,
            submittedBy: userId,
          },
        }
      )
      setState('done')
    } catch (e) {
      console.error('Feedback failed:', e)
    } finally {
      setLoading(false)
    }
  }

  if (state === 'done') {
    return (
      <p className="text-xs text-green-600 flex items-center gap-1 mt-2">
        <ThumbsUp className="w-3 h-3" /> Feedback recorded
      </p>
    )
  }

  return (
    <div className="mt-2 space-y-2">
      {state === 'idle' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400">Helpful?</span>
          <button
            onClick={() => sendFeedback('endorsement', { reason: 'helpful' })}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-xs text-green-600 bg-green-50 hover:bg-green-100 rounded-md transition-colors disabled:opacity-50"
          >
            <ThumbsUp className="w-3 h-3" /> Yes
          </button>
          <button
            onClick={() => setState('correcting')}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors disabled:opacity-50"
          >
            <ThumbsDown className="w-3 h-3" /> No / Correct it
          </button>
        </div>
      )}
      {state === 'correcting' && (
        <div className="space-y-2">
          <textarea
            value={correction}
            onChange={e => setCorrection(e.target.value)}
            placeholder="What should the correct answer be?"
            rows={2}
            className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none disabled:opacity-50"
            disabled={loading}
          />
          <div className="flex gap-2">
            <button
              onClick={() =>
                sendFeedback('correction', {
                  corrected_text: correction,
                  reason: 'user_correction',
                })
              }
              disabled={!correction.trim() || loading}
              className="px-3 py-1 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-40 transition-colors"
            >
              Submit Correction
            </button>
            <button
              onClick={() => setState('idle')}
              disabled={loading}
              className="px-3 py-1 text-xs border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ChatInterface({
  conversation,
  orgId,
  userId,
  onUpdate,
  onNew,
}: {
  conversation: ConversationRecord
  orgId: string
  userId: string
  onUpdate: (updated: ConversationRecord) => void
  onNew: () => void
}) {
  const [input, setInput] = useState('')
  const [polling, setPolling] = useState(false)
  const [thinkingStatus, setThinkingStatus] = useState<{ step: string; detail: string } | null>(null)
  const [showFiles, setShowFiles] = useState(false)
  const [docNames, setDocNames] = useState<Record<string, string>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const filesPopoverRef = useRef<HTMLDivElement>(null)

  // Fetch document names for context files
  useEffect(() => {
    if (!conversation.selectedDocumentIds.length) return
    fetch(`${INGESTION_URL}/documents?org_id=${orgId}`)
      .then(r => r.json())
      .then((docs: Document[]) => {
        const map: Record<string, string> = {}
        for (const d of docs) map[d.id] = d.name
        setDocNames(map)
      })
      .catch(() => {})
  }, [conversation.id, orgId])

  // Close file popover on outside click
  useEffect(() => {
    if (!showFiles) return
    const handler = (e: MouseEvent) => {
      if (filesPopoverRef.current && !filesPopoverRef.current.contains(e.target as Node)) {
        setShowFiles(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFiles])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.messages, polling])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || polling) return
    setInput('')

    const updatedConv: ConversationRecord = {
      ...conversation,
      messages: [...conversation.messages, { role: 'user', content: text }],
      updatedAt: new Date().toISOString(),
    }
    onUpdate(updatedConv)
    setPolling(true)

    try {
      const history = formatHistory(conversation.messages)
      const ctx: Record<string, unknown> = {
        message: text,
        query: text,
        history,
      }
      if (conversation.selectedDocumentIds.length > 0) {
        ctx.document_ids = conversation.selectedDocumentIds
      }

      const runData = await gql(
        `mutation($i:String!,$s:String!,$o:String!,$c:JSON){
          startAgentRun(installationId:$i,studyId:$s,orgId:$o,inputContext:$c){ id status }
        }`,
        { i: conversation.agentInstallationId, s: STUDY_ID, o: orgId, c: ctx }
      )

      const runId = runData.startAgentRun?.id
      if (!runId) throw new Error('Failed to start agent run')

      // Seed thinking status immediately so the bar appears right away
      setThinkingStatus({ step: 'Agent is thinking…', detail: 'Initializing run' })

      const interval = setInterval(async () => {
        try {
          const pollData = await gql(
            `query($id:String!){ agentRunDetail(runId:$id){ id status outputSummary errorMessage stepTraces } }`,
            { id: runId }
          )
          const run = pollData.agentRunDetail

          // Update live thinking status from latest step trace
          const steps: any[] = Array.isArray(run.stepTraces) ? run.stepTraces : []
          const last = steps[steps.length - 1]
          if (last) {
            setThinkingStatus({
              step: last.name || 'Processing…',
              detail: last.details || (last.tool_name ? `Tool: ${last.tool_name}` : ''),
            })
          }

          if (!ACTIVE_STATUSES.has(run.status)) {
            clearInterval(interval)
            setPolling(false)
            setThinkingStatus(null)
            const reply =
              run.status === 'completed'
                ? run.outputSummary || 'Task completed.'
                : `Error: ${run.errorMessage || 'Agent run failed'}`
            const assistantMsg: Message = {
              role: 'assistant',
              content: reply,
              runId: run.id, // store run ID for feedback
            }
            const finalConv: ConversationRecord = {
              ...updatedConv,
              messages: [...updatedConv.messages, assistantMsg],
              updatedAt: new Date().toISOString(),
            }
            onUpdate(finalConv)
          }
        } catch (e) {
          clearInterval(interval)
          setPolling(false)
          setThinkingStatus(null)
          const errorMsg = e instanceof Error ? e.message : 'Unknown error'
          const errorConv: ConversationRecord = {
            ...updatedConv,
            messages: [...updatedConv.messages, { role: 'assistant', content: `Error: ${errorMsg}` }],
            updatedAt: new Date().toISOString(),
          }
          onUpdate(errorConv)
        }
      }, 2000)
    } catch (e) {
      setPolling(false)
      setThinkingStatus(null)
      const errorMsg = e instanceof Error ? e.message : 'Unknown error'
      const errorConv: ConversationRecord = {
        ...updatedConv,
        messages: [...updatedConv.messages, { role: 'assistant', content: `Error: ${errorMsg}` }],
        updatedAt: new Date().toISOString(),
      }
      onUpdate(errorConv)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between bg-white">
        <div>
          <h2 className="font-bold text-slate-700">{conversation.agentName}</h2>
          {conversation.selectedDocumentIds.length > 0 && (
            <div ref={filesPopoverRef} className="relative">
              <button
                onClick={() => setShowFiles(v => !v)}
                className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 mt-0.5 group"
              >
                <FileText className="w-3 h-3" />
                <span className="underline underline-offset-2">{conversation.selectedDocumentIds.length} file(s) in context</span>
                <ChevronDown className={clsx('w-3 h-3 transition-transform', showFiles && 'rotate-180')} />
              </button>
              {showFiles && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1.5 max-h-56 overflow-y-auto">
                  <div className="px-3 py-1 text-[10px] text-slate-400 uppercase tracking-wide font-medium border-b border-slate-100 mb-1">
                    Files in context
                  </div>
                  {conversation.selectedDocumentIds.map(id => (
                    <div key={id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
                      <FileText className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span className="text-xs text-slate-700 truncate">{docNames[id] || id}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          New
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {conversation.messages.length === 0 && (
          <p className="text-center text-sm text-slate-400 mt-8">Start a conversation...</p>
        )}
        {conversation.messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={msg.role === 'user' ? '' : 'max-w-[70%]'}>
              <div
                className={clsx(
                  'px-4 py-3 rounded-2xl text-sm',
                  msg.role === 'user'
                    ? 'bg-brand-500 text-white max-w-[70%]'
                    : 'bg-slate-100 text-slate-700'
                )}
              >
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({children}) => <h1 className="text-base font-bold mt-2 mb-1">{children}</h1>,
                      h2: ({children}) => <h2 className="text-sm font-bold mt-2 mb-1">{children}</h2>,
                      h3: ({children}) => <h3 className="text-sm font-semibold mt-1 mb-0.5">{children}</h3>,
                      p: ({children}) => <p className="mb-2 last:mb-0">{children}</p>,
                      ul: ({children}) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                      li: ({children}) => <li className="text-sm">{children}</li>,
                      strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                      code: ({children}) => <code className="bg-slate-200 text-slate-800 px-1 py-0.5 rounded text-xs font-mono">{children}</code>,
                      pre: ({children}) => <pre className="bg-slate-200 text-slate-800 p-2 rounded text-xs font-mono overflow-x-auto mb-2">{children}</pre>,
                      table: ({children}) => <table className="text-xs border-collapse w-full mb-2">{children}</table>,
                      th: ({children}) => <th className="border border-slate-300 px-2 py-1 bg-slate-200 font-semibold text-left">{children}</th>,
                      td: ({children}) => <td className="border border-slate-300 px-2 py-1">{children}</td>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}
              </div>
              {msg.role === 'assistant' && msg.runId && (
                <MessageSources runId={msg.runId} />
              )}
              {msg.role === 'assistant' && msg.runId && (
                <MessageFeedback runId={msg.runId} orgId={orgId} userId={userId} />
              )}
            </div>
          </div>
        ))}
        {polling && (
          <div className="flex justify-start">
            <div className="px-4 py-3 bg-slate-100 rounded-2xl">
              <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Thinking status bar */}
      {polling && thinkingStatus && (
        <div className="mx-4 mb-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-brand-500 flex-shrink-0 animate-pulse" />
            <span className="text-xs font-medium text-brand-700 truncate">{thinkingStatus.step}</span>
          </div>
          {thinkingStatus.detail && (
            <p className="text-[11px] text-slate-400 truncate pl-4.5">{thinkingStatus.detail}</p>
          )}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-slate-200 p-4 bg-white flex gap-3 items-end">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          onInput={e => {
            const t = e.target as HTMLTextAreaElement
            t.style.height = 'auto'
            t.style.height = t.scrollHeight + 'px'
          }}
          placeholder="Ask the agent..."
          disabled={polling}
          rows={1}
          className="flex-1 resize-none border border-slate-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || polling}
          className="px-4 py-3 bg-brand-500 text-white rounded-xl hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function ConversationsPage() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const userId = user?.id || ''
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [wizardState, setWizardState] = useState<WizardState | null>(null)
  const [installations, setInstallations] = useState<Installation[]>([])
  const [loading, setLoading] = useState(true)

  // Load conversations on mount
  useEffect(() => {
    if (!orgId) return
    const all = loadConversations()
    const mine = all.filter(c => c.orgId === orgId)
    setConversations(mine)
  }, [orgId])

  // Fetch installations on mount
  useEffect(() => {
    if (!orgId) {
      console.log('No orgId available, skipping installations fetch')
      setLoading(false)
      return
    }
    console.log('Fetching installations for orgId:', orgId)
    const fetchInstallations = async () => {
      try {
        const data = await gql(`query($orgId:String!){ installations(orgId:$orgId){ id agentId installedVersion isActive agent{ id name agentType slug publisherOrgId } } }`, { orgId })
        console.log('Installations response:', data)
        const filtered = (data.installations || []).filter((i: Installation) => i.isActive)
        console.log('Filtered installations:', filtered)
        setInstallations(filtered)
      } catch (e) {
        console.error('Failed to fetch installations:', e)
      } finally {
        setLoading(false)
      }
    }
    fetchInstallations()
  }, [orgId])

  const activeConversation = conversations.find(c => c.id === activeId)

  const handleWizardComplete = (inst: Installation, docIds: string[]) => {
    if (!orgId) return
    const newConv: ConversationRecord = {
      id: crypto.randomUUID(),
      orgId,
      agentInstallationId: inst.id,
      agentName: inst.agent.name,
      selectedDocumentIds: docIds,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const updated = [newConv, ...conversations]
    setConversations(updated)
    saveConversations(updated)
    setActiveId(newConv.id)
    setWizardState(null)
  }

  const handleConversationUpdate = (updated: ConversationRecord) => {
    const list = conversations.map(c => (c.id === updated.id ? updated : c))
    setConversations(list)
    saveConversations(list)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-500" />
      </div>
    )
  }

  return (
    <div className="flex h-full -m-6">
      <ConversationListPanel
        conversations={conversations}
        activeId={activeId}
        orgId={orgId || ''}
        onSelect={setActiveId}
        onNewConversation={() => setWizardState({ step: 'agent', selectedInstallation: null, contextChoice: null, selectedDocumentIds: [] })}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {wizardState ? (
          <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
            <NewConversationWizard
              installations={installations}
              orgId={orgId || ''}
              onComplete={handleWizardComplete}
              onCancel={() => setWizardState(null)}
            />
          </div>
        ) : activeConversation ? (
          <ChatInterface
            conversation={activeConversation}
            orgId={orgId || ''}
            userId={userId}
            onUpdate={handleConversationUpdate}
            onNew={() => setWizardState({ step: 'agent', selectedInstallation: null, contextChoice: null, selectedDocumentIds: [] })}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <MessageSquare className="w-16 h-16 text-slate-300 mb-4" />
            <h2 className="text-xl font-semibold text-slate-700 mb-2">No Conversation Selected</h2>
            <p className="text-sm text-slate-500 mb-6">Start a new conversation to get the ball rolling.</p>
            <button
              onClick={() => setWizardState({ step: 'agent', selectedInstallation: null, contextChoice: null, selectedDocumentIds: [] })}
              className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 text-sm font-medium"
            >
              <Plus className="w-4 h-4 inline mr-2" />
              New Conversation
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
