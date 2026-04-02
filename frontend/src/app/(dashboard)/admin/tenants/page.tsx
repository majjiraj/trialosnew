'use client'
import { useEffect, useState, useCallback } from 'react'
import { Building2, CheckCircle, AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/components/layout/AuthContext'
import { useRouter } from 'next/navigation'
import { clsx } from 'clsx'

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:8001'

function authHeader(): Record<string, string> {
  const match = typeof document !== 'undefined' && document.cookie.match(/trialo_token=([^;]+)/)
  return match ? { Authorization: `Bearer ${decodeURIComponent(match[1])}` } : {}
}

interface Tenant {
  id: string
  name: string
  slug: string
  plan: string
  status: string
  user_count: number
  created_at: string
}

export default function TenantsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [fetching, setFetching] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && !user?.is_platform_admin) router.push('/')
  }, [user, loading, router])

  const load = useCallback(async () => {
    setFetching(true)
    try {
      const r = await fetch(`${AUTH_URL}/admin/tenants`, { headers: authHeader() })
      if (r.ok) setTenants((await r.json()).tenants || [])
    } finally {
      setFetching(false)
    }
  }, [])

  useEffect(() => { if (user?.is_platform_admin) load() }, [user, load])

  const toggleStatus = async (tenant: Tenant) => {
    const newStatus = tenant.status === 'active' ? 'suspended' : 'active'
    setToggling(tenant.id)
    try {
      const r = await fetch(`${AUTH_URL}/admin/tenants/${tenant.id}/status`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success(`Tenant ${newStatus === 'active' ? 'activated' : 'suspended'}`)
      setTenants(ts => ts.map(t => t.id === tenant.id ? { ...t, status: newStatus } : t))
    } catch {
      toast.error('Failed to update tenant status')
    } finally {
      setToggling(null)
    }
  }

  if (loading || !user?.is_platform_admin) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Tenants</h1>
          <p className="text-sm text-slate-500 mt-1">All registered tenant organizations</p>
        </div>
        <button onClick={load} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="card">
        {fetching ? (
          <div className="px-5 py-10 flex items-center justify-center gap-2 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />Loading…
          </div>
        ) : tenants.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">No tenants yet</div>
        ) : tenants.map(tenant => (
          <div key={tenant.id} className="px-5 py-4 flex items-center gap-4 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
            <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <Building2 className="w-4 h-4 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900">{tenant.name}</span>
                <span className="text-xs text-slate-400">@{tenant.slug}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Plan: <span className="capitalize font-medium">{tenant.plan}</span>
                {' · '}{tenant.user_count} user{tenant.user_count !== 1 ? 's' : ''}
                {' · '}Created {new Date(tenant.created_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={clsx(
                'flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full',
                tenant.status === 'active'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-red-50 text-red-700'
              )}>
                {tenant.status === 'active'
                  ? <CheckCircle className="w-3 h-3" />
                  : <AlertCircle className="w-3 h-3" />}
                {tenant.status}
              </span>
              <button
                onClick={() => toggleStatus(tenant)}
                disabled={toggling === tenant.id}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                  tenant.status === 'active'
                    ? 'border-red-200 text-red-600 hover:bg-red-50'
                    : 'border-green-200 text-green-600 hover:bg-green-50'
                )}
              >
                {toggling === tenant.id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : tenant.status === 'active' ? 'Suspend' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
