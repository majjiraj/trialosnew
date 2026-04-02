'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Shield, Building2, Users, BookOpen, ChevronRight, Wand2, AppWindow, FormInput, GitBranch, PackageCheck } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'
import { useRouter } from 'next/navigation'

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:8001'
const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'
const APP_COMPOSER_URL = process.env.NEXT_PUBLIC_APP_COMPOSER_URL || 'http://localhost:8009'
const FORM_ENGINE_URL = process.env.NEXT_PUBLIC_FORM_ENGINE_URL || 'http://localhost:8010'
const WORKFLOW_BRIDGE_URL = process.env.NEXT_PUBLIC_WORKFLOW_BRIDGE_URL || 'http://localhost:8011'

function authHeader(): Record<string, string> {
  const match = typeof document !== 'undefined' && document.cookie.match(/trialo_token=([^;]+)/)
  return match ? { Authorization: `Bearer ${decodeURIComponent(match[1])}` } : {}
}

export default function AdminPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [stats, setStats] = useState({ tenants: 0, users: 0, graphs: 0, skills: 0, apps: 0, forms: 0, workflows: 0, pendingReviews: 0 })

  useEffect(() => {
    if (!loading && !user?.is_platform_admin) router.push('/')
  }, [user, loading, router])

  useEffect(() => {
    if (!user?.is_platform_admin) return
    const headers = authHeader()
    Promise.all([
      fetch(`${AUTH_URL}/admin/tenants`, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(`${AUTH_URL}/admin/users`, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(`${CONTEXT_GRAPH_URL}/standard-graphs`).then(r => r.json()).catch(() => ({})),
      fetch(`${MARKETPLACE_URL}/skills/standard?published_only=true`).then(r => r.json()).catch(() => ({})),
      fetch(`${APP_COMPOSER_URL}/apps?status=under_review`).then(r => r.json()).catch(() => ({})),
      fetch(`${APP_COMPOSER_URL}/apps`).then(r => r.json()).catch(() => ({})),
      fetch(`${FORM_ENGINE_URL}/forms`).then(r => r.json()).catch(() => ({})),
      fetch(`${WORKFLOW_BRIDGE_URL}/instances`).then(r => r.json()).catch(() => ({})),
    ]).then(([tenants, users, graphs, skills, pendingApps, allApps, forms, workflows]) => {
      setStats({
        tenants: tenants.tenants?.length ?? 0,
        users: users.users?.length ?? 0,
        graphs: graphs.graphs?.filter((g: any) => g.is_published).length ?? 0,
        skills: skills.skills?.length ?? 0,
        apps: allApps.apps?.length ?? 0,
        forms: forms.forms?.length ?? 0,
        workflows: workflows.instances?.length ?? 0,
        pendingReviews: pendingApps.apps?.length ?? 0,
      })
    }).catch(() => {})
  }, [user])

  if (loading || !user?.is_platform_admin) return null

  const statCards = [
    { label: 'Tenants', value: stats.tenants, icon: Building2, color: 'bg-blue-50 text-blue-600', href: '/admin/tenants' },
    { label: 'Total Users', value: stats.users, icon: Users, color: 'bg-green-50 text-green-600', href: '/admin/tenants' },
    { label: 'Published Graphs', value: stats.graphs, icon: BookOpen, color: 'bg-purple-50 text-purple-600', href: '/admin/standard-graphs' },
    { label: 'Standard Skills', value: stats.skills, icon: Wand2, color: 'bg-pink-50 text-pink-600', href: '/admin/standard-skills' },
    { label: 'Total Apps', value: stats.apps, icon: AppWindow, color: 'bg-indigo-50 text-indigo-600', href: '/apps' },
    { label: 'Forms', value: stats.forms, icon: FormInput, color: 'bg-teal-50 text-teal-600', href: '/forms' },
    { label: 'Workflow Runs', value: stats.workflows, icon: GitBranch, color: 'bg-orange-50 text-orange-600', href: '/workflows' },
    { label: 'Pending Reviews', value: stats.pendingReviews, icon: PackageCheck, color: 'bg-red-50 text-red-600', href: '/admin/apps' },
  ]

  const quickLinks = [
    { label: 'Manage Tenants', desc: 'View, activate, or suspend tenant organizations', href: '/admin/tenants', icon: Building2 },
    { label: 'Standard Graphs', desc: 'Create and publish knowledge graphs available to all tenants', href: '/admin/standard-graphs', icon: BookOpen },
    { label: 'Standard Skills', desc: 'Create and publish reusable skills for tenant agents', href: '/admin/standard-skills', icon: Wand2 },
    { label: 'App Reviews', desc: 'Review and publish app submissions from tenant developers', href: '/admin/apps', icon: PackageCheck },
    { label: 'App Builder', desc: 'Build and manage multi-step clinical workflow applications', href: '/apps/build', icon: AppWindow },
    { label: 'Form Builder', desc: 'Design JSON Schema forms with conditional logic and validation', href: '/forms/build', icon: FormInput },
    { label: 'Workflow Monitor', desc: 'Monitor all running and completed workflow instances', href: '/workflows', icon: GitBranch },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-purple-100 rounded-xl flex items-center justify-center">
          <Shield className="w-5 h-5 text-purple-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Platform Admin</h1>
          <p className="text-sm text-slate-500">Manage tenants, users, standard assets, and workflow applications</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {statCards.map(c => (
          <Link key={c.label} href={c.href} className="card p-5 hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-slate-500">{c.label}</p>
                <p className="text-3xl font-bold text-slate-900 mt-1">{c.value}</p>
              </div>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${c.color}`}>
                <c.icon className="w-5 h-5" />
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="card divide-y divide-slate-50">
        {quickLinks.map(item => (
          <Link key={item.href} href={item.href}
            className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50 transition-colors">
            <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center">
              <item.icon className="w-4 h-4 text-slate-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-900">{item.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{item.desc}</p>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </Link>
        ))}
      </div>
    </div>
  )
}
