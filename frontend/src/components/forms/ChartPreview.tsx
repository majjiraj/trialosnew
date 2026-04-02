'use client'
import dynamic from 'next/dynamic'
import { BarChart2 } from 'lucide-react'

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false })

interface DataPoint {
  label: string
  value: number
}

interface ChartPreviewProps {
  chartType: 'bar' | 'line' | 'pie' | 'scatter'
  data: DataPoint[] | null
  title?: string
  loading?: boolean
  error?: string
  height?: number
}

function buildOption(chartType: string, data: DataPoint[], title?: string) {
  const labels = data.map(d => d.label)
  const values = data.map(d => d.value)

  if (chartType === 'pie') {
    return {
      title: title ? { text: title, textStyle: { fontSize: 13 } } : undefined,
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: '65%',
        data: data.map(d => ({ name: d.label, value: d.value })),
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' } },
      }],
    }
  }

  if (chartType === 'scatter') {
    return {
      title: title ? { text: title, textStyle: { fontSize: 13 } } : undefined,
      tooltip: { trigger: 'item' },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value' },
      series: [{ type: 'scatter', data: values, symbolSize: 10 }],
    }
  }

  return {
    title: title ? { text: title, textStyle: { fontSize: 13 } } : undefined,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value' },
    series: [{ type: chartType === 'line' ? 'line' : 'bar', data: values, smooth: chartType === 'line' }],
  }
}

export default function ChartPreview({ chartType, data, title, loading, error, height = 220 }: ChartPreviewProps) {
  if (loading) {
    return (
      <div style={{ height }} className="flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200">
        <div className="text-center text-slate-400">
          <div className="animate-spin w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full mx-auto mb-2" />
          <p className="text-xs">Loading data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ height }} className="flex items-center justify-center bg-red-50 rounded-lg border border-red-200 p-4">
        <p className="text-xs text-red-600 text-center">{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ height }} className="flex items-center justify-center bg-slate-50 rounded-lg border border-dashed border-slate-300">
        <div className="text-center text-slate-400">
          <BarChart2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-xs">Preview available at fill time</p>
        </div>
      </div>
    )
  }

  const option = buildOption(chartType, data, title)

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <ReactECharts option={option} style={{ height }} />
    </div>
  )
}
