'use client'
import { useEffect, useState, useCallback } from 'react'
import { Users, Plus, X, Loader2, RefreshCw, UserCheck, UserX } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/components/layout/AuthContext'
import { clsx } from 'clsx'

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:8001'

function authHeader(): Record<string, string> {
  const match = typeof document !== 'undefined' && document.cookie.match(/trialo_token=([^;]+)/)
  return match ? { Authorization: `Bearer ${decodeURIComponent(match[1])}` } : {}
}

const ROLES = ['analyst', 'tenant_admin', 'reviewer']

interface OrgUser {
  id: string
  email: string
  name: string
  roles: string[]
  is_active: boolean
  created_at: string
}

export default function UsersPage() {
  const { user } = useAuth()
  const [users, setUsers] = useState<OrgUser[]>([])
  const [fetching, setFetching] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'analyst' })
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const isAdmin = user?.roles.includes('tenant_admin') || user?.roles.includes('platform_admin')

  const load = useCallback(async () => {
    if (!user?.org_id) return
    setFetching(true)
    try {
      const r = await fetch(`${AUTH_URL}/tenants/${user.org_id}/users`, { headers: authHeader() })
      if (r.ok) setUsers((await r.json()).users || [])
    } finally {
      setFetching(false)
    }
  }, [user?.org_id])

  useEffect(() => { load() }, [load])

  const invite = async () => {
    if (!form.name || !form.email || !form.password) {
      toast.error('All fields are required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch(`${AUTH_URL}/tenants/${user!.org_id}/users`, {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, roles: [form.role] }),
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'Failed')
      toast.success('User added successfully')
      setShowModal(false)
      setForm({ name: '', email: '', password: '', role: 'analyst' })
      load()
    } catch (err: any) {
      toast.error(err.message || 'Failed to add user')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (u: OrgUser) => {
    setToggling(u.id)
    try {
      const r = await fetch(`${AUTH_URL}/tenants/${user!.org_id}/users/${u.id}`, {
        method: 'PATCH',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !u.is_active }),
      })
      if (!r.ok) throw new Error('Failed')
      setUsers(us => us.map(x => x.id === u.id ? { ...x, is_active: !x.is_active } : x))
      toast.success(u.is_active ? 'User deactivated' : 'User activated')
    } catch {
      toast.error('Failed to update user')
    } finally {
      setToggling(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Users</h1>
          <p className="text-sm text-slate-500 mt-1">Manage users in your organization</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />Invite User
            </button>
          )}
        </div>
      </div>

      <div className="card">
        {fetching ? (
          <div className="px-5 py-10 flex items-center justify-center gap-2 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />Loading…
          </div>
        ) : users.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">No users found</div>
        ) : users.map(u => (
          <div key={u.id}
            className="px-5 py-4 flex items-center gap-4 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
            <div className={clsx(
              'w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0',
              u.is_active ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
            )}>
              {u.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900">{u.name}</span>
                {!u.is_active && (
                  <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">inactive</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {u.email}
                {' · '}{u.roles.join(', ')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {new Date(u.created_at).toLocaleDateString()}
              </span>
              {isAdmin && u.id !== user?.id && (
                <button
                  onClick={() => toggleActive(u)}
                  disabled={toggling === u.id}
                  className={clsx(
                    'flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors',
                    u.is_active
                      ? 'border-red-200 text-red-600 hover:bg-red-50'
                      : 'border-green-200 text-green-600 hover:bg-green-50'
                  )}
                >
                  {toggling === u.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : u.is_active
                      ? <><UserX className="w-3 h-3" />Deactivate</>
                      : <><UserCheck className="w-3 h-3" />Activate</>}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Invite Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Invite User</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {[
                { label: 'Full Name', key: 'name', type: 'text', placeholder: 'Jane Smith' },
                { label: 'Email', key: 'email', type: 'email', placeholder: 'jane@company.com' },
                { label: 'Temporary Password', key: 'password', type: 'password', placeholder: 'Min. 8 chars' },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">{f.label}</label>
                  <input
                    type={f.type}
                    value={(form as any)[f.key]}
                    onChange={e => setForm(x => ({ ...x, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Role</label>
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {ROLES.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                </select>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={invite}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
                Invite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
