'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams } from 'next/navigation'
import { ArrowLeft, FileText } from 'lucide-react'
import Link from 'next/link'
import { useOrgId } from '@/components/layout/AuthContext'

interface FormSchema {
  formId: string
  title: string
  description?: string
  jsonSchema: Record<string, unknown>
  uiSchema?: Record<string, unknown>
  status: string
  version: string
  createdAt: string
}

function FormDetailContent() {
  const orgId = useOrgId()
  const params = useParams()
  const formId = params.id as string
  const [form, setForm] = useState<FormSchema | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId || !formId) return
    const feUrl = process.env.NEXT_PUBLIC_FORM_ENGINE_URL || 'http://localhost:8010'
    const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
    fetch(`${feUrl}/forms/${formId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (!d || d.error) { setForm(null); return }
        setForm({
          formId: d.form_id ?? d.formId,
          title: d.title,
          description: d.description,
          jsonSchema: d.json_schema ?? d.jsonSchema ?? {},
          uiSchema: d.ui_schema ?? d.uiSchema,
          status: d.status,
          version: d.version ?? '1.0.0',
          createdAt: d.created_at ?? d.createdAt,
        })
      })
      .catch(console.error).finally(() => setLoading(false))
  }, [orgId, formId])

  if (loading) return <div className="p-6 text-slate-400">Loading form...</div>
  if (!form) return <div className="p-6 text-slate-500">Form not found.</div>

  const properties = (form.jsonSchema?.properties ?? {}) as Record<string, { type?: string; title?: string; enum?: string[]; format?: string }>

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/forms" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">{form.title}</h1>
          <p className="text-xs text-slate-400 mt-0.5">v{form.version} · {form.status}</p>
        </div>
        <span className="font-mono text-xs text-slate-400">{form.formId}</span>
      </div>

      {form.description && (
        <p className="text-sm text-slate-600">{form.description}</p>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
          <FileText className="w-4 h-4" />Form Fields ({Object.keys(properties).length})
        </h2>
        <div className="space-y-3">
          {Object.entries(properties).map(([key, prop]) => (
            <div key={key} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-800">{prop.title || key}</p>
                <p className="text-xs text-slate-400 font-mono">{key}</p>
              </div>
              <div className="flex items-center gap-2">
                {prop.format && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">{prop.format}</span>}
                {prop.enum && <span className="px-2 py-0.5 bg-purple-50 text-purple-700 rounded text-xs">{prop.enum.length} options</span>}
                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">{prop.type}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">JSON Schema</h2>
        <pre className="text-xs text-slate-600 bg-slate-50 rounded-lg p-4 overflow-auto max-h-64">
          {JSON.stringify(form.jsonSchema, null, 2)}
        </pre>
      </div>
    </div>
  )
}

export default function FormDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <FormDetailContent />
    </Suspense>
  )
}
