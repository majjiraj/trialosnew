'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, FlaskConical, Bot, Store, ShieldCheck, FileText, Settings, Plus, ChevronDown, Shield, Users, Brain, Library, ListTodo, MessageSquare, BarChart2, GitBranch } from 'lucide-react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { useAuth } from './AuthContext'

type NavChild = { name: string; href: string; highlight?: boolean }
type NavItem = { name: string; href?: string; icon: React.ElementType; children?: NavChild[] }

const BASE_NAV: NavItem[] = [
  { name: 'Command Center', href: '/', icon: LayoutDashboard },
  { name: 'My Dashboard', href: '/dashboard', icon: LayoutDashboard },
  {
    name: 'Widgets', icon: BarChart2, children: [
      { name: 'Widget Library', href: '/widgets' },
      { name: 'Create Widget', href: '/widgets/new', highlight: true },
    ]
  },
  { name: 'Documents', href: '/documents', icon: FileText },
  { name: 'Conversations', href: '/conversations', icon: MessageSquare },
  {
    name: 'Agents', icon: Bot, children: [
      { name: 'Agent Console', href: '/agents' },
      { name: 'Vibe Builder', href: '/agents/vibe', highlight: true },
      { name: 'Build Agent', href: '/agents/build' },
      { name: 'Approval Queue', href: '/tasks' },
    ]
  },
  {
    name: 'Skills', icon: Library, children: [
      { name: 'Skills Library', href: '/agents/skills' },
      { name: 'Create Skill', href: '/agents/skills?new=1', highlight: true },
    ]
  },
  { name: 'Marketplace', href: '/marketplace', icon: Store },
  {
    name: 'Tasks', icon: ListTodo, children: [
      { name: 'My Tasks', href: '/tasks' },
      { name: 'All Workflows', href: '/workflows' },
    ]
  },
  { name: 'Context Graph', href: '/context-graph', icon: GitBranch },
  { name: 'Audit Trail', href: '/audit', icon: ShieldCheck },
  { name: 'Data Generator', href: '/data-generator', icon: FlaskConical },
]

const ADMIN_NAV: NavItem = {
  name: 'Admin', icon: Shield, children: [
    { name: 'Overview', href: '/admin' },
    { name: 'Tenants', href: '/admin/tenants' },
    { name: 'Standard Graphs', href: '/admin/standard-graphs' },
    { name: 'App Reviews', href: '/admin/apps' },
    { name: 'Form Builder', href: '/forms/build', highlight: true },
    { name: 'Workflow Monitor', href: '/workflows' },
  ]
}

function NavItem({ item }: { item: NavItem }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  if ('children' in item && item.children) {
    const isActive = item.children.some(c => pathname.startsWith(c.href))
    return (
      <div>
        <button onClick={() => setOpen(o => !o)} className={clsx(
          'w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
        )}>
          <span className="flex items-center gap-2.5"><item.icon className="w-4 h-4" />{item.name}</span>
          <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', (open || isActive) && 'rotate-180')} />
        </button>
        {(open || isActive) && (
          <div className="mt-1 ml-6 space-y-0.5">
            {item.children.map(child => (
              <Link key={child.href} href={child.href} className={clsx(
                'block px-3 py-1.5 rounded-lg text-sm transition-colors',
                pathname === child.href ? 'bg-brand-500 text-white font-medium' : 'text-slate-600 hover:bg-slate-100',
                'highlight' in child && child.highlight && pathname !== child.href && 'text-brand-600 font-medium'
              )}>
                {'highlight' in child && child.highlight && <Plus className="w-3 h-3 inline mr-1" />}
                {child.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    )
  }

  const isActive = 'href' in item && pathname === item.href
  return (
    <Link href={(item as any).href} className={clsx(
      'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
      isActive ? 'bg-brand-500 text-white' : 'text-slate-600 hover:bg-slate-100'
    )}>
      <item.icon className="w-4 h-4" />{item.name}
    </Link>
  )
}

export function Sidebar() {
  const { user } = useAuth()

  return (
    <aside className="w-56 bg-white border-r border-slate-200 flex flex-col h-full flex-shrink-0">
      <div className="px-4 py-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-500 rounded-lg flex items-center justify-center">
            <FlaskConical className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-slate-900">TrialOS</span>
          <span className="text-xs text-slate-400 ml-auto">v1.0</span>
        </div>
        {user?.org_name && (
          <p className="text-xs text-slate-400 truncate mt-1 pl-9">{user.org_name}</p>
        )}
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {BASE_NAV.map(item => <NavItem key={item.name} item={item} />)}
        {user?.is_platform_admin && <NavItem key="admin" item={ADMIN_NAV} />}
      </nav>
      <div className="px-3 py-4 border-t border-slate-200 space-y-0.5">
        {!user?.is_platform_admin && (
          <Link href="/settings/users" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
            <Users className="w-4 h-4" />Users
          </Link>
        )}
        <Link href="/settings/llm-providers" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
          <Brain className="w-4 h-4" />LLM Providers
        </Link>
        <Link href="/settings" className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
          <Settings className="w-4 h-4" />Settings
        </Link>
      </div>
    </aside>
  )
}
