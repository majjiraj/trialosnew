'use client'
import { ClipboardList, RefreshCw, Play, Download, CheckCircle } from 'lucide-react'
import { useState } from 'react'

interface CRFForm {
  domain: string
  form_name: string
  total_fields: number
  required_fields: number
  codelist_fields: number
  fields: Array<{
    cdash: string
    sdtm: string
    label: string
    type: string
    codelist?: string
    required: boolean
  }>
}

export default function CRFBuilderPage() {
  const [forms, setForms] = useState<CRFForm[]>([])
  const [loading, setLoading] = useState(false)
  const [studyId, setStudyId] = useState('')
  const [selectedForm, setSelectedForm] = useState<CRFForm | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  const generateCRF = async () => {
    try {
      setLoading(true)
      setError(null)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
      const sid = studyId || (typeof window !== 'undefined' ? localStorage.getItem('study_id') : '') || ''
      const res = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_slug: 'crf-generation',
          org_id: orgId,
          study_id: sid,
          input_context: { trigger_type: 'manual_crf_generation' },
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const crf_forms = data.output?.metadata?.crf_forms || []
        setForms(crf_forms)
        if (crf_forms.length > 0) setSelectedForm(crf_forms[0])
      } else {
        const err = await res.json()
        setError(err.detail || 'CRF generation failed')
      }
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }

  const exportCSV = () => {
    if (!selectedForm) return
    const rows = [
      ['CDASH Field', 'SDTM Variable', 'Label', 'Type', 'Codelist', 'Required'],
      ...selectedForm.fields.map(f => [f.cdash, f.sdtm, f.label, f.type, f.codelist || '', f.required ? 'Yes' : 'No']),
    ]
    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `CRF_${selectedForm.domain}_spec.csv`
    a.click()
  }

  const typeBadge = (type: string) => {
    const colors: Record<string, string> = {
      text: 'bg-slate-100 text-slate-600',
      codelist: 'bg-brand-100 text-brand-700',
      date: 'bg-blue-100 text-blue-700',
      datetime: 'bg-blue-100 text-blue-700',
      numeric: 'bg-green-100 text-green-700',
    }
    return `px-2 py-0.5 rounded text-xs font-medium ${colors[type] || 'bg-slate-100 text-slate-600'}`
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ClipboardList className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">CRF Builder</h1>
          <p className="text-sm text-slate-500">CDASH-annotated CRF forms with SDTM traceability</p>
        </div>
      </div>

      <div className="flex items-end gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Study ID (optional)</label>
          <input
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-64"
            placeholder="study-id"
            value={studyId}
            onChange={e => setStudyId(e.target.value)}
          />
        </div>
        <button
          onClick={generateCRF}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {loading ? 'Generating...' : 'Generate CRF'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {forms.length > 0 && (
        <div className="grid grid-cols-4 gap-6">
          <div className="col-span-1">
            <h2 className="font-semibold text-slate-700 text-sm mb-2">Forms ({forms.length})</h2>
            <div className="space-y-2">
              {forms.map(form => (
                <button
                  key={form.domain}
                  onClick={() => setSelectedForm(form)}
                  className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedForm?.domain === form.domain ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <p className="font-semibold text-slate-900">{form.domain}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{form.total_fields} fields · {form.required_fields} required</p>
                </button>
              ))}
            </div>
          </div>

          <div className="col-span-3">
            {selectedForm ? (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-slate-900">{selectedForm.domain} — {selectedForm.form_name}</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {selectedForm.total_fields} fields · {selectedForm.required_fields} required · {selectedForm.codelist_fields} codelists
                    </p>
                  </div>
                  <button
                    onClick={exportCSV}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" /> Export CSV
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {['CDASH', 'SDTM', 'Label', 'Type', 'Codelist', 'Required'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left font-medium text-slate-600 text-xs">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedForm.fields.map((f, i) => (
                      <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-mono font-semibold text-brand-700 text-xs">{f.cdash}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-600 text-xs">{f.sdtm}</td>
                        <td className="px-4 py-2.5 text-slate-800 text-sm">{f.label}</td>
                        <td className="px-4 py-2.5"><span className={typeBadge(f.type)}>{f.type}</span></td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{f.codelist || '—'}</td>
                        <td className="px-4 py-2.5">
                          {f.required ? (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                          ) : (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center justify-center h-64 bg-slate-50 border border-slate-200 rounded-xl">
                <p className="text-slate-400">Select a form to view fields</p>
              </div>
            )}
          </div>
        </div>
      )}

      {forms.length === 0 && !loading && (
        <div className="flex items-center justify-center h-48 bg-slate-50 border border-slate-200 rounded-xl">
          <p className="text-slate-400">Generate CRF forms from study activities</p>
        </div>
      )}
    </div>
  )
}
