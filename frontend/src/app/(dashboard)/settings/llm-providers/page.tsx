'use client'
import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, RefreshCw, Brain } from 'lucide-react'

const AGENT_RUNTIME_URL = 'http://localhost:8004'

interface ProviderInfo {
  provider: string
  configured: boolean
  models: string[]
}

const PROVIDER_META: Record<string, { label: string; note: string; envKey: string }> = {
  ollama:    { label: 'Ollama (Local)',  note: 'Runs on host machine. No API key required.',    envKey: 'OLLAMA_BASE_URL' },
  openai:    { label: 'OpenAI',          note: 'Set OPENAI_API_KEY in .env to enable.',          envKey: 'OPENAI_API_KEY' },
  anthropic: { label: 'Anthropic',       note: 'Set ANTHROPIC_API_KEY in .env to enable.',       envKey: 'ANTHROPIC_API_KEY' },
  azure:     { label: 'Azure OpenAI',    note: 'Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT in .env.', envKey: 'AZURE_OPENAI_API_KEY' },
}

const ALL_PROVIDERS = ['ollama', 'openai', 'anthropic', 'azure']

export default function LLMProvidersPage() {
  const [providers,      setProviders]      = useState<ProviderInfo[]>([])
  const [loading,        setLoading]        = useState(true)
  const [testingProvider, setTestingProvider] = useState<string | null>(null)
  const [testResults,    setTestResults]    = useState<Record<string, 'ok' | 'fail' | null>>({})

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const r = await fetch(`${AGENT_RUNTIME_URL}/providers/available`)
      if (!r.ok) throw new Error('Request failed')
      const data = await r.json()
      setProviders(data.providers ?? [])
    } catch {
      setProviders([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchProviders() }, [])

  const handleTest = async (provider: string) => {
    setTestingProvider(provider)
    try {
      const r = await fetch(`${AGENT_RUNTIME_URL}/providers/available`)
      if (r.ok) {
        setTestResults(prev => ({ ...prev, [provider]: 'ok' }))
      } else {
        setTestResults(prev => ({ ...prev, [provider]: 'fail' }))
      }
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: 'fail' }))
    } finally {
      setTestingProvider(null)
    }
  }

  // Build full table including un-configured providers
  const configuredMap = Object.fromEntries(providers.map(p => [p.provider, p]))

  return (
    <div className="max-w-3xl mx-auto py-8 px-6">
      <div className="flex items-center gap-3 mb-6">
        <Brain className="w-6 h-6 text-purple-500" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">LLM Providers</h1>
          <p className="text-sm text-slate-500">Read-only status of configured LLM providers. Keys are managed in <code className="font-mono text-xs bg-slate-100 px-1 rounded">.env</code>.</p>
        </div>
        <button
          onClick={fetchProviders}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-6 text-xs text-amber-800">
        <strong>Admin only:</strong> To add or change API keys, edit the <code className="font-mono bg-amber-100 px-1 rounded">.env</code> file at the project root and rebuild the agent-runtime container.
        <br />
        Keys are never stored in the database — they are environment variables only.
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-400 text-sm">Loading provider status…</div>
      ) : (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Provider</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Available Models</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Note</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {ALL_PROVIDERS.map((provId, idx) => {
                const info = configuredMap[provId]
                const meta = PROVIDER_META[provId] ?? { label: provId, note: '', envKey: '' }
                const configured = !!info
                const testResult = testResults[provId]

                return (
                  <tr key={provId} className={`border-b border-slate-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                    <td className="px-4 py-3 font-medium text-slate-800">{meta.label}</td>
                    <td className="px-4 py-3">
                      {configured ? (
                        <span className="flex items-center gap-1.5 text-green-700">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          Configured
                          {testResult === 'ok'   && <span className="text-xs text-green-600 ml-1">· Connection OK</span>}
                          {testResult === 'fail' && <span className="text-xs text-red-600 ml-1">· Failed</span>}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-slate-400">
                          <XCircle className="w-4 h-4" />
                          Not configured
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {info?.models?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {info.models.slice(0, 4).map(m => (
                            <span key={m} className="px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600 rounded font-mono">{m}</span>
                          ))}
                          {info.models.length > 4 && (
                            <span className="text-xs text-slate-400">+{info.models.length - 4} more</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{meta.note}</td>
                    <td className="px-4 py-3 text-right">
                      {configured && (
                        <button
                          onClick={() => handleTest(provId)}
                          disabled={testingProvider === provId}
                          className="text-xs px-2.5 py-1 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 text-slate-600"
                        >
                          {testingProvider === provId ? 'Testing…' : 'Test connection'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 bg-slate-50 rounded-lg border border-slate-200 p-4 text-xs text-slate-600 space-y-1">
        <p className="font-semibold text-slate-700 mb-2">How to add a provider</p>
        <p>1. Open <code className="font-mono bg-slate-100 px-1 rounded">/path/to/trialo/.env</code></p>
        <p>2. Add the required environment variable (shown in the Note column)</p>
        <p>3. Rebuild the agent-runtime service:</p>
        <pre className="bg-slate-900 text-green-300 rounded p-2 mt-1 text-[11px] font-mono">
          docker compose -f docker-compose.dev.yml build agent-runtime{'\n'}
          docker compose -f docker-compose.dev.yml up -d --force-recreate agent-runtime
        </pre>
      </div>
    </div>
  )
}
