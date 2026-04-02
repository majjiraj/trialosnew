'use client'
import { useState, useEffect } from 'react'
import { Search, Bot, Shield, CheckCircle, Plus, GitBranch, Loader2, BarChart3 } from 'lucide-react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

const CATS = [
  { id: 'all', label: 'All Agents' },
  { id: 'data_management', label: 'Data Management' },
  { id: 'safety', label: 'Safety' },
  { id: 'site_monitoring', label: 'Site Monitoring' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'regulatory', label: 'Regulatory' },
  { id: 'medical_writing', label: 'Medical Writing' },
  { id: 'operations', label: 'Operations' },
]

async function gql(query: string, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

export default function MarketplacePage() {
  const orgId = useOrgId()
  const { user } = useAuth()
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [agents, setAgents] = useState<any[]>([])
  const [installed, setInstalled] = useState(new Set<string>())
  const [installing, setInstalling] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) return
    Promise.all([
      gql(`query { agents(orgId: "${orgId}") {
        id slug name version category description publisherType agentType
        requiredPermissions flowDefinition
      }}`),
      gql(`query { installations(orgId: "${orgId}") { agentId } }`),
    ]).then(([agentsData, instData]) => {
      setAgents(agentsData.agents || [])
      setInstalled(new Set((instData.installations || []).map((i: any) => i.agentId)))
    }).catch(console.error).finally(() => setLoading(false))
  }, [orgId])

  const filtered = agents.filter(a => {
    if (cat !== 'all' && a.category !== cat) return false
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  async function handleInstall(agent: any) {
    setInstalling(agent.slug)
    try {
      const data = await gql(`
        mutation InstallAgent($orgId: String!, $agentId: String!, $installedBy: String!, $perms: [String!]!) {
          installAgent(orgId: $orgId, agentId: $agentId, installedBy: $installedBy, consentedPermissions: $perms) { id agentId }
        }`, {
        orgId: orgId, agentId: agent.id, installedBy: user?.id ?? '00000000-0000-0000-0000-000000000002',
        perms: agent.requiredPermissions || [],
      })
      setInstalled(prev => new Set([...prev, data.installAgent.agentId]))
    } catch (e) {
      console.error('Install failed', e)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Agent Marketplace</h1>
          <p className="text-sm text-slate-500 mt-1">Install AI agents for your clinical trials</p>
        </div>
        <a href="/agents/create" className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> Create Agent
        </a>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input type="text" placeholder="Search agents..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      <div className="flex gap-6">
        <div className="w-44 space-y-1 flex-shrink-0">
          {CATS.map(c => (
            <button key={c.id} onClick={() => setCat(c.id)}
              className={clsx('w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                cat === c.id ? 'bg-brand-500 text-white font-medium' : 'text-slate-600 hover:bg-slate-100')}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex-1">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-400 py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading agents...
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-400 mb-3">{filtered.length} agents</p>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
                {filtered.map(agent => (
                  <div key={agent.slug} className="card p-5 hover:border-brand-200 transition-colors">
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-9 h-9 bg-brand-50 rounded-xl flex items-center justify-center">
                        <Bot className="w-4 h-4 text-brand-600" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {agent.flowDefinition && (
                          <Link href={`/agents/flow-view/${agent.slug}`}
                            className="flex items-center gap-1 text-xs text-brand-600 bg-brand-50 px-2 py-0.5 rounded-full font-medium hover:bg-brand-100 transition-colors">
                            <GitBranch className="w-3 h-3" /> Flow
                          </Link>
                        )}
                        <Link href={`/agents/flow-view/${agent.slug}?tab=evaluators`}
                          className="flex items-center gap-1 text-xs text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full font-medium hover:bg-purple-100 transition-colors">
                          <BarChart3 className="w-3 h-3" /> Evaluators
                        </Link>
                        <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full font-medium">
                          <Shield className="w-3 h-3" /> Native
                        </span>
                      </div>
                    </div>
                    <h3 className="font-semibold text-slate-900 text-sm leading-tight">{agent.name}</h3>
                    <p className="text-xs text-slate-500 mt-1.5 leading-relaxed line-clamp-2">{agent.description}</p>
                    <div className="flex items-center justify-between mt-4">
                      <span className="text-xs text-slate-400">v{agent.version}</span>
                      {installed.has(agent.id) ? (
                        <span className="flex items-center gap-1 text-xs text-green-700 font-medium">
                          <CheckCircle className="w-3.5 h-3.5" /> Installed
                        </span>
                      ) : (
                        <button
                          onClick={() => handleInstall(agent)}
                          disabled={installing === agent.slug}
                          className="flex items-center gap-1 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                          {installing === agent.slug
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Plus className="w-3 h-3" />}
                          Install
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
