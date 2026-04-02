'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Download, Play, History, Edit, FileText, GitBranch, X, AlertCircle } from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'

interface AppDef {
  id: string
  name: string
  slug: string
  description?: string
  category: string
  version: string
  status: string
  isPublished: boolean
  publisherOrgId?: string
  formIds?: string[]
  bpmnXml?: string
  createdAt: string
}

interface AppInstallation {
  id: string
  appId: string
  status: string
}

function StartWorkflowModal({
  app,
  installationId,
  orgId,
  userId,
  onClose,
}: {
  app: AppDef
  installationId: string
  orgId: string
  userId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [studyId, setStudyId] = useState('')
  const [notes, setNotes] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const extractProcessId = (xml: string) => {
    const match = xml.match(/process\s+id="([^"]+)"/)
    return match ? match[1] : app.slug
  }

  const handleStart = async () => {
    if (!studyId.trim()) { setError('Study ID is required'); return }
    setError('')
    setStarting(true)
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
    try {
      const bpmnProcessId = app.bpmnXml ? extractProcessId(app.bpmnXml) : app.slug
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation($input: StartWorkflowInput!) { startWorkflow(input: $input) { id } }`,
          variables: {
            input: {
              orgId, installationId, appId: app.id,
              studyId: studyId.trim(), bpmnProcessId,
              inputVariables: { studyId: studyId.trim(), notes },
              startedBy: userId,
            },
          },
        }),
      })
      const json = await res.json()
      if (json.errors?.length) { setError(json.errors[0].message); return }
      const instanceId = json.data?.startWorkflow?.id
      if (instanceId) router.push(`/workflows/${instanceId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Start Workflow</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-slate-500 mb-5">{app.name}</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Study ID *</label>
            <input value={studyId} onChange={e => setStudyId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="STUDY-001" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Optional notes..." />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </p>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleStart} disabled={starting}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-60">
            <Play className="w-4 h-4" />{starting ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AppDetailContent() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const params = useParams()
  const appId = params.id as string
  const [app, setApp] = useState<AppDef | null>(null)
  const [installation, setInstallation] = useState<AppInstallation | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [showStartModal, setShowStartModal] = useState(false)

  useEffect(() => {
    if (!appId || !orgId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    Promise.all([
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: ID!, $orgId: String) { app(id: $id, orgId: $orgId) { id name slug description category version status isPublished publisherOrgId formIds bpmnXml createdAt } }`,
          variables: { id: appId, orgId },
        }),
      }).then(r => r.json()),
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($orgId: String!) { appInstallations(orgId: $orgId) { id appId status } }`,
          variables: { orgId },
        }),
      }).then(r => r.json()),
    ]).then(([appData, instData]) => {
      const appDef = appData.data?.app || null
      setApp(appDef)
      const installs: AppInstallation[] = instData.data?.appInstallations || []
      const myInstall = installs.find(i => i.appId === appId && i.status === 'active')
      setInstallation(myInstall || null)
    }).catch(console.error).finally(() => setLoading(false))
  }, [appId, orgId])

  const handleInstall = async () => {
    if (!orgId) return
    setInstalling(true)
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
    try {
      await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation($appId: ID!, $orgId: String!) { installApp(appId: $appId, orgId: $orgId, consentedPermissions: []) { id status } }`,
          variables: { appId, orgId },
        }),
      })
      window.location.reload()
    } catch (err) {
      console.error(err)
    } finally {
      setInstalling(false)
    }
  }

  if (loading) return <div className="p-6 text-slate-400">Loading...</div>
  if (!app) return <div className="p-6 text-slate-500">App not found.</div>

  const canEdit = app.publisherOrgId === orgId || user?.is_platform_admin
  const canRun = installation !== null || canEdit

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {showStartModal && installation && user && (
        <StartWorkflowModal
          app={app}
          installationId={installation.id}
          orgId={orgId!}
          userId={user.id}
          onClose={() => setShowStartModal(false)}
        />
      )}

      <div className="flex items-center gap-3">
        <Link href="/apps" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">{app.name}</h1>
          <p className="text-xs text-slate-400">v{app.version} · {app.category}</p>
        </div>
        <div className="flex gap-2">
          {canEdit && (
            <>
              <Link href={`/apps/${appId}/edit`} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50">
                <Edit className="w-3.5 h-3.5" />Edit
              </Link>
              <Link href={`/apps/${appId}/workflow`} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50">
                <GitBranch className="w-3.5 h-3.5" />Workflow
              </Link>
              <Link href={`/apps/${appId}/versions`} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50">
                <History className="w-3.5 h-3.5" />History
              </Link>
            </>
          )}
          {app.isPublished && !installation && (
            <button onClick={handleInstall} disabled={installing}
              className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-60">
              <Download className="w-4 h-4" />{installing ? 'Installing...' : 'Install'}
            </button>
          )}
          {canRun && installation && (
            <button onClick={() => setShowStartModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600">
              <Play className="w-4 h-4" />Run
            </button>
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${app.isPublished ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
            {app.isPublished ? 'Published' : app.status}
          </span>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-xs text-slate-400">{app.category}</span>
          {app.bpmnXml && (
            <>
              <span className="text-xs text-slate-400">·</span>
              <span className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                <GitBranch className="w-3 h-3" />BPMN configured
              </span>
            </>
          )}
        </div>
        {app.description && <p className="text-slate-600">{app.description}</p>}
        <p className="text-xs text-slate-400">Created {new Date(app.createdAt).toLocaleDateString()}</p>
      </div>

      {/* Attached Forms */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" />Attached Forms
        </h2>
        {!app.formIds || app.formIds.length === 0 ? (
          <p className="text-sm text-slate-400">No forms attached.</p>
        ) : (
          <div className="space-y-2">
            {app.formIds.map((fid: string) => (
              <Link key={fid} href={`/forms/${fid}`}
                className="flex items-center gap-2 text-sm text-brand-600 hover:underline font-mono">
                <FileText className="w-3.5 h-3.5" />{fid}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function AppDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <AppDetailContent />
    </Suspense>
  )
}
