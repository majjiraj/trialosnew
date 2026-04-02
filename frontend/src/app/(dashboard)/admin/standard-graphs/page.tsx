'use client'
import { useEffect, useState, useCallback } from 'react'
import { BookOpen, Plus, CheckCircle, X, Loader2, RefreshCw, Globe, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/components/layout/AuthContext'
import { useRouter } from 'next/navigation'
import { clsx } from 'clsx'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const PLATFORM_ORG_ID = '00000000-0000-0000-0000-000000000000'

interface Graph {
  id: string
  name: string
  description: string | null
  document_ids: string[]
  is_published: boolean
  published_at: string | null
  created_at: string
}

interface Doc {
  id: string
  name: string
  document_type: string
  status: string
}

export default function StandardGraphsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [docs, setDocs] = useState<Doc[]>([])
  const [fetching, setFetching] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', document_ids: [] as string[] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!loading && !user?.is_platform_admin) router.push('/')
  }, [user, loading, router])

  const load = useCallback(async () => {
    setFetching(true)
    try {
      const [gr, dc] = await Promise.all([
        fetch(`${CONTEXT_GRAPH_URL}/standard-graphs`).then(r => r.json()),
        fetch(`${INGESTION_URL}/documents?org_id=${PLATFORM_ORG_ID}`).then(r => r.json()),
      ])
      setGraphs(gr.graphs || [])
      setDocs(dc.documents || [])
    } catch {
      // services may not be running
    } finally {
      setFetching(false)
    }
  }, [])

  useEffect(() => { if (user?.is_platform_admin) load() }, [user, load])

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      const r = await fetch(`${CONTEXT_GRAPH_URL}/standard-graphs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success('Standard graph created')
      setShowModal(false)
      setForm({ name: '', description: '', document_ids: [] })
      load()
    } catch {
      toast.error('Failed to create graph')
    } finally {
      setSaving(false)
    }
  }

  const togglePublish = async (graph: Graph) => {
    setToggling(graph.id)
    try {
      const r = await fetch(`${CONTEXT_GRAPH_URL}/standard-graphs/${graph.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_published: !graph.is_published }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success(graph.is_published ? 'Graph unpublished' : 'Graph published')
      setGraphs(gs => gs.map(g => g.id === graph.id ? { ...g, is_published: !g.is_published } : g))
    } catch {
      toast.error('Failed to update graph')
    } finally {
      setToggling(null)
    }
  }

  const toggleDoc = (id: string) =>
    setForm(f => ({
      ...f,
      document_ids: f.document_ids.includes(id)
        ? f.document_ids.filter(d => d !== id)
        : [...f.document_ids, id],
    }))

  if (loading || !user?.is_platform_admin) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Standard Graphs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Published graphs are visible to all tenants via context queries
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />New Graph
          </button>
        </div>
      </div>

      <div className="card">
        {fetching ? (
          <div className="px-5 py-10 flex items-center justify-center gap-2 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />Loading…
          </div>
        ) : graphs.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <BookOpen className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No standard graphs yet. Create one to share with tenants.</p>
          </div>
        ) : graphs.map(graph => (
          <div key={graph.id}
            className="px-5 py-4 flex items-center gap-4 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
            <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <BookOpen className="w-4 h-4 text-purple-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900">{graph.name}</span>
                {graph.is_published && (
                  <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full">
                    <Globe className="w-3 h-3" />Published
                  </span>
                )}
              </div>
              {graph.description && (
                <p className="text-xs text-slate-500 mt-0.5 truncate">{graph.description}</p>
              )}
              <p className="text-xs text-slate-400 mt-0.5">
                {graph.document_ids.length} document{graph.document_ids.length !== 1 ? 's' : ''}
                {' · '}Created {new Date(graph.created_at).toLocaleDateString()}
              </p>
            </div>
            <button
              onClick={() => togglePublish(graph)}
              disabled={toggling === graph.id}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                graph.is_published
                  ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  : 'border-green-200 text-green-600 hover:bg-green-50'
              )}
            >
              {toggling === graph.id
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : graph.is_published
                  ? <><EyeOff className="w-3 h-3" />Unpublish</>
                  : <><Globe className="w-3 h-3" />Publish</>}
            </button>
          </div>
        ))}
      </div>

      {/* New Graph Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">New Standard Graph</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. SDTM Implementation Guide v3.4"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Description (optional)</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Brief description of what this graph covers"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Documents (platform library)
                  <span className="text-slate-400 font-normal ml-1">— select one or more</span>
                </label>
                <div className="border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                  {docs.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-400">
                      No documents uploaded as platform admin yet.
                      Upload documents in the Document Library first.
                    </p>
                  ) : docs.map(doc => (
                    <label key={doc.id}
                      className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0">
                      <input
                        type="checkbox"
                        checked={form.document_ids.includes(doc.id)}
                        onChange={() => toggleDoc(doc.id)}
                        className="rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                      />
                      <div className="min-w-0">
                        <p className="text-sm text-slate-800 truncate">{doc.name}</p>
                        <p className="text-xs text-slate-400">{doc.document_type} · {doc.status}</p>
                      </div>
                      {form.document_ids.includes(doc.id) && (
                        <CheckCircle className="w-3.5 h-3.5 text-brand-500 flex-shrink-0 ml-auto" />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create Graph
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
