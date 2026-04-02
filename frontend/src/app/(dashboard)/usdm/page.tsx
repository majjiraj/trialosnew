'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/layout/AuthContext'
import { FileText, Plus, Clock, CheckCircle, XCircle, AlertCircle, Loader2, ChevronRight, BookOpen, History, Brain, UserCheck, Download } from 'lucide-react'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID || '00000000-0000-0000-0000-000000000000'

async function gql(query: string, variables?: any) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

const STATUS_STYLES: Record<string, { icon: any; label: string; cls: string }> = {
  selecting_document: { icon: UserCheck,    label: 'Select Document',  cls: 'bg-brand-50 text-brand-600' },
  pending:            { icon: Clock,        label: 'Pending',          cls: 'bg-slate-100 text-slate-600' },
  running:            { icon: Loader2,      label: 'Running',          cls: 'bg-blue-50 text-blue-600' },
  waiting_approval:   { icon: AlertCircle,  label: 'Awaiting Review',  cls: 'bg-amber-50 text-amber-600' },
  approved:           { icon: CheckCircle,  label: 'Approved',         cls: 'bg-green-50 text-green-600' },
  completed:          { icon: CheckCircle,  label: 'Completed',        cls: 'bg-green-50 text-green-600' },
  rejected:           { icon: XCircle,      label: 'Rejected',         cls: 'bg-red-50 text-red-600' },
  failed:             { icon: XCircle,      label: 'Failed',           cls: 'bg-red-50 text-red-600' },
}

export default function UsdmListPage() {
  const router = useRouter()
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID
  const [conversions, setConversions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [convName, setConvName] = useState('')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => { load() }, [orgId])

  async function load() {
    setLoading(true)
    try {
      const data = await gql(
        `query($orgId: String!) { usdmConversions(orgId: $orgId) { id name status protocolFilename createdAt updatedAt approvalId runId } }`,
        { orgId }
      )
      setConversions(data.usdmConversions || [])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  async function createDraft() {
    if (!convName.trim()) return
    setCreating(true)
    try {
      const data = await gql(`
        mutation($orgId: String!, $name: String!, $createdBy: String) {
          createUsdmDraft(orgId: $orgId, name: $name, createdBy: $createdBy) { id }
        }
      `, { orgId, name: convName.trim(), createdBy: user?.id })
      setShowNew(false)
      setConvName('')
      router.push(`/usdm/${data.createUsdmDraft.id}`)
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setCreating(false)
    }
  }

  function showToast(msg: string) {
    setToast(msg); setTimeout(() => setToast(''), 3000)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Protocol → USDM v4 Converter</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            AI converts protocol documents to USDM v4 JSON using the USDM IG knowledge graph and past conversions
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          <Plus className="w-4 h-4" /> New Conversion
        </button>
      </div>

      {/* Pipeline steps overview */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Agent Pipeline</p>
        <div className="flex items-center gap-1 flex-wrap">
          {[
            { icon: UserCheck, label: 'Select Protocol',  sub: 'You',                color: 'text-brand-500 bg-brand-50 border-brand-200' },
            { icon: FileText,  label: 'Extract Text',     sub: 'Agent',              color: 'text-slate-600 bg-slate-50 border-slate-200' },
            { icon: BookOpen,  label: 'USDM IG',          sub: 'Knowledge graph',    color: 'text-slate-600 bg-slate-50 border-slate-200' },
            { icon: History,   label: 'Past Conversions', sub: 'Few-shot examples',  color: 'text-slate-600 bg-slate-50 border-slate-200' },
            { icon: Brain,     label: 'Generate USDM',    sub: 'LLM',               color: 'text-slate-600 bg-slate-50 border-slate-200' },
            { icon: UserCheck, label: 'Review & Approve', sub: 'You',                color: 'text-amber-600 bg-amber-50 border-amber-200' },
            { icon: Download,  label: 'Download JSON',    sub: 'Artifact',           color: 'text-green-600 bg-green-50 border-green-200' },
          ].map((step, i, arr) => (
            <div key={i} className="flex items-center gap-1">
              <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium ${step.color}`}>
                <step.icon className="w-3.5 h-3.5" />
                <div>
                  <div>{step.label}</div>
                  <div className="text-xs opacity-60 font-normal">{step.sub}</div>
                </div>
              </div>
              {i < arr.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />}
            </div>
          ))}
        </div>
      </div>

      {/* Conversion list */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />Loading…
        </div>
      ) : conversions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-slate-400 border-2 border-dashed border-slate-200 rounded-2xl">
          <FileText className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm font-medium">No conversions yet</p>
          <button onClick={() => setShowNew(true)} className="mt-3 text-sm text-brand-500 hover:text-brand-700 font-medium">
            Start your first conversion →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {conversions.map(c => {
            const s = STATUS_STYLES[c.status] || STATUS_STYLES.pending
            const Icon = s.icon
            const needsDoc = c.status === 'selecting_document'
            const isReviewable = c.status === 'waiting_approval' && c.approvalId
            return (
              <div
                key={c.id}
                onClick={() => router.push(`/usdm/${c.id}`)}
                className="flex items-center gap-4 p-4 bg-white border border-slate-200 rounded-xl hover:border-brand-300 hover:bg-brand-50/30 cursor-pointer transition-colors group"
              >
                <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-brand-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                  <p className="text-xs text-slate-400 truncate mt-0.5">
                    {c.protocolFilename || 'No document selected yet'}
                  </p>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.cls}`}>
                  <Icon className={`w-3.5 h-3.5 ${c.status === 'running' ? 'animate-spin' : ''}`} />
                  {s.label}
                </div>
                {needsDoc && (
                  <span className="text-xs bg-brand-500 text-white px-2 py-0.5 rounded-full font-medium">
                    Action needed
                  </span>
                )}
                {isReviewable && (
                  <span className="text-xs bg-amber-500 text-white px-2 py-0.5 rounded-full font-medium">
                    Review needed
                  </span>
                )}
                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-brand-500 flex-shrink-0" />
              </div>
            )
          })}
        </div>
      )}

      {/* New conversion modal — name only */}
      {showNew && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h3 className="font-semibold text-slate-800">New USDM Conversion</h3>
                <p className="text-xs text-slate-500 mt-0.5">Give it a name — you'll choose the protocol document next</p>
              </div>
              <button onClick={() => setShowNew(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-medium text-slate-700 mb-1">Conversion Name</label>
              <input
                value={convName}
                onChange={e => setConvName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createDraft()}
                placeholder="e.g. TRIAL-001 Phase 3 Protocol"
                autoFocus
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
              <p className="text-xs text-slate-400 mt-2">
                Next step: select an existing uploaded document or upload a new protocol file.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
                Cancel
              </button>
              <button
                onClick={createDraft}
                disabled={!convName.trim() || creating}
                className="flex items-center gap-2 px-5 py-2 text-sm bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-40 transition-colors"
              >
                {creating ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</> : <><ChevronRight className="w-4 h-4" />Continue</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-slate-800 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
