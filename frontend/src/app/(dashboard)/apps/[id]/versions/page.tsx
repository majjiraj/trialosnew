'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, GitBranch, CheckCircle, Archive } from 'lucide-react'

interface AppVersion {
  id: string
  appId: string
  version: string
  status: string
  changeType: string
  changeReason: string
  changedBy?: string
  createdAt: string
}

function VersionHistoryContent() {
  const params = useParams()
  const appId = params.id as string
  const [versions, setVersions] = useState<AppVersion[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!appId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($appId: ID!) { appVersions(appId: $appId) { id appId version status changeType changeReason changedBy createdAt } }`,
        variables: { appId },
      }),
    }).then(r => r.json()).then(d => setVersions(d.data?.appVersions || []))
      .catch(console.error).finally(() => setLoading(false))
  }, [appId])

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/apps/${appId}`} className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <h1 className="text-xl font-bold text-slate-900">Version History</h1>
      </div>

      {loading ? (
        <div className="text-slate-400">Loading versions...</div>
      ) : versions.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <GitBranch className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No versions created yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {versions.map(v => (
            <div key={v.id} className={`bg-white border rounded-xl p-4 ${v.status === 'active' ? 'border-brand-200 bg-brand-50/30' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {v.status === 'active' ? <CheckCircle className="w-5 h-5 text-green-500" /> :
                   v.status === 'archived' ? <Archive className="w-5 h-5 text-slate-300" /> :
                   <GitBranch className="w-5 h-5 text-blue-400" />}
                  <div>
                    <p className="font-semibold text-slate-900">v{v.version}</p>
                    <p className="text-xs text-slate-400">{v.changeType} · {new Date(v.createdAt).toLocaleString()}</p>
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                  v.status === 'active' ? 'bg-green-100 text-green-700' :
                  v.status === 'archived' ? 'bg-slate-100 text-slate-500' :
                  'bg-blue-100 text-blue-700'
                }`}>{v.status}</span>
              </div>
              {v.changeReason && <p className="text-sm text-slate-600 mt-2 ml-8">{v.changeReason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AppVersionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <VersionHistoryContent />
    </Suspense>
  )
}
