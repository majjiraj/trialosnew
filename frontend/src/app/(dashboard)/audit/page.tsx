'use client'
import { Shield, Download, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { useEffect, useState } from 'react'

interface AuditEvent {
  eventId: string
  timestamp: string
  actorType: 'user' | 'agent' | 'system'
  actorId: string
  action: string
  resourceType: string
  resourceId?: string
  studyId?: string
  rowHash: string
  prevHash?: string
  metadata?: Record<string, any>
}

interface ChainVerification {
  orgId: string
  totalEvents: number
  chainValid: boolean
  brokenLinks: any[]
}

const actorColor: Record<string, string> = {
  user: 'text-blue-700',
  agent: 'text-purple-700',
  system: 'text-slate-500',
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chainVerification, setChainVerification] = useState<ChainVerification | null>(null)
  const [verifyingChain, setVerifyingChain] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [filters, setFilters] = useState({
    actorType: '',
    action: '',
    resourceType: '',
  })
  const [pagination, setPagination] = useState({ limit: 100, offset: 0 })

  // Get org_id from localStorage or URL params
  const getOrgId = () => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      return params.get('orgId') || localStorage.getItem('org_id') || 'default-org'
    }
    return 'default-org'
  }

  const fetchAuditEvents = async () => {
    try {
      setLoading(true)
      setError(null)
      const orgId = getOrgId()

      const query = `
        query AuditEvents(
          $orgId: String!
          $actorId: String
          $action: String
          $resourceType: String
          $limit: Int
          $offset: Int
        ) {
          auditEvents(
            orgId: $orgId
            actorId: $actorId
            action: $action
            resourceType: $resourceType
            limit: $limit
            offset: $offset
          ) {
            eventId
            timestamp
            actorType
            actorId
            action
            resourceType
            resourceId
            studyId
            rowHash
            prevHash
            metadata
          }
        }
      `

      const variables: any = {
        orgId,
        limit: pagination.limit,
        offset: pagination.offset,
      }

      if (filters.actorType) variables.actorId = filters.actorType
      if (filters.action) variables.action = filters.action
      if (filters.resourceType) variables.resourceType = filters.resourceType

      const response = await fetch('http://localhost:4000/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json()

      if (result.errors?.length) {
        throw new Error(result.errors[0].message)
      }

      setEvents(result.data?.auditEvents || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch audit events')
      console.error('Audit fetch error:', err)
    } finally {
      setLoading(false)
    }
  }

  const verifyChain = async () => {
    try {
      setVerifyingChain(true)
      const orgId = getOrgId()

      const query = `
        query VerifyChain($orgId: String!) {
          verifyAuditChain(orgId: $orgId) {
            orgId
            totalEvents
            chainValid
            brokenLinks
          }
        }
      `

      const response = await fetch('http://localhost:4000/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { orgId } }),
      })

      const result = await response.json()
      if (result.errors?.length) {
        setError(result.errors[0].message)
      } else {
        setChainVerification(result.data?.verifyAuditChain)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify chain')
    } finally {
      setVerifyingChain(false)
    }
  }

  const exportCSV = async () => {
    try {
      setExporting(true)
      const orgId = getOrgId()

      if (!events.length) {
        setError('No events to export')
        return
      }

      const headers = ['Event ID', 'Timestamp', 'Actor Type', 'Actor ID', 'Action', 'Resource Type', 'Resource ID', 'Study ID', 'Row Hash']
      const rows = events.map(e => [
        e.eventId,
        e.timestamp,
        e.actorType,
        e.actorId,
        e.action,
        e.resourceType,
        e.resourceId || '',
        e.studyId || '',
        e.rowHash,
      ])

      const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')

      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-trail-${new Date().toISOString().split('T')[0]}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export')
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    fetchAuditEvents()
  }, [pagination, filters])

  useEffect(() => {
    // Verify chain on initial load
    verifyChain()
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit Trail</h1>
          <p className="text-sm text-slate-500 mt-1">21 CFR Part 11 — write-once, hash-chained, tamper-evident</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={verifyChain}
            disabled={verifyingChain}
            className="flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {verifyingChain ? <Loader className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            {verifyingChain ? 'Verifying...' : 'Verify Chain'}
          </button>
          <button
            onClick={exportCSV}
            disabled={exporting || !events.length}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {exporting ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl border bg-red-50 border-red-200 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <div>
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
        </div>
      )}

      {chainVerification && (
        <div
          className={`p-4 rounded-xl border flex items-center gap-3 ${
            chainVerification.chainValid
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          {chainVerification.chainValid ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600" />
          )}
          <div>
            <p
              className={`text-sm font-medium ${
                chainVerification.chainValid ? 'text-green-800' : 'text-red-800'
              }`}
            >
              {chainVerification.chainValid
                ? 'Hash chain verified — audit trail is intact'
                : `⚠️ Hash chain invalid — ${chainVerification.brokenLinks.length} broken links detected`}
            </p>
            <p
              className={`text-xs mt-0.5 ${
                chainVerification.chainValid ? 'text-green-600' : 'text-red-600'
              }`}
            >
              {chainVerification.totalEvents} events verified · SHA-256 hash chain
            </p>
          </div>
        </div>
      )}

      <div className="card p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Actor Type</label>
            <select
              value={filters.actorType}
              onChange={e => {
                setFilters({ ...filters, actorType: e.target.value })
                setPagination({ limit: 100, offset: 0 })
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            >
              <option value="">All</option>
              <option value="user">User</option>
              <option value="agent">Agent</option>
              <option value="system">System</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Action</label>
            <input
              type="text"
              placeholder="Filter by action..."
              value={filters.action}
              onChange={e => {
                setFilters({ ...filters, action: e.target.value })
                setPagination({ limit: 100, offset: 0 })
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Resource Type</label>
            <select
              value={filters.resourceType}
              onChange={e => {
                setFilters({ ...filters, resourceType: e.target.value })
                setPagination({ limit: 100, offset: 0 })
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            >
              <option value="">All</option>
              <option value="agent_run">Agent Run</option>
              <option value="document">Document</option>
              <option value="approval_request">Approval</option>
              <option value="data_query">Query</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-slate-500">No audit events found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100">
              <tr>
                {['Timestamp (UTC)', 'Actor', 'Action', 'Resource', 'Study', 'Row Hash'].map(
                  h => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {events.map(e => (
                <tr key={e.eventId} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 text-xs font-mono text-slate-500 whitespace-nowrap">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium ${actorColor[e.actorType]}`}>
                      [{e.actorType}]
                    </span>
                    <p className="text-xs text-slate-700">{e.actorId}</p>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                      {e.action}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{e.resourceType}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{e.studyId || '—'}</td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-slate-400 font-mono">{e.rowHash.slice(0, 16)}...</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && events.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Showing {Math.min(pagination.offset + events.length, pagination.offset + pagination.limit)} of{' '}
            {pagination.offset + events.length} events
          </p>
          <div className="flex gap-2">
            <button
              onClick={() =>
                setPagination({
                  ...pagination,
                  offset: Math.max(0, pagination.offset - pagination.limit),
                })
              }
              disabled={pagination.offset === 0}
              className="px-3 py-1 border border-slate-200 rounded text-sm disabled:opacity-50"
            >
              ← Previous
            </button>
            <button
              onClick={() =>
                setPagination({ ...pagination, offset: pagination.offset + pagination.limit })
              }
              disabled={events.length < pagination.limit}
              className="px-3 py-1 border border-slate-200 rounded text-sm disabled:opacity-50"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
