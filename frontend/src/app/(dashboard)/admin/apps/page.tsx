'use client'
import { useState, useEffect, Suspense } from 'react'
import { CheckCircle, XCircle, Eye } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

interface AppDef {
  id: string
  name: string
  slug: string
  description?: string
  category: string
  version: string
  status: string
  orgId: string
  createdAt: string
}

function AdminAppsContent() {
  const { user } = useAuth()
  const [apps, setApps] = useState<AppDef[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.is_platform_admin) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ apps(orgId: "00000000-0000-0000-0000-000000000000", status: "under_review") { id name slug description category version status orgId createdAt } }`,
      }),
    }).then(r => r.json()).then(d => setApps(d.data?.apps || []))
      .catch(console.error).finally(() => setLoading(false))
  }, [user])

  const handlePublish = async (appId: string) => {
    setPublishing(appId)
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
    try {
      await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation($appId: ID!) { publishApp(appId: $appId) { id status isPublished } }`,
          variables: { appId },
        }),
      })
      setApps(a => a.filter(app => app.id !== appId))
    } catch (err) {
      console.error(err)
    } finally {
      setPublishing(null)
    }
  }

  if (!user?.is_platform_admin) return <div className="p-6 text-red-500">Access denied. Platform admin required.</div>

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">App Reviews</h1>
        <p className="text-slate-500 text-sm mt-1">Review and publish app submissions from tenant organizations</p>
      </div>

      {loading ? (
        <div className="text-slate-400">Loading submissions...</div>
      ) : apps.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No pending reviews</p>
          <p className="text-sm mt-1">All app submissions have been processed</p>
        </div>
      ) : (
        <div className="space-y-4">
          {apps.map(app => (
            <div key={app.id} className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-slate-900">{app.name}</h3>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs font-medium">Under Review</span>
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">{app.category}</span>
                  </div>
                  <p className="text-xs text-slate-400 mb-2">v{app.version} · Org: {app.orgId}</p>
                  {app.description && <p className="text-sm text-slate-600">{app.description}</p>}
                  <p className="text-xs text-slate-300 mt-2">Submitted: {new Date(app.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="flex gap-2 ml-4">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50">
                    <Eye className="w-3.5 h-3.5" />Review
                  </button>
                  <button onClick={() => handlePublish(app.id)} disabled={publishing === app.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 disabled:opacity-60">
                    <CheckCircle className="w-3.5 h-3.5" />{publishing === app.id ? 'Publishing...' : 'Publish'}
                  </button>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-xs hover:bg-red-100">
                    <XCircle className="w-3.5 h-3.5" />Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AdminAppsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <AdminAppsContent />
    </Suspense>
  )
}
