'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { Plus, LayoutDashboard, X, ChevronDown, BarChart2, Settings } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'
import EChartsWidget from '@/components/widgets/EChartsWidget'

// react-grid-layout loaded client-side only
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GridLayout = dynamic<any>(
  () => import('react-grid-layout').then(m => m.default as any),
  { ssr: false }
)

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

interface Placement {
  id: string
  widgetId: string
  widget: any
  posX: number
  posY: number
  width: number
  height: number
}

interface Dashboard {
  id: string
  name: string
  placements: Placement[]
}

export default function DashboardPage() {
  const router = useRouter()
  const { user } = useAuth()
  const orgId = (user as any)?.orgId || ORG_ID

  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [activeDashboard, setActiveDashboard] = useState<Dashboard | null>(null)
  const [allWidgets, setAllWidgets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showWidgetPicker, setShowWidgetPicker] = useState(false)
  const [showDashboardMenu, setShowDashboardMenu] = useState(false)
  const [gridCols] = useState(12)
  const [rowHeight] = useState(80)
  const [toast, setToast] = useState('')

  useEffect(() => { init() }, [orgId])

  async function init() {
    setLoading(true)
    try {
      const data = await gql(`
        query($orgId: String!) {
          dashboards(orgId: $orgId) {
            id name
            placements {
              id widgetId posX posY width height
              widget { id name chartType echartsConfig description }
            }
          }
          widgets(orgId: $orgId) { id name chartType echartsConfig description }
        }
      `, { orgId })

      const dbs: Dashboard[] = data.dashboards || []
      setDashboards(dbs)
      setAllWidgets(data.widgets || [])

      if (dbs.length > 0) {
        // Load full dashboard with placements
        await loadDashboard(dbs[0].id)
      } else {
        // Create default dashboard
        const res = await gql(`
          mutation($orgId: String!, $name: String!, $createdBy: String) {
            createDashboard(orgId: $orgId, name: $name, createdBy: $createdBy) { id name }
          }
        `, { orgId, name: 'My Dashboard', createdBy: user?.id })
        const newDb: Dashboard = { ...res.createDashboard, placements: [] }
        setDashboards([newDb])
        setActiveDashboard(newDb)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function loadDashboard(id: string) {
    const data = await gql(`
      query($id: ID!) {
        dashboard(id: $id) {
          id name
          placements {
            id widgetId posX posY width height
            widget { id name chartType echartsConfig description }
          }
        }
      }
    `, { id })
    setActiveDashboard(data.dashboard)
  }

  async function addWidget(widgetId: string) {
    if (!activeDashboard) return
    // Find next available Y position
    const maxY = activeDashboard.placements.reduce((m, p) => Math.max(m, p.posY + p.height), 0)
    const data = await gql(`
      mutation($dashboardId: ID!, $widgetId: ID!, $posX: Int, $posY: Int, $width: Int, $height: Int) {
        addWidgetToDashboard(dashboardId: $dashboardId, widgetId: $widgetId, posX: $posX, posY: $posY, width: $width, height: $height) {
          id widgetId posX posY width height
        }
      }
    `, { dashboardId: activeDashboard.id, widgetId, posX: 0, posY: maxY, width: 6, height: 4 })
    const placement = data.addWidgetToDashboard
    const widget = allWidgets.find(w => w.id === widgetId)
    setActiveDashboard(prev => prev ? {
      ...prev,
      placements: [...prev.placements, { ...placement, widget }]
    } : prev)
    setShowWidgetPicker(false)
    showToastMsg('Widget added')
  }

  async function removeWidget(placementId: string) {
    await gql(`mutation($id: ID!) { removeWidgetFromDashboard(placementId: $id) }`, { id: placementId })
    setActiveDashboard(prev => prev ? {
      ...prev,
      placements: prev.placements.filter(p => p.id !== placementId)
    } : prev)
    showToastMsg('Widget removed')
  }

  const handleLayoutChange = useCallback((layout: any[]) => {
    if (!activeDashboard) return
    const placements = layout.map(item => ({
      id: item.i,
      widgetId: activeDashboard.placements.find(p => p.id === item.i)?.widgetId || '',
      posX: item.x,
      posY: item.y,
      width: item.w,
      height: item.h,
    }))
    // Optimistic update
    setActiveDashboard(prev => prev ? {
      ...prev,
      placements: prev.placements.map(p => {
        const updated = placements.find(u => u.id === p.id)
        return updated ? { ...p, posX: updated.posX, posY: updated.posY, width: updated.width, height: updated.height } : p
      })
    } : prev)
    gql(`
      mutation($dashboardId: ID!, $placements: [PlacementInput!]!) {
        updateDashboardLayout(dashboardId: $dashboardId, placements: $placements)
      }
    `, { dashboardId: activeDashboard.id, placements }).catch(e => console.error('Layout save failed', e))
  }, [activeDashboard])

  async function createNewDashboard() {
    const name = prompt('Dashboard name:', 'New Dashboard')
    if (!name) return
    const data = await gql(`
      mutation($orgId: String!, $name: String!, $createdBy: String) {
        createDashboard(orgId: $orgId, name: $name, createdBy: $createdBy) { id name }
      }
    `, { orgId, name, createdBy: user?.id })
    const newDb: Dashboard = { ...data.createDashboard, placements: [] }
    setDashboards(prev => [...prev, newDb])
    setActiveDashboard(newDb)
    setShowDashboardMenu(false)
  }

  function showToastMsg(msg: string) {
    setToast(msg); setTimeout(() => setToast(''), 2500)
  }

  // Build react-grid-layout items
  const gridItems = (activeDashboard?.placements || []).map(p => ({
    i: p.id, x: p.posX, y: p.posY, w: p.width, h: p.height, minW: 3, minH: 3,
  }))

  const widgetPixelHeight = (h: number) => h * rowHeight - 12

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="w-5 h-5 text-brand-500" />
          {/* Dashboard selector */}
          <div className="relative">
            <button
              onClick={() => setShowDashboardMenu(o => !o)}
              className="flex items-center gap-1.5 text-xl font-bold text-slate-800 hover:text-brand-600 transition-colors"
            >
              {activeDashboard?.name || 'Dashboard'}
              <ChevronDown className="w-4 h-4 mt-0.5" />
            </button>
            {showDashboardMenu && (
              <div className="absolute top-8 left-0 bg-white border border-slate-200 rounded-xl shadow-lg z-20 min-w-[200px] overflow-hidden">
                {dashboards.map(d => (
                  <button key={d.id}
                    onClick={() => { loadDashboard(d.id); setShowDashboardMenu(false) }}
                    className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 ${d.id === activeDashboard?.id ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}>
                    {d.name}
                  </button>
                ))}
                <div className="border-t border-slate-100">
                  <button onClick={createNewDashboard}
                    className="w-full text-left px-4 py-2.5 text-sm text-slate-500 hover:bg-slate-50 flex items-center gap-2">
                    <Plus className="w-3.5 h-3.5" /> New dashboard
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => router.push('/widgets')}
            className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
            <BarChart2 className="w-4 h-4" /> Widget Library
          </button>
          <button onClick={() => setShowWidgetPicker(true)}
            className="flex items-center gap-1.5 text-sm bg-brand-500 text-white px-4 py-1.5 rounded-lg hover:bg-brand-600 transition-colors font-medium">
            <Plus className="w-4 h-4" /> Add Widget
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-slate-400">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-brand-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm">Loading dashboard…</p>
          </div>
        </div>
      ) : !activeDashboard?.placements?.length ? (
        <div className="flex flex-col items-center justify-center h-64 text-slate-400 border-2 border-dashed border-slate-200 rounded-2xl">
          <LayoutDashboard className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm font-medium">This dashboard is empty</p>
          <button onClick={() => setShowWidgetPicker(true)}
            className="mt-3 text-sm text-brand-500 hover:text-brand-700 font-medium flex items-center gap-1">
            <Plus className="w-4 h-4" /> Add your first widget
          </button>
        </div>
      ) : (
        <div className="relative">
          {/* react-grid-layout CSS is loaded via import below */}
          <style>{`
            .react-grid-item.react-grid-placeholder { background: #4361ee20; border-radius: 12px; }
            .react-grid-item > .react-resizable-handle { opacity: 0; transition: opacity 0.2s; }
            .react-grid-item:hover > .react-resizable-handle { opacity: 1; }
            .react-resizable-handle::after { border-color: #4361ee !important; }
          `}</style>
          <GridLayout
            className="layout"
            layout={gridItems}
            cols={gridCols}
            rowHeight={rowHeight}
            width={1200}
            onLayoutChange={handleLayoutChange}
            draggableHandle=".drag-handle"
            margin={[12, 12]}
            containerPadding={[0, 0]}
            resizeHandles={['se']}
          >
            {(activeDashboard?.placements || []).map(p => (
              <div key={p.id} className="group">
                {/* Drag handle — invisible bar at top */}
                <div className="drag-handle absolute top-0 left-0 right-0 h-8 cursor-grab active:cursor-grabbing z-10 rounded-t-xl" />
                <div style={{ height: widgetPixelHeight(p.height) }}>
                  <EChartsWidget
                    widget={p.widget || { id: p.widgetId, name: 'Widget', chartType: 'bar', echartsConfig: {} }}
                    orgId={orgId}
                    height={widgetPixelHeight(p.height)}
                    onEdit={() => router.push(`/widgets/${p.widgetId}`)}
                    onRemove={() => removeWidget(p.id)}
                  />
                </div>
              </div>
            ))}
          </GridLayout>
        </div>
      )}

      {/* Widget picker modal */}
      {showWidgetPicker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="font-semibold text-slate-800">Add Widget</h3>
                <p className="text-xs text-slate-500 mt-0.5">Choose a widget from your library</p>
              </div>
              <button onClick={() => setShowWidgetPicker(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {allWidgets.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <BarChart2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No widgets yet</p>
                  <button onClick={() => { setShowWidgetPicker(false); router.push('/widgets/new') }}
                    className="mt-2 text-sm text-brand-500 hover:text-brand-700 font-medium">Create a widget →</button>
                </div>
              ) : allWidgets.map(w => (
                <button key={w.id} onClick={() => addWidget(w.id)}
                  className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:border-brand-300 hover:bg-brand-50 transition-colors group">
                  <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <BarChart2 className="w-5 h-5 text-brand-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{w.name}</p>
                    <p className="text-xs text-slate-400 capitalize">{w.chartType} chart</p>
                  </div>
                  <Plus className="w-4 h-4 text-slate-300 group-hover:text-brand-500 ml-auto flex-shrink-0" />
                </button>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => { setShowWidgetPicker(false); router.push('/widgets/new') }}
                className="w-full py-2 text-sm text-brand-500 hover:text-brand-700 font-medium flex items-center justify-center gap-1.5">
                <Plus className="w-4 h-4" /> Create new widget
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
