'use client'
import { useState } from 'react'
import ChartPreview from './ChartPreview'
import type { DataSourceConfig } from './DataSourcePicker'

interface ChartBlockRuntimeProps {
  label: string
  chartType: 'bar' | 'line' | 'pie' | 'scatter'
  dataSource: DataSourceConfig
  orgId: string
  studyId?: string
}

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const ACTIVE_STATUSES = new Set(['running', 'pending'])

async function gql(query: string, variables = {}) {
  const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

async function pollUntilDone(runId: string): Promise<{ status: string; outputSummary: string; errorMessage: string }> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const d = await gql(`query($runId: String!) { agentRunDetail(runId: $runId) { id status outputSummary errorMessage } }`, { runId })
        const run = d.agentRunDetail
        if (!ACTIVE_STATUSES.has(run.status)) {
          clearInterval(interval)
          resolve(run)
        }
      } catch (e) {
        clearInterval(interval)
        reject(e)
      }
    }, 2000)
  })
}

export default function ChartBlockRuntime({ label, chartType, dataSource, orgId, studyId }: ChartBlockRuntimeProps) {
  const [chartData, setChartData] = useState<Array<{ label: string; value: number }> | null>(
    dataSource.type === 'static' ? dataSource.data : null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const fetchData = async () => {
    if (dataSource.type === 'static') return
    setLoading(true)
    setError(undefined)
    try {
      if (dataSource.type === 'agent') {
        const query = dataSource.queryTemplate.replace(/\{\{studyId\}\}/g, studyId || '')
        const runData = await gql(`
          mutation($installationId: ID!, $userInput: String!, $orgId: ID!, $studyId: String) {
            startAgentRun(installationId: $installationId, input: $userInput, orgId: $orgId, studyId: $studyId) { id }
          }
        `, { installationId: dataSource.agentInstallationId, userInput: query, orgId, studyId: studyId || null })
        const runId = runData.startAgentRun?.id
        if (!runId) throw new Error('Failed to start agent run')
        const run = await pollUntilDone(runId)
        if (run.status !== 'completed') throw new Error(run.errorMessage || 'Agent run failed')
        try {
          const parsed = JSON.parse(run.outputSummary)
          setChartData(Array.isArray(parsed) ? parsed : parsed.data || parsed.results || [])
        } catch {
          throw new Error(`Could not parse chart data from agent response: ${run.outputSummary?.slice(0, 200)}`)
        }
      } else if (dataSource.type === 'database') {
        // For database type, build a natural language query and use context graph or agent
        const queryText = `${dataSource.dataType.toUpperCase()} ${dataSource.domain} data for study ${dataSource.studyId || studyId || 'current'}`
        // We'll show a placeholder since direct DB query requires an agent installation
        throw new Error(`Database queries require an agent. Query: "${queryText}"`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border border-orange-200 rounded-xl p-4" style={{ borderLeftWidth: 4, borderLeftColor: '#f97316' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-orange-800">{label}</h3>
        {dataSource.type !== 'static' && (
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-1.5 bg-orange-500 text-white text-xs rounded hover:bg-orange-600 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Fetching...' : 'Fetch Data'}
          </button>
        )}
      </div>
      <ChartPreview
        chartType={chartType}
        data={chartData}
        title={label}
        loading={loading}
        error={error}
      />
    </div>
  )
}
