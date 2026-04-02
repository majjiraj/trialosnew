'use client'

import { useState, useEffect } from 'react'
import { Download, FlaskConical, RefreshCw, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Info } from 'lucide-react'

const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

async function gql(query: string, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

// ─── Domain definitions (fallback if API unavailable) ─────────────────────────

const DOMAIN_OPTIONS: Record<string, string[]> = {
  SDTM:     ['DM','AE','LB','VS','CM','EX','MH','DS','SV','IE','QS','PE','SC','CO','PC','PR','RS','IS','FA','HO','TU'],
  ADaM:     ['ADSL','ADAE','ADLB','ADVS','ADCM','ADTTE','ADEX','ADMH','ADPP','ADRS'],
  CRF:      ['AE','DM','CM','LB','VS','MH','DS','EX','SV','QS','PE','SC'],
  RawEDC:   ['AE','DM','CM','LB','VS','MH','DS','EX','SV','QS','PE','SC'],
  Protocol: ['TITLE','OBJECTIVES','DESIGN','POPULATION','ENDPOINTS','PROCEDURES','STATISTICS','SAFETY','REFERENCES'],
  TLF:      ['TABLES','LISTINGS','FIGURES','APPENDICES'],
}

const DOMAIN_DESCRIPTIONS: Record<string, Record<string, string>> = {
  SDTM: {
    DM: 'Demographics', AE: 'Adverse Events', LB: 'Lab Results', VS: 'Vital Signs',
    CM: 'Concomitant Medications', EX: 'Exposure', MH: 'Medical History',
    DS: 'Disposition', SV: 'Subject Visits', IE: 'Inclusion/Exclusion Criteria',
    QS: 'Questionnaires & Ratings', PE: 'Physical Exam', SC: 'Subject Characteristics',
    CO: 'Comments', PC: 'Pharmacokinetics', PR: 'Procedures',
    RS: 'Disease Response', IS: 'Immunogenicity Specimens',
    FA: 'Findings About Events', HO: 'Healthcare Encounters', TU: 'Tumor Identification',
  },
  ADaM: {
    ADSL: 'Subject Level', ADAE: 'Adverse Events', ADLB: 'Lab Data',
    ADVS: 'Vital Signs', ADCM: 'Concomitant Medications', ADTTE: 'Time-to-Event',
    ADEX: 'Exposure Analysis', ADMH: 'Medical History Analysis',
    ADPP: 'PK Parameters', ADRS: 'Disease Response Analysis',
  },
  CRF: {
    AE: 'Adverse Events Form', DM: 'Demographics Form', CM: 'Concomitant Meds',
    LB: 'Lab Form', VS: 'Vital Signs', MH: 'Medical History',
    DS: 'Disposition', EX: 'Exposure', SV: 'Subject Visits', QS: 'Questionnaires',
    PE: 'Physical Exam', SC: 'Subject Characteristics',
  },
  RawEDC: {
    AE: 'Adverse Events', DM: 'Demographics', CM: 'Concomitant Meds',
    LB: 'Laboratory', VS: 'Vital Signs', MH: 'Medical History',
    DS: 'Disposition', EX: 'Exposure', SV: 'Subject Visits', QS: 'Questionnaires',
    PE: 'Physical Exam', SC: 'Subject Characteristics',
  },
  Protocol: {
    TITLE: 'Protocol Title', OBJECTIVES: 'Objectives', DESIGN: 'Study Design',
    POPULATION: 'Study Population', ENDPOINTS: 'Endpoints', PROCEDURES: 'Procedures',
    STATISTICS: 'Statistical Methods', SAFETY: 'Safety', REFERENCES: 'References',
  },
  TLF: { TABLES: 'Summary Tables', LISTINGS: 'Data Listings', FIGURES: 'Graphs & Figures', APPENDICES: 'Appendices' },
}

const DATA_TYPES = [
  { id: 'SDTM',     label: 'SDTM',         desc: 'Study Data Tabulation Model (CDISC)',    color: 'indigo' },
  { id: 'ADaM',     label: 'ADaM',         desc: 'Analysis Data Model (CDISC)',             color: 'purple' },
  { id: 'Protocol', label: 'Protocol',     desc: 'Clinical Study Protocol document',        color: 'cyan'   },
  { id: 'TLF',      label: 'TLF',          desc: 'Tables, Listings & Figures',              color: 'teal'   },
  { id: 'CRF',      label: 'CRF',          desc: 'Case Report Form data',                   color: 'orange' },
  { id: 'RawEDC',   label: 'Raw EDC',      desc: 'Raw electronic data capture export',      color: 'rose'   },
]

const OUTPUT_FORMATS = [
  { id: 'CSV', label: 'CSV', desc: 'Comma-separated (ZIP with one file per domain)', icon: '📄' },
  { id: 'XLS', label: 'Excel', desc: 'Excel workbook (.xlsx) — one sheet per domain', icon: '📊' },
  { id: 'XPT', label: 'XPT', desc: 'SAS Transport v5 (FDA submission standard)',     icon: '🔬' },
  { id: 'PDF', label: 'PDF', desc: 'Formatted report (preview — rows not applicable)', icon: '📋' },
]

const THERAPEUTIC_AREAS = [
  'Oncology', 'Cardiology', 'Neurology', 'Immunology',
  'Infectious Disease', 'Metabolic/Endocrine', 'Respiratory', 'Rare Disease',
]

const COLOR_MAP: Record<string, string> = {
  indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700 ring-indigo-400',
  purple: 'bg-purple-50 border-purple-200 text-purple-700 ring-purple-400',
  cyan:   'bg-cyan-50   border-cyan-200   text-cyan-700   ring-cyan-400',
  teal:   'bg-teal-50   border-teal-200   text-teal-700   ring-teal-400',
  orange: 'bg-orange-50 border-orange-200 text-orange-700 ring-orange-400',
  rose:   'bg-rose-50   border-rose-200   text-rose-700   ring-rose-400',
}

const SELECTED_MAP: Record<string, string> = {
  indigo: 'bg-indigo-600 border-indigo-600 text-white ring-2 ring-indigo-400 ring-offset-2',
  purple: 'bg-purple-600 border-purple-600 text-white ring-2 ring-purple-400 ring-offset-2',
  cyan:   'bg-cyan-600   border-cyan-600   text-white ring-2 ring-cyan-400   ring-offset-2',
  teal:   'bg-teal-600   border-teal-600   text-white ring-2 ring-teal-400   ring-offset-2',
  orange: 'bg-orange-600 border-orange-600 text-white ring-2 ring-orange-400 ring-offset-2',
  rose:   'bg-rose-600   border-rose-600   text-white ring-2 ring-rose-400   ring-offset-2',
}

function formatNumber(n: number) {
  if (n >= 10_000_000) return '1 Crore (10M)'
  if (n >= 1_000_000)  return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)      return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

const ROW_PRESETS = [
  { label: '50',   value: 50 },
  { label: '100',  value: 100 },
  { label: '500',  value: 500 },
  { label: '1K',   value: 1_000 },
  { label: '10K',  value: 10_000 },
  { label: '100K', value: 100_000 },
  { label: '1M',   value: 1_000_000 },
  { label: '1 Cr', value: 10_000_000 },
]

export default function DataGeneratorPage() {
  const [dataType,      setDataType]      = useState<string>('SDTM')
  const [subDomains,    setSubDomains]    = useState<string[]>(['DM','AE','LB'])
  const [outputFormat,  setOutputFormat]  = useState<string>('CSV')
  const [numRows,       setNumRows]       = useState<number>(100)
  const [numRowsInput,  setNumRowsInput]  = useState<string>('100')
  const [addAnomalies,  setAddAnomalies]  = useState<boolean>(false)
  const [studyId,       setStudyId]       = useState<string>('STUDY-001')
  const [domainOptions, setDomainOptions] = useState<Record<string, string[]>>(DOMAIN_OPTIONS)
  const [generating,    setGenerating]    = useState<boolean>(false)
  const [progress,      setProgress]      = useState<string>('')
  const [error,         setError]         = useState<string>('')
  const [lastResult,    setLastResult]    = useState<{ filename: string; size: number; rows: number; domains: string[] } | null>(null)
  const [showAdvanced,  setShowAdvanced]  = useState<boolean>(false)
  const [therapeuticArea, setTherapeuticArea] = useState<string>('')

  // Fetch available domains from backend
  useEffect(() => {
    gql(`query { testDataDomains { SDTM ADaM CRF RawEDC Protocol TLF } }`)
      .then(d => {
        if (d?.testDataDomains) setDomainOptions(d.testDataDomains)
      })
      .catch(() => { /* use fallback */ })
  }, [])

  // Reset sub-domains when data type changes
  const handleDataTypeChange = (dt: string) => {
    setDataType(dt)
    const opts = domainOptions[dt] || []
    setSubDomains(opts.slice(0, 3))
    setError('')
    setLastResult(null)
  }

  const toggleDomain = (d: string) => {
    setSubDomains(prev =>
      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
    )
  }

  const isPdfFormat     = outputFormat === 'PDF'
  const activeColor     = DATA_TYPES.find(t => t.id === dataType)?.color || 'indigo'
  const currentDomains  = domainOptions[dataType] || []
  const rowsValid       = numRows >= 1 && numRows <= 10_000_000

  async function handleGenerate() {
    if (!dataType || !outputFormat) return
    if (subDomains.length === 0) {
      setError('Please select at least one domain / sub-type.')
      return
    }
    setError('')
    setLastResult(null)
    setGenerating(true)
    setProgress('Generating data…')

    try {
      const body = {
        data_type:    dataType,
        sub_domains:  subDomains,
        output_format: outputFormat,
        num_rows:     isPdfFormat ? 100 : numRows,
        add_anomalies: addAnomalies,
        study_id:     studyId || 'STUDY-001',
        therapeutic_area: therapeuticArea,
      }

      setProgress('Sending request to data generator…')
      const res = await fetch(`${AGENT_RUNTIME_URL}/generate-test-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const detail = await res.text()
        throw new Error(detail || `HTTP ${res.status}`)
      }

      setProgress('Downloading file…')
      const blob      = await res.blob()
      const filename  = res.headers.get('content-disposition')
        ?.split('filename=')[1]?.replace(/"/g, '') || `${dataType.toLowerCase()}_test_data`
      const rowsGen   = parseInt(res.headers.get('x-generated-rows') || String(numRows), 10)

      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href    = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setLastResult({
        filename,
        size:    blob.size,
        rows:    isPdfFormat ? 0 : rowsGen,
        domains: subDomains,
      })
      setProgress('')
    } catch (e: any) {
      setError(e.message || 'Generation failed')
      setProgress('')
    } finally {
      setGenerating(false)
    }
  }

  const formatBytes = (b: number) =>
    b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB`
    : b > 1024    ? `${(b / 1024).toFixed(0)} KB`
    : `${b} B`

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
          <FlaskConical className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Test Data Generator</h1>
          <p className="text-sm text-slate-500">Generate CDISC-compliant synthetic clinical data for development and testing</p>
        </div>
      </div>

      {/* Standards notice */}
      <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>All generated data follows CDISC SDTM IG v3.4 and ADaM IG v1.3 standards with FDA controlled terminology. Data is fully synthetic — no real patient information.</span>
      </div>

      {/* ── Step 1: Data Type ── */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">1</span>
          Data Type
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {DATA_TYPES.map(dt => {
            const selected = dataType === dt.id
            return (
              <button
                key={dt.id}
                onClick={() => handleDataTypeChange(dt.id)}
                className={`flex flex-col items-start gap-0.5 p-3.5 rounded-xl border text-left transition-all
                  ${selected ? SELECTED_MAP[dt.color] : `${COLOR_MAP[dt.color]} hover:opacity-90`}`}
              >
                <span className="text-sm font-bold">{dt.label}</span>
                <span className={`text-[10px] leading-tight ${selected ? 'text-white/80' : 'opacity-70'}`}>{dt.desc}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Step 2: Sub Domains ── */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">2</span>
          {dataType === 'Protocol' || dataType === 'TLF' ? 'Sections' : 'Domains / Sub-types'}
          <span className="ml-auto text-xs font-normal text-slate-400">{subDomains.length} selected</span>
        </h2>
        <p className="text-xs text-slate-400 mb-4">Select one or more to include in the output</p>

        <div className="flex flex-wrap gap-2">
          {/* Select All / None */}
          <button
            onClick={() => setSubDomains(currentDomains)}
            className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 hover:border-slate-400 transition-colors"
          >All</button>
          <button
            onClick={() => setSubDomains([])}
            className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 hover:border-slate-400 transition-colors"
          >None</button>

          {currentDomains.map(d => {
            const selected = subDomains.includes(d)
            const desc = DOMAIN_DESCRIPTIONS[dataType]?.[d] || d
            return (
              <button
                key={d}
                onClick={() => toggleDomain(d)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all
                  ${selected
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              >
                <span className="font-mono font-bold">{d}</span>
                <span className={`font-normal ${selected ? 'text-white/70' : 'text-slate-400'}`}>· {desc}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Step 3: Output Format ── */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">3</span>
          Output Format
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {OUTPUT_FORMATS.map(fmt => {
            const selected = outputFormat === fmt.id
            return (
              <button
                key={fmt.id}
                onClick={() => setOutputFormat(fmt.id)}
                className={`flex flex-col items-center gap-1.5 p-4 rounded-xl border text-center transition-all
                  ${selected
                    ? 'bg-indigo-600 border-indigo-600 text-white ring-2 ring-indigo-400 ring-offset-2'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              >
                <span className="text-2xl">{fmt.icon}</span>
                <span className="font-bold text-sm">{fmt.label}</span>
                <span className={`text-[10px] leading-tight ${selected ? 'text-white/70' : 'text-slate-400'}`}>{fmt.desc}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Step 4: Number of Rows ── */}
      {!isPdfFormat && (
        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">4</span>
            Number of Rows
            <span className="ml-auto text-xs font-normal text-slate-400">Max: 1 Crore (10,000,000)</span>
          </h2>

          {/* Presets */}
          <div className="flex flex-wrap gap-2 mb-4">
            {ROW_PRESETS.map(p => (
              <button
                key={p.value}
                onClick={() => { setNumRows(p.value); setNumRowsInput(String(p.value)) }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all
                  ${numRows === p.value
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom input */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <input
                type="number"
                min={1}
                max={10_000_000}
                value={numRowsInput}
                onChange={e => {
                  setNumRowsInput(e.target.value)
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1 && v <= 10_000_000) setNumRows(v)
                }}
                className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2
                  ${rowsValid ? 'border-slate-200 focus:ring-indigo-300' : 'border-red-300 focus:ring-red-300'}`}
                placeholder="Enter custom row count (1 – 10,000,000)"
              />
            </div>
            <div className="text-right">
              <span className="text-2xl font-bold text-indigo-600">{formatNumber(numRows)}</span>
              <p className="text-[10px] text-slate-400">rows total</p>
            </div>
          </div>

          {numRows > 1_000_000 && (
            <div className="flex items-center gap-2 mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Large datasets ({formatNumber(numRows)} rows) may take a minute to generate and download.
            </div>
          )}
          {numRows > 500_000 && outputFormat === 'XLS' && (
            <div className="flex items-center gap-2 mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Excel max row limit is 1,048,576 per sheet. Rows will be capped at 1M for XLS format.
            </div>
          )}
        </section>
      )}

      {/* ── Step 5: Data Anomalies + Advanced ── */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">{isPdfFormat ? '4' : '5'}</span>
          Quality & Anomalies
        </h2>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <div
            onClick={() => setAddAnomalies(p => !p)}
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0
              ${addAnomalies ? 'bg-indigo-600' : 'bg-slate-200'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform
              ${addAnomalies ? 'translate-x-5.5' : 'translate-x-0.5'}`} />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-700">Add Data Anomalies</p>
            <p className="text-xs text-slate-400">Injects realistic errors: missing values, outliers, duplicate records, implausible dates — useful for testing validation rules</p>
          </div>
        </label>

        {addAnomalies && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {['Missing values', 'Outlier numerics', 'Duplicate records', 'Implausible dates'].map(a => (
              <span key={a} className="text-[11px] bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-2 py-1 text-center">
                ⚠ {a}
              </span>
            ))}
          </div>
        )}

        {dataType === 'RawEDC' && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Therapeutic Area <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Shapes disease-specific AE terms, medications, lab tests, and demographics.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setTherapeuticArea('')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  therapeuticArea === ''
                    ? 'bg-rose-600 border-rose-600 text-white'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-rose-300'
                }`}
              >
                General
              </button>
              {THERAPEUTIC_AREAS.map(ta => (
                <button
                  key={ta}
                  onClick={() => setTherapeuticArea(therapeuticArea === ta ? '' : ta)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    therapeuticArea === ta
                      ? 'bg-rose-600 border-rose-600 text-white'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-rose-300'
                  }`}
                >
                  {ta}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Advanced options */}
        <button
          onClick={() => setShowAdvanced(p => !p)}
          className="flex items-center gap-1 mt-4 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        >
          {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Advanced options
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Study ID</label>
              <input
                type="text"
                value={studyId}
                onChange={e => setStudyId(e.target.value)}
                placeholder="STUDY-001"
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full max-w-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Generate Button ── */}
      <div className="flex flex-col items-center gap-3">
        {error && (
          <div className="w-full flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={generating || subDomains.length === 0 || (!isPdfFormat && !rowsValid)}
          className={`w-full flex items-center justify-center gap-2.5 py-4 rounded-2xl text-base font-semibold transition-all shadow-lg
            ${generating || subDomains.length === 0
              ? 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}
        >
          {generating ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              {progress || 'Generating…'}
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              Generate &amp; Download {outputFormat} {!isPdfFormat ? `· ${formatNumber(numRows)} rows` : ''} · {subDomains.join(', ')}
            </>
          )}
        </button>

        {generating && (
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-indigo-500 rounded-full animate-pulse w-2/3" />
          </div>
        )}
      </div>

      {/* ── Success Result ── */}
      {lastResult && (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-5 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-green-800">File generated and downloaded successfully</p>
            <div className="flex flex-wrap gap-3 text-xs text-green-700">
              <span>📁 <strong>{lastResult.filename}</strong></span>
              <span>💾 {formatBytes(lastResult.size)}</span>
              {lastResult.rows > 0 && <span>📋 {lastResult.rows.toLocaleString()} rows</span>}
              <span>🗂 {lastResult.domains.join(', ')}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Standards Reference ── */}
      <section className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
        <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3">Standards Compliance</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            { label: 'CDISC SDTM IG', ver: 'v3.4' },
            { label: 'CDISC ADaM IG', ver: 'v1.3' },
            { label: 'FDA SEND',      ver: '3.1'   },
            { label: 'ICH E6(R3)',    ver: 'GCP'   },
          ].map(s => (
            <div key={s.label} className="bg-white border border-slate-200 rounded-xl py-2.5 px-3">
              <p className="text-[11px] font-bold text-slate-700">{s.label}</p>
              <p className="text-[10px] text-slate-400">{s.ver}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
