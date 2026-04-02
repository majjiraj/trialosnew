'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { BarChart2, Plus, Search, TrendingUp, PieChart, Activity, Grid } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'
import WidgetCard from '@/components/widgets/WidgetCard'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID || '00000000-0000-0000-0000-000000000000'

async function gql(query: string, variables?: any) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

const CHART_TYPES = ['all', 'line', 'bar', 'pie', 'scatter', 'area', 'heatmap']

export default function WidgetsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [widgets, setWidgets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [dashboards, setDashboards] = useState<any[]>([])
  const [pickingDashboard, setPickingDashboard] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const orgId = (user as any)?.orgId || ORG_ID

  useEffect(() => { fetchWidgets() }, [orgId])

  async function fetchWidgets() {
    setLoading(true)
    try {
      const data = await gql(`
        query($orgId: String!) {
          widgets(orgId: $orgId) {
            id name description chartType echartsConfig updatedAt
          }
          dashboards(orgId: $orgId) { id name }
        }
      `, { orgId })
      setWidgets(data.widgets || [])
      setDashboards(data.dashboards || [])
    } catch (e: any) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function deleteWidget(id: string) {
    if (!confirm('Delete this widget?')) return
    await gql(`mutation($id: ID!) { deleteWidget(id: $id) }`, { id })
    setWidgets(prev => prev.filter(w => w.id !== id))
    showToast('Widget deleted')
  }

  async function addToDashboard(widgetId: string, dashboardId: string) {
    await gql(`
      mutation($dashboardId: ID!, $widgetId: ID!) {
        addWidgetToDashboard(dashboardId: $dashboardId, widgetId: $widgetId) { id }
      }
    `, { dashboardId, widgetId })
    setPickingDashboard(null)
    showToast('Widget added to dashboard')
  }

  async function createAndAddToDashboard(widgetId: string) {
    const name = prompt('New dashboard name:', 'My Dashboard')
    if (!name) return
    const data = await gql(`
      mutation($orgId: String!, $name: String!, $createdBy: String) {
        createDashboard(orgId: $orgId, name: $name, createdBy: $createdBy) { id }
      }
    `, { orgId, name, createdBy: user?.id })
    await addToDashboard(widgetId, data.createDashboard.id)
    setDashboards(prev => [...prev, { id: data.createDashboard.id, name }])
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  const filtered = widgets.filter(w => {
    const matchType = typeFilter === 'all' || w.chartType === typeFilter
    const matchSearch = !search || w.name.toLowerCase().includes(search.toLowerCase())
    return matchType && matchSearch
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Widget Library</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {widgets.length} chart widget{widgets.length !== 1 ? 's' : ''} · Add to your dashboards
          </p>
        </div>
        <button
          onClick={() => router.push('/widgets/new')}
          className="flex items-center gap-2 bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          <Plus className="w-4 h-4" /> Create Widget
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search widgets…"
            className="pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-300 w-56"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
          {CHART_TYPES.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors ${
                typeFilter === t ? 'bg-white shadow text-brand-600' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'all' ? 'All types' : t}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-60 bg-slate-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-slate-400">
          <BarChart2 className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm font-medium">
            {search || typeFilter !== 'all' ? 'No widgets match your filters' : 'No widgets yet'}
          </p>
          {!search && typeFilter === 'all' && (
            <button onClick={() => router.push('/widgets/new')}
              className="mt-3 text-sm text-brand-500 hover:text-brand-700 font-medium">
              Create your first widget →
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(w => (
            <WidgetCard
              key={w.id}
              widget={w}
              onEdit={() => router.push(`/widgets/${w.id}`)}
              onDelete={() => deleteWidget(w.id)}
              onAddToDashboard={() => setPickingDashboard(w.id)}
            />
          ))}
        </div>
      )}

      {/* Dashboard picker modal */}
      {pickingDashboard && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-80 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">Add to Dashboard</h3>
              <p className="text-xs text-slate-500 mt-0.5">Choose a dashboard or create a new one</p>
            </div>
            <div className="p-2 max-h-64 overflow-y-auto">
              {dashboards.map(d => (
                <button
                  key={d.id}
                  onClick={() => addToDashboard(pickingDashboard, d.id)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-brand-50 text-sm text-slate-700 flex items-center gap-2"
                >
                  <Grid className="w-4 h-4 text-brand-400" />
                  {d.name}
                </button>
              ))}
              <button
                onClick={() => createAndAddToDashboard(pickingDashboard)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 text-sm text-slate-500 flex items-center gap-2 border-t border-slate-100 mt-1 pt-2"
              >
                <Plus className="w-4 h-4" /> New dashboard…
              </button>
            </div>
            <div className="px-4 py-3 border-t border-slate-100">
              <button onClick={() => setPickingDashboard(null)}
                className="w-full py-2 text-sm text-slate-500 hover:text-slate-700">Cancel</button>
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
