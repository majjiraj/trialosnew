'use client'
import { useRef, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { MessageSquare, X, RefreshCw, MoreHorizontal } from 'lucide-react'
import ChartChat from './ChartChat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ReactECharts = dynamic<any>(() => import('echarts-for-react'), { ssr: false })

interface Widget {
  id: string
  name: string
  chartType: string
  echartsConfig: any
  dataSource?: any
}

interface Props {
  widget: Widget
  orgId: string
  height?: number
  onEdit?: () => void
  onRemove?: () => void
}

export default function EChartsWidget({ widget, orgId, height = 320, onEdit, onRemove }: Props) {
  const echartsRef = useRef<any>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [options, setOptions] = useState<any>(widget.echartsConfig || {})

  const handleOptionPatch = useCallback((patch: any) => {
    if (!patch || !Object.keys(patch).length) return
    setOptions((prev: any) => {
      // Deep-merge the patch into current options
      const merged = { ...prev }
      if (patch.series && Array.isArray(patch.series)) {
        const base = Array.isArray(merged.series) ? merged.series : [{}]
        merged.series = base.map((s: any, i: number) => {
          const p = patch.series[i] || patch.series[0] || {}
          const out = { ...s }
          if (p.markArea) out.markArea = p.markArea
          if (p.markLine) out.markLine = p.markLine
          if (p.markPoint) out.markPoint = p.markPoint
          return out
        })
      }
      return merged
    })
  }, [])

  const clearHighlights = useCallback(() => {
    setOptions((prev: any) => {
      if (!Array.isArray(prev.series)) return prev
      return {
        ...prev,
        series: prev.series.map((s: any) => {
          const { markArea, markLine, markPoint, ...rest } = s
          return rest
        }),
      }
    })
  }, [])

  const chartHeight = chatOpen ? Math.max(height * 0.55, 180) : height

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-slate-700 truncate">{widget.name}</span>
          <span className="text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded font-medium capitalize flex-shrink-0">
            {widget.chartType}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setChatOpen(o => !o)}
            title="Chat with AI agent"
            className={`p-1 rounded hover:bg-slate-100 transition-colors ${chatOpen ? 'text-brand-600 bg-brand-50' : 'text-slate-400'}`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          <div className="relative">
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="p-1 rounded hover:bg-slate-100 text-slate-400"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-6 bg-white border border-slate-200 rounded-lg shadow-lg z-20 min-w-[130px]">
                <button onClick={() => { clearHighlights(); setMenuOpen(false) }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 text-slate-600">
                  <RefreshCw className="w-3 h-3" /> Clear highlights
                </button>
                {onEdit && (
                  <button onClick={() => { onEdit(); setMenuOpen(false) }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 text-slate-600">
                    Edit widget
                  </button>
                )}
                {onRemove && (
                  <button onClick={() => { onRemove(); setMenuOpen(false) }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 text-red-500">
                    Remove from dashboard
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-shrink-0" style={{ height: chartHeight }}>
        <ReactECharts
          ref={echartsRef}
          option={options}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={false}
        />
      </div>

      {/* Chat panel */}
      {chatOpen && (
        <div className="flex flex-col flex-1 min-h-0 border-t border-slate-100">
          <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 flex-shrink-0">
            <span className="text-[11px] font-medium text-slate-500">AI Chart Assistant</span>
            <button onClick={() => setChatOpen(false)} className="text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <ChartChat widgetId={widget.id} orgId={orgId} onOptionPatch={handleOptionPatch} />
          </div>
        </div>
      )}
    </div>
  )
}
