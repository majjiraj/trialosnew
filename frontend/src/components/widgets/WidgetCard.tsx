'use client'
import dynamic from 'next/dynamic'
import { LayoutDashboard, Edit2, Trash2, BarChart2, TrendingUp, PieChart, Activity } from 'lucide-react'

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false })

const CHART_ICONS: Record<string, React.ElementType> = {
  line: TrendingUp,
  area: Activity,
  bar: BarChart2,
  pie: PieChart,
  scatter: Activity,
  heatmap: BarChart2,
}

interface Widget {
  id: string
  name: string
  description?: string
  chartType: string
  echartsConfig: any
  updatedAt?: string
}

interface Props {
  widget: Widget
  onEdit: () => void
  onDelete: () => void
  onAddToDashboard: () => void
}

export default function WidgetCard({ widget, onEdit, onDelete, onAddToDashboard }: Props) {
  const Icon = CHART_ICONS[widget.chartType] || BarChart2
  const updated = widget.updatedAt
    ? new Date(widget.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : ''

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow group flex flex-col">
      {/* Chart preview */}
      <div className="h-40 bg-slate-50 relative">
        {widget.echartsConfig && Object.keys(widget.echartsConfig).length > 0 ? (
          <ReactECharts
            option={widget.echartsConfig}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <Icon className="w-10 h-10 text-slate-200" />
          </div>
        )}
        {/* hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />
      </div>

      {/* Footer */}
      <div className="p-3 flex flex-col gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800 truncate flex-1">{widget.name}</span>
            <span className="text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded capitalize flex-shrink-0">
              {widget.chartType}
            </span>
          </div>
          {widget.description && (
            <p className="text-xs text-slate-400 truncate mt-0.5">{widget.description}</p>
          )}
          {updated && <p className="text-[10px] text-slate-300 mt-0.5">Updated {updated}</p>}
        </div>

        <div className="flex items-center gap-1.5 pt-1 border-t border-slate-100">
          <button
            onClick={onAddToDashboard}
            className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-brand-500 text-white py-1.5 rounded-lg hover:bg-brand-600 transition-colors font-medium"
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            Add to Dashboard
          </button>
          <button onClick={onEdit}
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete}
            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
