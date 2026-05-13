'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FileText, ChevronDown, Shield, BookOpen,
  Star, Plus, Users, Brain, Settings,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useState } from 'react'
import { useAuth } from './AuthContext'

type NavChild = { name: string; href: string; highlight?: boolean }
type NavItem = { name: string; href?: string; icon: React.ElementType; children?: NavChild[] }

const BASE_NAV: NavItem[] = [
  { name: 'Documents', href: '/documents', icon: FileText },
  {
    name: 'Standards', icon: BookOpen, children: [
      { name: 'CT Browser', href: '/standards/terminology' },
      { name: 'Regulatory', href: '/standards/regulatory' },
      { name: 'Foundation Graph', href: '/foundation-graph', highlight: true },
      { name: 'Knowledge Graph', href: '/knowledge-graph', highlight: true },
    ]
  },
  {
    name: 'Clinical Intelligence', icon: Star, children: [
      { name: 'Protocol Hub', href: '/protocols', highlight: true },
      { name: 'Protocol Lineage', href: '/protocols/lineage' },
      { name: 'Conversions', href: '/usdm', highlight: true },
    ]
  },
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

const ICON_STYLE = { strokeWidth: 1.75 }

function NavItem({ item }: { item: NavItem }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  if ('children' in item && item.children) {
    const isActive = item.children.some(c => pathname.startsWith(c.href))
    return (
      <div>
        <button
          onClick={() => setOpen(o => !o)}
          className={clsx('sidebar-nav-item w-full justify-between', isActive && 'sidebar-nav-active')}
        >
          <span className="flex items-center gap-2.5">
            <item.icon className="w-[15px] h-[15px] flex-shrink-0" style={ICON_STYLE} />
            {item.name}
          </span>
          <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform flex-shrink-0', (open || isActive) && 'rotate-180')} />
        </button>
        {(open || isActive) && (
          <div className="mt-1 ml-6 space-y-0.5">
            {item.children.map(child => (
              <Link
                key={child.href}
                href={child.href}
                className={clsx(
                  'sidebar-nav-item py-[6px]',
                  pathname === child.href ? 'sidebar-nav-active' : '',
                  child.highlight && pathname !== child.href ? 'sidebar-nav-highlight' : ''
                )}
              >
                {child.highlight && pathname !== child.href && (
                  <Plus className="w-3 h-3 flex-shrink-0" />
                )}
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
    <Link
      href={(item as any).href}
      className={clsx('sidebar-nav-item', isActive && 'sidebar-nav-active')}
    >
      <item.icon className="w-[15px] h-[15px] flex-shrink-0" style={ICON_STYLE} />
      {item.name}
    </Link>
  )
}

export function Sidebar() {
  const { user } = useAuth()

  return (
    <aside
      className="flex flex-col h-full flex-shrink-0 sidebar-hide-scrollbar"
      style={{
        width: '240px',
        background: 'linear-gradient(180deg, #0C1B3A 0%, #102556 60%, #1A3680 100%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {/* Logo */}
      <div style={{ padding: '20px 16px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: '4px' }}>
        <div className="flex items-center justify-between">
          <img
            src="/maxisai-logo-white.png"
            alt="MaxisAI"
            style={{ height: '40px', width: 'auto', maxWidth: '160px', objectFit: 'contain' }}
          />
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>v1.0</span>
        </div>
        {user?.org_name && (
          <p style={{
            fontSize: '12px', color: 'rgba(255,255,255,0.35)',
            marginTop: '8px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {user.org_name}
          </p>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {BASE_NAV.map(item => <NavItem key={item.name} item={item} />)}
        {user?.is_platform_admin && <NavItem key="admin" item={ADMIN_NAV} />}
      </nav>

      {/* Footer */}
      <div className="px-3 py-4 space-y-0.5" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        {!user?.is_platform_admin && (
          <Link href="/settings/users" className="sidebar-nav-item">
            <Users className="w-[15px] h-[15px] flex-shrink-0" style={ICON_STYLE} />
            Users
          </Link>
        )}
        <Link href="/settings/llm-providers" className="sidebar-nav-item">
          <Brain className="w-[15px] h-[15px] flex-shrink-0" style={ICON_STYLE} />
          LLM Providers
        </Link>
        <Link href="/settings" className="sidebar-nav-item">
          <Settings className="w-[15px] h-[15px] flex-shrink-0" style={ICON_STYLE} />
          Settings
        </Link>
      </div>
    </aside>
  )
}
