'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { ChevronLeft, ChevronRight, Check, BarChart2, TrendingUp, PieChart, Activity, Layers, Grid3X3 } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false })

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'
const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
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

const CHART_TYPES = [
  { id: 'line', label: 'Line', Icon: TrendingUp, desc: 'Trends over time' },
  { id: 'bar', label: 'Bar', Icon: BarChart2, desc: 'Compare categories' },
  { id: 'area', label: 'Area', Icon: Activity, desc: 'Filled line chart' },
  { id: 'pie', label: 'Pie', Icon: PieChart, desc: 'Part-to-whole' },
  { id: 'scatter', label: 'Scatter', Icon: Layers, desc: 'Correlations' },
  { id: 'heatmap', label: 'Heatmap', Icon: Grid3X3, desc: 'Density / intensity' },
]

const BRAND_COLORS = ['#4361ee', '#3a86ff', '#8338ec', '#ff006e', '#fb5607', '#ffbe0b', '#06d6a0']

function buildEChartsOption(
  chartType: string,
  xData: any[],
  series: { name: string; data: any[] }[],
  title: string,
  xLabel: string,
  yLabel: string,
): any {
  if (chartType === 'pie') {
    const allData = series.flatMap(s =>
      s.data.map((v: any, i: number) => ({ name: xData[i] ?? `Item ${i + 1}`, value: v }))
    )
    return {
      title: title ? { text: title, textStyle: { fontSize: 13, fontWeight: 600 } } : undefined,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'horizontal', bottom: 0 },
      series: [{ type: 'pie', radius: ['40%', '70%'], data: allData,
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } } }],
      color: BRAND_COLORS,
    }
  }
  if (chartType === 'heatmap') {
    return {
      title: title ? { text: title, textStyle: { fontSize: 13, fontWeight: 600 } } : undefined,
      tooltip: { position: 'top' },
      grid: { top: title ? '60px' : '30px', bottom: '60px' },
      xAxis: { type: 'category', data: xData, name: xLabel },
      yAxis: { type: 'category', data: series.map(s => s.name), name: yLabel },
      visualMap: { min: 0, max: 100, calculable: true, orient: 'horizontal', left: 'center', bottom: '0%' },
      series: [{
        type: 'heatmap',
        data: series.flatMap((s, yi) => s.data.map((v: any, xi: number) => [xi, yi, v ?? 0])),
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
      }],
      color: BRAND_COLORS,
    }
  }
  return {
    title: title ? { text: title, textStyle: { fontSize: 13, fontWeight: 600 } } : undefined,
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { top: title ? 30 : 0 } : undefined,
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true, top: title ? '60px' : series.length > 1 ? '30px' : '20px' },
    xAxis: { type: 'category', data: xData, name: xLabel, nameLocation: 'end',
      axisLabel: { rotate: xData.length > 10 ? 30 : 0 } },
    yAxis: { type: 'value', name: yLabel, nameLocation: 'end' },
    series: series.map((s, i) => ({
      name: s.name,
      type: chartType === 'area' ? 'line' : chartType,
      data: s.data,
      smooth: chartType === 'line' || chartType === 'area',
      areaStyle: chartType === 'area' ? { opacity: 0.3 } : undefined,
      itemStyle: { color: BRAND_COLORS[i % BRAND_COLORS.length] },
      symbolSize: chartType === 'scatter' ? 8 : undefined,
    })),
    color: BRAND_COLORS,
  }
}

function extractColumns(cols: string[], dtypes: Record<string, string>) {
  const numeric = cols.filter(c => {
    const t = dtypes[c] || ''
    return t.includes('float') || t.includes('int') || t.includes('Int')
  })
  const categorical = cols.filter(c => !numeric.includes(c))
  return { numeric, categorical }
}

export default function WidgetEditorPage() {
  const router = useRouter()
  const params = useParams()
  const { user } = useAuth()
  const isNew = params.id === 'new'
  const orgId = (user as any)?.orgId || ORG_ID

  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [error, setError] = useState('')

  // Step 1 — Basics
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [chartType, setChartType] = useState('line')

  // Step 2 — Data source
  const [documents, setDocuments] = useState<any[]>([])
  const [selectedDoc, setSelectedDoc] = useState<any>(null)
  const [parsedCols, setParsedCols] = useState<string[]>([])
  const [dtypes, setDtypes] = useState<Record<string, string>>({})
  const [sampleRows, setSampleRows] = useState<any[]>([])
  const [xCol, setXCol] = useState('')
  const [yCols, setYCols] = useState<string[]>([])
  const [groupCol, setGroupCol] = useState('')

  // Step 3 — Config
  const [chartTitle, setChartTitle] = useState('')
  const [xLabel, setXLabel] = useState('')
  const [yLabel, setYLabel] = useState('')
  const [advancedJson, setAdvancedJson] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [previewOption, setPreviewOption] = useState<any>({})

  // Load existing widget
  useEffect(() => {
    if (!isNew) loadWidget()
    loadDocuments()
  }, [])

  async function loadWidget() {
    try {
      const data = await gql(`query($id: ID!) { widget(id: $id) {
        id name description chartType echartsConfig dataSource
      }}`, { id: params.id })
      const w = data.widget
      if (!w) return
      setName(w.name)
      setDescription(w.description || '')
      setChartType(w.chartType)
      setChartTitle(w.echartsConfig?.title?.text || '')
      setPreviewOption(w.echartsConfig || {})
      setAdvancedJson(JSON.stringify(w.echartsConfig, null, 2))
      if (w.dataSource) {
        setXCol(w.dataSource.x_col || '')
        setYCols(w.dataSource.y_cols || [])
        setGroupCol(w.dataSource.group_col || '')
      }
    } catch (e: any) { setError(e.message) }
  }

  async function loadDocuments() {
    try {
      const data = await gql(`query($orgId: String!) {
        documents(orgId: $orgId) { id name fileName documentType bronzeSkey: bronzeS3Key }
      }`, { orgId })
      // Filter to data files only
      const docs = (data.documents || []).filter((d: any) =>
        /\.(csv|xlsx|xls|xpt)$/i.test(d.fileName || d.name || '')
      )
      setDocuments(docs)
    } catch (e) {
      // fallback — fetch from ingestion
      try {
        const res = await fetch(`${INGESTION_URL}/documents?org_id=${orgId}`)
        const json = await res.json()
        setDocuments((json.documents || []).filter((d: any) =>
          /\.(csv|xlsx|xls|xpt)$/i.test(d.file_name || '')
        ))
      } catch {}
    }
  }

  async function parseDocument(doc: any) {
    setLoadingDoc(true)
    setSelectedDoc(doc)
    setParsedCols([])
    setXCol('')
    setYCols([])
    try {
      const s3Key = doc.bronzeSkey || doc.bronze_s3_key || ''
      const filename = doc.fileName || doc.file_name || doc.name
      const res = await fetch(`${AGENT_RUNTIME_URL}/widgets/parse-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3_key: s3Key, filename }),
      })
      const json = await res.json()
      setParsedCols(json.columns || [])
      setDtypes(json.dtypes || {})
      setSampleRows(json.sample_rows || [])
    } catch (e: any) {
      setError('Could not parse file: ' + e.message)
    } finally {
      setLoadingDoc(false)
    }
  }

  function buildPreview() {
    if (!sampleRows.length || !xCol || !yCols.length) return
    const { numeric } = extractColumns(parsedCols, dtypes)
    let xData: any[]
    let series: { name: string; data: any[] }[]

    if (groupCol) {
      const groups = [...new Set(sampleRows.map(r => r[groupCol]))]
      const uniqueX = [...new Set(sampleRows.map(r => r[xCol]))]
      xData = uniqueX
      series = groups.map(g => ({
        name: String(g),
        data: uniqueX.map(x => {
          const row = sampleRows.find(r => r[xCol] === x && r[groupCol] === g)
          return row ? parseFloat(row[yCols[0]]) || 0 : 0
        }),
      }))
    } else {
      xData = sampleRows.map(r => r[xCol])
      series = yCols.map(col => ({
        name: col,
        data: sampleRows.map(r => parseFloat(r[col]) || 0),
      }))
    }

    const opt = buildEChartsOption(chartType, xData, series, chartTitle || name, xLabel || xCol, yLabel || yCols.join(', '))
    setPreviewOption(opt)
    setAdvancedJson(JSON.stringify(opt, null, 2))
  }

  useEffect(() => { if (step === 2) buildPreview() }, [step, chartTitle, xLabel, yLabel, chartType, xCol, yCols, groupCol])

  function applyAdvancedJson() {
    try {
      setPreviewOption(JSON.parse(advancedJson))
    } catch { setError('Invalid JSON') }
  }

  async function save() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')
    try {
      let finalOption = previewOption
      if (showAdvanced) {
        try { finalOption = JSON.parse(advancedJson) } catch {}
      }
      const dataSource = selectedDoc ? {
        doc_id: selectedDoc.id,
        filename: selectedDoc.fileName || selectedDoc.file_name || selectedDoc.name,
        s3_key: selectedDoc.bronzeSkey || selectedDoc.bronze_s3_key || '',
        x_col: xCol, y_cols: yCols, group_col: groupCol,
      } : {}

      if (isNew) {
        await gql(`
          mutation($orgId: String!, $name: String!, $description: String, $chartType: String!, $echartsConfig: JSON!, $dataSource: JSON, $createdBy: String) {
            createWidget(orgId: $orgId, name: $name, description: $description, chartType: $chartType, echartsConfig: $echartsConfig, dataSource: $dataSource, createdBy: $createdBy) { id }
          }
        `, { orgId, name, description, chartType, echartsConfig: finalOption, dataSource, createdBy: user?.id })
      } else {
        await gql(`
          mutation($id: ID!, $name: String, $description: String, $chartType: String, $echartsConfig: JSON, $dataSource: JSON) {
            updateWidget(id: $id, name: $name, description: $description, chartType: $chartType, echartsConfig: $echartsConfig, dataSource: $dataSource) { id }
          }
        `, { id: params.id, name, description, chartType, echartsConfig: finalOption, dataSource })
      }
      router.push('/widgets')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const STEPS = ['Basics', 'Data Source', 'Configure', 'Save']
  const canNext = [
    name.trim().length > 0,
    true,
    true,
    true,
  ]

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/widgets')}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-800">{isNew ? 'Create Widget' : `Edit: ${name}`}</h1>
          <p className="text-sm text-slate-500">Apache ECharts-powered chart widget</p>
        </div>
      </div>

      {/* Step progress */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => i < step && setStep(i)}
              className={`flex items-center gap-1.5 text-sm font-medium transition-colors ${
                i === step ? 'text-brand-600' : i < step ? 'text-green-600 cursor-pointer' : 'text-slate-400'
              }`}
            >
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                i < step ? 'bg-green-100 text-green-600' : i === step ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-400'
              }`}>
                {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </span>
              {s}
            </button>
            {i < STEPS.length - 1 && <ChevronRight className="w-4 h-4 text-slate-300" />}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        {/* Step 0 — Basics */}
        {step === 0 && (
          <div className="space-y-5">
            <h2 className="font-semibold text-slate-800">Widget Basics</h2>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. AE Incidence by Treatment Arm"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                rows={2} placeholder="Optional description"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Chart Type</label>
              <div className="grid grid-cols-3 gap-3">
                {CHART_TYPES.map(({ id, label, Icon, desc }) => (
                  <button key={id} onClick={() => setChartType(id)}
                    className={`flex flex-col items-center p-3 border-2 rounded-xl transition-all ${
                      chartType === id
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-slate-200 hover:border-slate-300 text-slate-600'
                    }`}>
                    <Icon className="w-7 h-7 mb-1.5" />
                    <span className="text-sm font-semibold">{label}</span>
                    <span className="text-[10px] text-slate-400 mt-0.5">{desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1 — Data Source */}
        {step === 1 && (
          <div className="space-y-5">
            <h2 className="font-semibold text-slate-800">Data Source</h2>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Select File</label>
              {documents.length === 0 ? (
                <p className="text-sm text-slate-400">No CSV/XLSX/XPT files found. Upload files in Documents first.</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {documents.map(d => (
                    <button key={d.id}
                      onClick={() => parseDocument(d)}
                      className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                        selectedDoc?.id === d.id
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-200 hover:border-slate-300 text-slate-600'
                      }`}>
                      {d.fileName || d.file_name || d.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {loadingDoc && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <div className="w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
                Parsing file…
              </div>
            )}

            {parsedCols.length > 0 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">X Axis Column</label>
                    <select value={xCol} onChange={e => setXCol(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300">
                      <option value="">— select —</option>
                      {parsedCols.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Group / Series Column</label>
                    <select value={groupCol} onChange={e => setGroupCol(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300">
                      <option value="">— none —</option>
                      {parsedCols.filter(c => c !== xCol).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Y Axis Column(s)</label>
                  <div className="flex flex-wrap gap-1.5">
                    {extractColumns(parsedCols, dtypes).numeric.filter(c => c !== xCol && c !== groupCol).map(c => (
                      <button key={c}
                        onClick={() => setYCols(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                          yCols.includes(c)
                            ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                            : 'border-slate-200 text-slate-500 hover:border-slate-300'
                        }`}>
                        {c}
                      </button>
                    ))}
                  </div>
                  {extractColumns(parsedCols, dtypes).numeric.length === 0 && (
                    <p className="text-xs text-slate-400">No numeric columns detected. Try a different file.</p>
                  )}
                </div>
                {sampleRows.length > 0 && (
                  <details className="text-xs text-slate-500">
                    <summary className="cursor-pointer hover:text-slate-700">Preview first 5 rows</summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="text-[11px] border-collapse">
                        <thead>
                          <tr>{parsedCols.slice(0, 8).map(c => (
                            <th key={c} className="border border-slate-200 px-2 py-1 bg-slate-50 font-medium">{c}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {sampleRows.slice(0, 5).map((r, i) => (
                            <tr key={i}>{parsedCols.slice(0, 8).map(c => (
                              <td key={c} className="border border-slate-200 px-2 py-1">{String(r[c] ?? '')}</td>
                            ))}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2 — Configure */}
        {step === 2 && (
          <div className="space-y-5">
            <h2 className="font-semibold text-slate-800">Chart Configuration</h2>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Chart Title</label>
                <input value={chartTitle} onChange={e => setChartTitle(e.target.value)}
                  placeholder={name}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">X Axis Label</label>
                <input value={xLabel} onChange={e => setXLabel(e.target.value)}
                  placeholder={xCol}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Y Axis Label</label>
                <input value={yLabel} onChange={e => setYLabel(e.target.value)}
                  placeholder={yCols.join(', ')}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>
            </div>

            {/* Preview */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-500">
                Preview
              </div>
              {Object.keys(previewOption).length > 0 ? (
                <ReactECharts option={previewOption} style={{ height: 280 }} />
              ) : (
                <div className="h-44 flex items-center justify-center text-slate-400 text-sm">
                  Select a data source to preview
                </div>
              )}
            </div>

            <div>
              <button onClick={() => setShowAdvanced(o => !o)}
                className="text-xs text-brand-500 hover:text-brand-700 font-medium">
                {showAdvanced ? '▾ Hide' : '▸ Show'} advanced JSON editor
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={advancedJson}
                    onChange={e => setAdvancedJson(e.target.value)}
                    rows={12}
                    className="w-full font-mono text-xs border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-brand-300 resize-y"
                  />
                  <button onClick={applyAdvancedJson}
                    className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg text-slate-600 font-medium">
                    Apply JSON
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3 — Review & Save */}
        {step === 3 && (
          <div className="space-y-5">
            <h2 className="font-semibold text-slate-800">Review & Save</h2>
            <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Name</span><span className="font-medium text-slate-800">{name}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Type</span><span className="font-medium text-slate-800 capitalize">{chartType}</span></div>
              {selectedDoc && <div className="flex justify-between"><span className="text-slate-500">Data file</span><span className="font-medium text-slate-800">{selectedDoc.fileName || selectedDoc.name}</span></div>}
              {xCol && <div className="flex justify-between"><span className="text-slate-500">X axis</span><span className="font-medium text-slate-800">{xCol}</span></div>}
              {yCols.length > 0 && <div className="flex justify-between"><span className="text-slate-500">Y axis</span><span className="font-medium text-slate-800">{yCols.join(', ')}</span></div>}
            </div>
            {Object.keys(previewOption).length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <ReactECharts option={previewOption} style={{ height: 240 }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => step === 0 ? router.push('/widgets') : setStep(s => s - 1)}
          className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
        >
          {step === 0 ? 'Cancel' : '← Back'}
        </button>
        {step < 3 ? (
          <button
            onClick={() => setStep(s => s + 1)}
            disabled={!canNext[step]}
            className="px-5 py-2 text-sm bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-40 transition-colors"
          >
            Next →
          </button>
        ) : (
          <button
            onClick={save}
            disabled={saving}
            className="px-6 py-2 text-sm bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-40 transition-colors flex items-center gap-2"
          >
            {saving ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save Widget</>}
          </button>
        )}
      </div>
    </div>
  )
}
