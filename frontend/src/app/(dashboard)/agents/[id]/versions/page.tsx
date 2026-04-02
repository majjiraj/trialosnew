'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Clock, CheckCircle, Archive, GitBranch, Loader2, AlertCircle } from 'lucide-react'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
import { clsx } from 'clsx'

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const STATUS_CONFIG = {
  active:   { label: 'Active',    color: 'bg-green-100 text-green-700', icon: CheckCircle },
  draft:    { label: 'Draft',     color: 'bg-amber-100 text-amber-700', icon: Clock },
  archived: { label: 'Archived',  color: 'bg-slate-100 text-slate-500', icon: Archive },
}

const CHANGE_TYPE_CONFIG = {
  major: { label: 'Major', color: 'bg-purple-100 text-purple-700' },
  minor: { label: 'Minor', color: 'bg-blue-100 text-blue-700' },
}

export default function VersionHistoryPage() {
  const params  = useParams()
  const router  = useRouter()
  const agentId = params.id as string
  const orgId   = useOrgId()
  const { user } = useAuth()

  const [versions, setVersions]     = useState<any[]>([])
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState<string[]>([])
  const [activating, setActivating] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${MARKETPLACE_URL}/agents/${agentId}/versions`)
      .then(r => r.json())
      .then(d => setVersions(d.versions || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [agentId])

  function toggleSelect(version: string) {
    setSelected(prev =>
      prev.includes(version)
        ? prev.filter(v => v !== version)
        : prev.length < 2 ? [...prev, version] : [prev[1], version]
    )
  }

  async function activateVersion(version: string) {
    setActivating(version)
    try {
      const res = await fetch(`${MARKETPLACE_URL}/agents/${agentId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          version,
          activated_by: user?.id || '',
        }),
      })
      if (!res.ok) throw new Error('Activation failed')
      // Optimistic update
      setVersions(prev => prev.map(v => ({
        ...v,
        status: v.version === version ? 'active'
               : v.status === 'active' ? 'archived'
               : v.status,
      })))
    } catch (e) {
      console.error(e)
    } finally {
      setActivating(null)
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => router.back()} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ArrowLeft className="w-4 h-4 text-slate-500" />
        </button>
        <GitBranch className="w-5 h-5 text-brand-500" />
        <h1 className="text-xl font-bold text-slate-900">Version History</h1>
      </div>

      {selected.length === 2 && (
        <div className="mb-4 flex items-center gap-3 p-3 bg-brand-50 border border-brand-200 rounded-xl">
          <span className="text-sm text-brand-700 font-medium">
            Compare <span className="font-mono">v{selected[0]}</span> vs <span className="font-mono">v{selected[1]}</span>
          </span>
          <button
            onClick={() => router.push(`/agents/${agentId}/versions/compare?v1=${selected[0]}&v2=${selected[1]}`)}
            className="ml-auto px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Compare →
          </button>
          <button onClick={() => setSelected([])} className="text-brand-500 hover:text-brand-700 text-xs">
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading versions…
        </div>
      ) : versions.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
          <p>No version history yet. Edit the agent to create a version.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {versions.map(v => {
            const sc = STATUS_CONFIG[v.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.draft
            const cc = CHANGE_TYPE_CONFIG[v.change_type as keyof typeof CHANGE_TYPE_CONFIG] || CHANGE_TYPE_CONFIG.minor
            const StatusIcon = sc.icon
            const isSelected = selected.includes(v.version)

            return (
              <div key={v.id}
                className={clsx('bg-white rounded-xl border p-4 flex items-start gap-3 transition-all', {
                  'border-brand-300 shadow-sm': isSelected,
                  'border-slate-200': !isSelected,
                })}>
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(v.version)}
                  className="mt-1 rounded border-slate-300 text-brand-500 cursor-pointer"
                  title="Select to compare"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-bold text-slate-900">v{v.version}</span>
                    <span className={clsx('flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium', sc.color)}>
                      <StatusIcon className="w-3 h-3" /> {sc.label}
                    </span>
                    <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium', cc.color)}>
                      {cc.label}
                    </span>
                  </div>
                  {v.change_reason && (
                    <p className="text-sm text-slate-600 mt-1">{v.change_reason}</p>
                  )}
                  <p className="text-xs text-slate-400 mt-1">
                    {v.changed_by_name || v.changed_by_email || 'Unknown'} · {timeAgo(v.created_at)}
                  </p>
                </div>

                {v.status === 'draft' && (
                  <button
                    onClick={() => activateVersion(v.version)}
                    disabled={activating === v.version}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
                  >
                    {activating === v.version ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    Activate
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {selected.length === 1 && (
        <p className="text-xs text-slate-400 text-center mt-3">Select one more version to compare</p>
      )}
    </div>
  )
}
