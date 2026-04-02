'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Check, Loader2, ExternalLink, GitBranch } from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'

const CATEGORY_OPTIONS = ['safety', 'compliance', 'site-management', 'clinical', 'regulatory', 'data-management']

const BPMN_TEMPLATES = [
  { id: 'sae-review', name: 'SAE Review Workflow', description: 'End-to-end SAE processing with AI classification and PI sign-off' },
  { id: 'protocol-deviation', name: 'Protocol Deviation Handling', description: 'Capture, classify, and remediate protocol deviations with CAPA' },
  { id: 'adverse-event-intake', name: 'Adverse Event Intake', description: 'AE capture with triage and routing to appropriate review workflow' },
  { id: 'site-initiation', name: 'Site Initiation Visit', description: 'Structured SIV checklist with regulatory package sign-off' },
  { id: 'custom', name: 'Custom / Keep existing', description: 'Keep the current BPMN or paste custom XML below' },
]

interface FormSummary { formId: string; title: string; status: string }

function AppEditContent() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const params = useParams()
  const router = useRouter()
  const appId = params.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingTemplate, setLoadingTemplate] = useState(false)
  const [availableForms, setAvailableForms] = useState<FormSummary[]>([])
  const [showXmlEditor, setShowXmlEditor] = useState(false)

  const [form, setForm] = useState({
    name: '', description: '', category: 'clinical',
    bpmnTemplate: 'custom', customBpmnXml: '',
    formIds: [] as string[],
  })

  const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
  const token = () => decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')

  // Load app + forms
  useEffect(() => {
    if (!appId || !orgId) return
    Promise.all([
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: ID!, $orgId: String) { app(id: $id, orgId: $orgId) { id name description category formIds bpmnXml publisherOrgId } }`,
          variables: { id: appId, orgId },
        }),
      }).then(r => r.json()),
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($orgId: String!) { forms(orgId: $orgId) { formId title status } }`,
          variables: { orgId },
        }),
      }).then(r => r.json()),
    ]).then(([appData, formsData]) => {
      const app = appData.data?.app
      if (!app) return
      // Guard: only owner or platform admin can edit
      if (app.publisherOrgId && app.publisherOrgId !== orgId && !user?.is_platform_admin) {
        router.replace(`/apps/${appId}`)
        return
      }
      setForm({
        name: app.name || '',
        description: app.description || '',
        category: app.category || 'clinical',
        bpmnTemplate: 'custom',
        customBpmnXml: app.bpmnXml || '',
        formIds: Array.isArray(app.formIds) ? app.formIds : [],
      })
      setAvailableForms(formsData.data?.forms || [])
    }).catch(console.error).finally(() => setLoading(false))
  }, [appId, orgId])

  const handleTemplateSelect = async (templateId: string) => {
    setForm(f => ({ ...f, bpmnTemplate: templateId }))
    if (templateId === 'custom') return
    setLoadingTemplate(true)
    try {
      const wbUrl = process.env.NEXT_PUBLIC_WORKFLOW_BRIDGE_URL || 'http://localhost:8011'
      const res = await fetch(`${wbUrl}/templates/${templateId}`)
      if (res.ok) {
        const { xml } = await res.json()
        setForm(f => ({ ...f, customBpmnXml: xml || '' }))
      }
    } catch (err) {
      console.error('Failed to fetch template:', err)
    } finally {
      setLoadingTemplate(false)
    }
  }

  const toggleFormId = (formId: string) => {
    setForm(f => ({
      ...f,
      formIds: f.formIds.includes(formId)
        ? f.formIds.filter(id => id !== formId)
        : [...f.formIds, formId],
    }))
  }

  const handleSave = async () => {
    setError(null)
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    try {
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          query: `mutation($id: ID!, $input: UpdateAppInput!) { updateApp(id: $id, input: $input) { id } }`,
          variables: {
            id: appId,
            input: {
              name: form.name,
              description: form.description,
              category: form.category,
              bpmnXml: form.customBpmnXml || null,
              formIds: form.formIds,
            },
          },
        }),
      })
      const json = await res.json()
      if (json.errors?.length) { setError(json.errors[0].message); return }
      router.push(`/apps/${appId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-6 text-slate-400">Loading...</div>

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/apps/${appId}`} className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <h1 className="text-xl font-bold text-slate-900">Edit App</h1>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Basic Info */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-slate-800">Basic Info</h2>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">App Name *</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Workflow / BPMN */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <GitBranch className="w-4 h-4" />Workflow (BPMN)
          </h2>
          <button onClick={() => setShowXmlEditor(v => !v)}
            className="text-xs text-brand-600 hover:underline">
            {showXmlEditor ? 'Hide XML editor' : 'Edit XML directly'}
          </button>
        </div>

        <p className="text-xs text-slate-500">Replace the workflow by selecting a template, or edit the raw BPMN XML below.</p>

        <div className="grid grid-cols-1 gap-2">
          {BPMN_TEMPLATES.map(t => (
            <button key={t.id} onClick={() => handleTemplateSelect(t.id)}
              disabled={loadingTemplate}
              className={`text-left p-3 border-2 rounded-xl transition-all disabled:opacity-60 ${form.bpmnTemplate === t.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-900">{t.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                </div>
                {form.bpmnTemplate === t.id && (
                  loadingTemplate
                    ? <Loader2 className="w-4 h-4 text-brand-500 animate-spin flex-shrink-0" />
                    : <Check className="w-4 h-4 text-brand-500 flex-shrink-0" />
                )}
              </div>
            </button>
          ))}
        </div>

        {showXmlEditor && (
          <div className="space-y-1">
            <label className="block text-xs text-slate-500">BPMN XML</label>
            <textarea
              value={form.customBpmnXml}
              onChange={e => setForm(f => ({ ...f, customBpmnXml: e.target.value }))}
              rows={12}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50"
              placeholder="Paste BPMN 2.0 XML here..."
            />
            {form.customBpmnXml && (
              <p className="text-xs text-slate-400">{form.customBpmnXml.length.toLocaleString()} chars</p>
            )}
          </div>
        )}

        {form.customBpmnXml && !showXmlEditor && !loadingTemplate && (
          <div className="flex items-center gap-2 text-xs text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <Check className="w-3.5 h-3.5" />BPMN configured ({form.customBpmnXml.length.toLocaleString()} chars)
          </div>
        )}
      </div>

      {/* Forms */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-slate-800">Attached Forms</h2>
        {availableForms.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-slate-400 mb-2">No forms in your library yet.</p>
            <a href="/forms/build" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
              Build a Form <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        ) : (
          <div className="space-y-2">
            {availableForms.map(f => (
              <label key={f.formId} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                <input type="checkbox"
                  checked={form.formIds.includes(f.formId)}
                  onChange={() => toggleFormId(f.formId)}
                  className="rounded" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-800">{f.title}</p>
                  <p className="text-xs text-slate-400 font-mono">{f.formId}</p>
                </div>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${f.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {f.status}
                </span>
              </label>
            ))}
          </div>
        )}
        {form.formIds.length > 0 && (
          <p className="text-xs text-brand-600">{form.formIds.length} form{form.formIds.length !== 1 ? 's' : ''} attached</p>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Link href={`/apps/${appId}`} className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
          Cancel
        </Link>
        <button onClick={handleSave} disabled={saving}
          className="px-6 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-60">
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

export default function AppEditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <AppEditContent />
    </Suspense>
  )
}
