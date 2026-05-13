'use client'
import { BookOpen, Search, RefreshCw, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Standard {
  id: string
  standard_code: string
  version: string
  name: string
  publisher: string
  effective_date: string
  status: string
}

export default function StandardsPage() {
  const [standards, setStandards] = useState<Standard[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const baseUrl = process.env.NEXT_PUBLIC_STANDARDS_REGISTRY_URL || 'http://localhost:8012'

  useEffect(() => { fetchStandards() }, [])

  const fetchStandards = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${baseUrl}/standards`)
      if (res.ok) {
        const data = await res.json()
        setStandards(data.standards || [])
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const filtered = standards.filter(s =>
    search === '' ||
    s.standard_code?.toLowerCase().includes(search.toLowerCase()) ||
    s.name?.toLowerCase().includes(search.toLowerCase()) ||
    s.publisher?.toLowerCase().includes(search.toLowerCase())
  )

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: 'bg-green-100 text-green-700',
      deprecated: 'bg-red-100 text-red-700',
      draft: 'bg-yellow-100 text-yellow-700',
    }
    return `px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-slate-100 text-slate-600'}`
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BookOpen className="w-6 h-6 text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Standards Library</h1>
            <p className="text-sm text-slate-500">CDISC, FDA, ICH standards and implementation guides</p>
          </div>
        </div>
        <button onClick={fetchStandards} className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          placeholder="Search standards..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="flex gap-4 mb-6">
        <a href="/standards/terminology" className="flex-1 p-4 bg-blue-50 border border-blue-200 rounded-xl hover:bg-blue-100 transition-colors">
          <p className="font-semibold text-blue-800">CT Browser</p>
          <p className="text-sm text-blue-600 mt-1">Browse CDISC controlled terminology codelists</p>
        </a>
        <a href="/standards/regulatory" className="flex-1 p-4 bg-purple-50 border border-purple-200 rounded-xl hover:bg-purple-100 transition-colors">
          <p className="font-semibold text-purple-800">Regulatory Requirements</p>
          <p className="text-sm text-purple-600 mt-1">FDA, EMA, ICH compliance requirements</p>
        </a>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {['Code', 'Name', 'Version', 'Publisher', 'Effective Date', 'Status'].map(h => (
                  <th key={h} className="px-4 py-3 text-left font-medium text-slate-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-slate-400">No standards found</td></tr>
              ) : filtered.map(s => (
                <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-brand-700 font-medium">{s.standard_code}</td>
                  <td className="px-4 py-3 text-slate-800">{s.name || s.standard_code}</td>
                  <td className="px-4 py-3 text-slate-600">{s.version}</td>
                  <td className="px-4 py-3 text-slate-600">{s.publisher}</td>
                  <td className="px-4 py-3 text-slate-600">{s.effective_date?.slice(0, 10) || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={statusBadge(s.status || 'active')}>{s.status || 'active'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
