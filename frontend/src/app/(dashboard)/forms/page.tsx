'use client'
import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Plus, FormInput, Search } from 'lucide-react'
import { useOrgId } from '@/components/layout/AuthContext'

interface FormSchema {
  formId: string
  title: string
  description?: string
  status: string
  version: string
  createdAt: string
}

function FormsContent() {
  const orgId = useOrgId()
  const [forms, setForms] = useState<FormSchema[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($orgId: String!) { forms(orgId: $orgId) { formId title description status version createdAt } }`,
        variables: { orgId },
      }),
    }).then(r => r.json()).then(d => setForms(d.data?.forms || []))
      .catch(console.error).finally(() => setLoading(false))
  }, [orgId])

  const filtered = forms.filter(f => f.title.toLowerCase().includes(search.toLowerCase()))

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = { active: 'bg-green-100 text-green-700', draft: 'bg-slate-100 text-slate-600', archived: 'bg-red-100 text-red-700' }
    return <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Forms Library</h1>
          <p className="text-slate-500 text-sm mt-1">JSON Schema form definitions for workflow tasks</p>
        </div>
        <Link href="/forms/build" className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600">
          <Plus className="w-4 h-4" />Build Form
        </Link>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search forms..."
          className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      {loading ? (
        <div className="text-slate-400">Loading forms...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <FormInput className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No forms found</p>
          <p className="text-sm mt-1"><Link href="/forms/build" className="text-brand-600 hover:underline">Build your first form</Link></p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(form => (
            <Link key={form.formId} href={`/forms/${form.formId}`}
              className="bg-white border border-slate-200 rounded-xl p-5 hover:border-brand-200 hover:shadow-sm transition-all">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-slate-900 line-clamp-1">{form.title}</h3>
                {statusBadge(form.status)}
              </div>
              <p className="text-xs text-slate-400 mb-2">v{form.version}</p>
              {form.description && <p className="text-sm text-slate-600 line-clamp-2">{form.description}</p>}
              <p className="text-xs text-slate-300 mt-3">{new Date(form.createdAt).toLocaleDateString()}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FormsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <FormsContent />
    </Suspense>
  )
}
