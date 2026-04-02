'use client'
import { useState, useEffect, Suspense } from 'react'
import { Search, Download, Star } from 'lucide-react'
import { useOrgId } from '@/components/layout/AuthContext'

interface AppDef {
  id: string
  name: string
  slug: string
  description: string
  category: string
  version: string
  publisherOrgId: string
}

const CATEGORY_COLORS: Record<string, string> = {
  safety: 'bg-red-50 text-red-700',
  compliance: 'bg-yellow-50 text-yellow-700',
  'site-management': 'bg-blue-50 text-blue-700',
  clinical: 'bg-green-50 text-green-700',
  regulatory: 'bg-purple-50 text-purple-700',
}

function AppCard({ app, onInstall }: { app: AppDef; onInstall: (id: string) => void }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 bg-brand-100 rounded-lg flex items-center justify-center text-brand-600 font-bold text-lg">
          {app.name.charAt(0)}
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${CATEGORY_COLORS[app.category] || 'bg-slate-100 text-slate-600'}`}>
          {app.category}
        </span>
      </div>
      <h3 className="font-semibold text-slate-900 mb-1">{app.name}</h3>
      <p className="text-sm text-slate-500 mb-1">v{app.version}</p>
      <p className="text-sm text-slate-600 mb-4 line-clamp-3">{app.description}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-amber-400">
          {[1,2,3,4,5].map(i => <Star key={i} className="w-3.5 h-3.5 fill-current" />)}
          <span className="text-xs text-slate-400 ml-1">5.0</span>
        </div>
        <button
          onClick={() => onInstall(app.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 text-white rounded-lg text-xs font-medium hover:bg-brand-600"
        >
          <Download className="w-3.5 h-3.5" />Install
        </button>
      </div>
    </div>
  )
}

function MarketContent() {
  const orgId = useOrgId()
  const [apps, setApps] = useState<AppDef[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ appCatalog { id name slug description category version publisherOrgId } }` }),
    }).then(r => r.json()).then(d => setApps(d.data?.appCatalog || []))
      .catch(console.error).finally(() => setLoading(false))
  }, [])

  const handleInstall = async (appId: string) => {
    if (!orgId) return
    setInstalling(appId)
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    try {
      const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
      await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation($appId: ID!, $orgId: String!) {
            installApp(appId: $appId, orgId: $orgId, consentedPermissions: []) {
              id status
            }
          }`,
          variables: { appId, orgId },
        }),
      })
      alert('App installed successfully!')
    } catch {
      alert('Installation failed')
    } finally {
      setInstalling(null)
    }
  }

  const filtered = apps.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">App Marketplace</h1>
        <p className="text-slate-500 text-sm mt-1">Browse and install clinical trial workflow applications</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search apps..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {loading ? (
        <div className="text-slate-400">Loading marketplace...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p className="text-lg font-medium">No apps found</p>
          <p className="text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(app => (
            <div key={app.id} className={installing === app.id ? 'opacity-50 pointer-events-none' : ''}>
              <AppCard app={app} onInstall={handleInstall} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AppMarketPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <MarketContent />
    </Suspense>
  )
}
