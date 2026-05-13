'use client'
import { Shield, RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

interface RegRequirement {
  id: string
  requirement_id: string
  name: string
  description: string
  authority: string
  category: string
  applies_to: string[]
  is_mandatory: boolean
}

const CATEGORY_COLORS: Record<string, string> = {
  traceability: 'bg-blue-100 text-blue-700',
  audit_trail: 'bg-purple-100 text-purple-700',
  submission: 'bg-orange-100 text-orange-700',
  gcp: 'bg-green-100 text-green-700',
}

export default function RegulatoryPage() {
  const [requirements, setRequirements] = useState<RegRequirement[]>([])
  const [loading, setLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [authorityFilter, setAuthorityFilter] = useState('')

  const baseUrl = process.env.NEXT_PUBLIC_STANDARDS_REGISTRY_URL || 'http://localhost:8012'

  useEffect(() => { fetchRequirements() }, [])

  const fetchRequirements = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${baseUrl}/regulatory/requirements`)
      if (res.ok) {
        const data = await res.json()
        setRequirements(data.requirements || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const categories = [...new Set(requirements.map(r => r.category).filter(Boolean))]
  const authorities = [...new Set(requirements.map(r => r.authority).filter(Boolean))]

  const filtered = requirements.filter(r =>
    (categoryFilter === '' || r.category === categoryFilter) &&
    (authorityFilter === '' || r.authority === authorityFilter)
  )

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-purple-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Regulatory Requirements</h1>
            <p className="text-sm text-slate-500">FDA, EMA, ICH, GCP compliance requirements</p>
          </div>
        </div>
        <button onClick={fetchRequirements} className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="flex gap-3 mb-5">
        <select
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c.replace('_', ' ').replace(/^\w/, l => l.toUpperCase())}</option>)}
        </select>
        <select
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          value={authorityFilter}
          onChange={e => setAuthorityFilter(e.target.value)}
        >
          <option value="">All Authorities</option>
          {authorities.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="px-3 py-2 text-sm text-slate-500">{filtered.length} requirements</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-brand-500" /></div>
      ) : (
        <div className="grid gap-4">
          {filtered.map(req => (
            <div key={req.id} className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  {req.is_mandatory ? (
                    <AlertTriangle className="w-5 h-5 text-orange-500 mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-sm text-brand-700 font-semibold">{req.requirement_id}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_COLORS[req.category] || 'bg-slate-100 text-slate-600'}`}>
                        {req.category?.replace('_', ' ')}
                      </span>
                    </div>
                    <h3 className="font-semibold text-slate-900">{req.name}</h3>
                    <p className="text-sm text-slate-600 mt-1">{req.description}</p>
                    {req.applies_to?.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {req.applies_to.map((a, i) => (
                          <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{a}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <span className="text-sm font-medium text-slate-500 shrink-0 ml-4">{req.authority}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
