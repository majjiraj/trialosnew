'use client'
import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { useOrgId } from '@/components/layout/AuthContext'

const INGESTION_URL   = process.env.NEXT_PUBLIC_INGESTION_URL    || 'http://localhost:8003'
const STUDY_GRAPH_URL = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL || 'http://localhost:8013'

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface Study {
  id: string
  protocol_number: string   // study-graph field name
  name: string              // study-graph field name
  phase: string
  status: string
}

interface ProtocolVersion {
  id: string
  name: string
  file_name: string
  version: string
  version_number: number
  document_date: string | null
  parent_document_id: string | null
  status: string
  sha256_hash: string
  file_size_bytes: number
  uploaded_at: string
  uploaded_by_name: string
}

interface LineageEvent {
  id: string
  document_id: string
  version: string
  version_number: number
  document_date: string | null
  file_name: string
  sha256_hash: string
  file_size_bytes: number
  uploaded_by_name: string
  uploaded_at: string
  event: string
  notes: string
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

function fmtDateShort(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function fmtDateFull(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtBytes(b: number) {
  if (!b) return ''
  return b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`
}

/** Map protocol versions to SVG x-positions (viewBox 0..900). */
function toXPositions(protocols: ProtocolVersion[]): number[] {
  const n = protocols.length
  if (n === 0) return []
  if (n === 1) return [450]
  const L = 80, R = 820
  const dates = protocols.map(p => p.document_date ? new Date(p.document_date).getTime() : null)
  const allDates = dates.every(Boolean)
  if (allDates) {
    const mn = Math.min(...(dates as number[]))
    const mx = Math.max(...(dates as number[]))
    if (mx === mn) return protocols.map((_, i) => L + (i / (n - 1)) * (R - L))
    return (dates as number[]).map(d => L + ((d - mn) / (mx - mn)) * (R - L))
  }
  return protocols.map((_, i) => L + (i / (n - 1)) * (R - L))
}

const EVENT_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  initial_upload: { label: 'UPLOADED',    color: '#0284C7', bg: '#E0F2FE', border: '#BAE6FD' },
  new_version:    { label: 'NEW VERSION', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  reprocess:      { label: 'REPROCESSED', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  reembed:        { label: 'RE-EMBEDDED', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
}

/* ─── SVG Timeline ─────────────────────────────────────────────────────────── */

function TimelineSVG({ protocols }: { protocols: ProtocolVersion[] }) {
  if (protocols.length === 0) return null
  const xs = toXPositions(protocols)
  const latest = protocols.length - 1
  const today = 876

  return (
    <div style={{ padding: '28px 32px' }}>
      {/* Protocol axis */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6478A0', marginBottom: 12 }}>
        Protocol
      </div>
      <div style={{ position: 'relative', marginBottom: 32 }}>
        <svg viewBox="0 0 900 60" style={{ width: '100%', height: 60 }}>
          {/* spine */}
          <line x1="0" y1="30" x2="900" y2="30" stroke="#C2CEDF" strokeWidth="1.5" />
          {/* nodes */}
          {protocols.map((p, i) => (
            <g key={p.id}>
              <circle
                cx={xs[i]} cy={30} r={i === latest ? 11 : 9}
                fill={i === latest ? '#0EA5E9' : '#1A3680'}
                stroke={i === latest ? '#fff' : 'none'}
                strokeWidth={i === latest ? 2 : 0}
              />
              {/* version below */}
              <text x={xs[i]} y={56} textAnchor="middle" fontSize={10}
                fill={i === latest ? '#0EA5E9' : '#6478A0'}
                fontFamily="'Fira Code', monospace"
                fontWeight={i === latest ? 700 : 400}>
                v{p.version}
              </text>
              {/* date above */}
              <text x={xs[i]} y={14} textAnchor="middle" fontSize={9}
                fill={i === latest ? '#0EA5E9' : '#6478A0'}
                fontFamily="'DM Sans', sans-serif"
                fontWeight={i === latest ? 600 : 400}>
                {fmtDateShort(p.document_date || p.uploaded_at)}
              </text>
            </g>
          ))}
          {/* TODAY line */}
          <line x1={today} y1={0} x2={today} y2={60} stroke="#0EA5E9" strokeDasharray="4,4" strokeWidth="1.5" />
          <text x={today - 2} y={11} textAnchor="end" fontSize={8} fill="#0EA5E9"
            fontFamily="'Fira Code', monospace" fontWeight={700}>TODAY</text>
        </svg>
      </div>

      {/* Field history table */}
      <div style={{ background: 'white', border: '1px solid #DDE4F0', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #DDE4F0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0C1B3A' }}>Protocol version history</span>
          <span style={{ fontSize: 12, color: '#6478A0' }}>{protocols.length} version{protocols.length !== 1 ? 's' : ''}</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Version', 'File', 'Protocol Date', 'Uploaded', 'By', 'Size', 'Status'].map(h => (
                <th key={h} style={{
                  padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6478A0',
                  background: '#EDF1F8', borderBottom: '1px solid #DDE4F0', whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...protocols].reverse().map((p, idx) => (
              <tr key={p.id} style={{ cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,165,233,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0' }}>
                  <span style={{
                    fontFamily: "'Fira Code', monospace", fontSize: 12, fontWeight: 700,
                    background: idx === 0 ? '#1A3680' : '#EDF1F8',
                    color: idx === 0 ? 'white' : '#2E4066',
                    padding: '2px 8px', borderRadius: 4,
                  }}>v{p.version}</span>
                  {idx === 0 && (
                    <span style={{
                      marginLeft: 6, fontSize: 10, fontWeight: 700,
                      background: '#ECFDF5', color: '#059669',
                      padding: '2px 7px', borderRadius: 9999,
                    }}>CURRENT</span>
                  )}
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0', color: '#0C1B3A', fontWeight: 500, maxWidth: 220 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0', fontFamily: "'Fira Code', monospace", fontSize: 12, color: '#2E4066' }}>
                  {fmtDateFull(p.document_date)}
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0', fontFamily: "'Fira Code', monospace", fontSize: 11, color: '#6478A0', whiteSpace: 'nowrap' }}>
                  {fmtDateFull(p.uploaded_at)}
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0', fontSize: 12, color: '#6478A0' }}>
                  {p.uploaded_by_name || '—'}
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0', fontSize: 12, color: '#6478A0' }}>
                  {fmtBytes(p.file_size_bytes)}
                </td>
                <td style={{ padding: '12px 14px', borderBottom: '1px solid #DDE4F0' }}>
                  <StatusDot status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── Graph View ───────────────────────────────────────────────────────────── */

function GraphView({ protocols }: { protocols: ProtocolVersion[] }) {
  if (protocols.length === 0) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: '#6478A0', fontSize: 13 }}>
      No protocol versions to display
    </div>
  )

  const n = protocols.length
  const cx = (i: number) => 120 + i * Math.min(160, 700 / Math.max(n - 1, 1))
  const cy = 140
  const latest = n - 1

  return (
    <div style={{ position: 'relative', height: 460, background: '#EDF1F8', overflow: 'hidden' }}>
      <svg viewBox="0 0 900 420" style={{ width: '100%', height: '100%' }}>
        {/* Edges */}
        {protocols.slice(0, -1).map((_, i) => (
          <g key={i}>
            <line x1={cx(i)} y1={cy} x2={cx(i + 1)} y2={cy}
              stroke="#1A3680" strokeWidth="1.5" markerEnd="url(#arrow)" />
            <text x={(cx(i) + cx(i + 1)) / 2} y={cy - 14}
              textAnchor="middle" fontSize={8} fill="#6478A0" fontFamily="'DM Sans', sans-serif">
              AMENDS
            </text>
          </g>
        ))}

        {/* Arrow marker */}
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#1A3680" />
          </marker>
          <marker id="arrow-sky" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#0EA5E9" />
          </marker>
        </defs>

        {/* Protocol nodes */}
        {protocols.map((p, i) => (
          <g key={p.id}>
            <circle cx={cx(i)} cy={cy} r={i === latest ? 22 : 18}
              fill={i === latest ? '#0EA5E9' : '#1A3680'}
              stroke={i === latest ? 'white' : 'none'}
              strokeWidth={i === latest ? 2.5 : 0} />
            <text x={cx(i)} y={cy + 4} textAnchor="middle" fontSize={10}
              fill="white" fontFamily="'Fira Code', monospace" fontWeight={700}>
              v{p.version}
            </text>
            {/* Label above */}
            <text x={cx(i)} y={cy - 30} textAnchor="middle" fontSize={9}
              fill={i === latest ? '#0EA5E9' : '#6478A0'} fontFamily="'DM Sans', sans-serif"
              fontWeight={i === latest ? 600 : 400}>
              Protocol v{p.version}
            </text>
            {/* Date below */}
            <text x={cx(i)} y={cy + 38} textAnchor="middle" fontSize={8}
              fill="#6478A0" fontFamily="'DM Sans', sans-serif">
              {fmtDateShort(p.document_date || p.uploaded_at)}
            </text>
          </g>
        ))}

        {/* Legend */}
        <circle cx={40} cy={380} r={7} fill="#1A3680" />
        <text x={54} y={384} fontSize={10} fill="#6478A0" fontFamily="'DM Sans', sans-serif">Protocol node</text>
        <circle cx={160} cy={380} r={7} fill="#0EA5E9" stroke="white" strokeWidth={2} />
        <text x={174} y={384} fontSize={10} fill="#0EA5E9" fontFamily="'DM Sans', sans-serif">Current (latest)</text>
        <line x1={290} y1={380} x2={330} y2={380} stroke="#1A3680" strokeWidth="1.5" />
        <text x={338} y={384} fontSize={10} fill="#6478A0" fontFamily="'DM Sans', sans-serif">AMENDS</text>
      </svg>

      {/* Filters overlay */}
      <div style={{
        position: 'absolute', top: 12, right: 12,
        background: 'white', border: '1px solid #DDE4F0', borderRadius: 8,
        padding: 12, fontSize: 12, minWidth: 160,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: '#0C1B3A' }}>Filters</div>
        {['AMENDS', 'DERIVED_FROM', 'EQUIVALENT_TO'].map(f => (
          <label key={f} style={{ display: 'flex', gap: 6, marginBottom: 4, color: '#2E4066', cursor: 'pointer' }}>
            <input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9' }} />
            {f}
          </label>
        ))}
      </div>
    </div>
  )
}

/* ─── Field / Event History ────────────────────────────────────────────────── */

function EventHistoryView({ protocols, orgId }: { protocols: ProtocolVersion[]; orgId: string }) {
  const [events, setEvents] = useState<LineageEvent[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (protocols.length === 0) return
    setLoading(true)
    Promise.all(
      protocols.map(p =>
        fetch(`${INGESTION_URL}/documents/${p.id}/lineage?org_id=${orgId}`)
          .then(r => r.ok ? r.json() : { lineage: [] })
          .then(d => (d.lineage || []) as LineageEvent[])
          .catch(() => [] as LineageEvent[])
      )
    ).then(results => {
      const all = results.flat().sort(
        (a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()
      )
      setEvents(all)
      setLoading(false)
    })
  }, [protocols, orgId])

  return (
    <div style={{ padding: 20 }}>
      <div style={{ fontSize: 12, color: '#6478A0', marginBottom: 16 }}>
        Showing all ingestion events for this study's protocol chain
      </div>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6478A0', padding: '32px 0' }}>
          <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
          Loading events…
        </div>
      ) : events.length === 0 ? (
        <div style={{ color: '#6478A0', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>No events recorded</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {events.map((ev, i) => {
            const badge = EVENT_BADGE[ev.event] || { label: ev.event.toUpperCase(), color: '#6478A0', bg: '#EDF1F8', border: '#C2CEDF' }
            return (
              <div key={ev.id || i} style={{
                display: 'flex', gap: 16, padding: '14px 0',
                borderBottom: i < events.length - 1 ? '1px solid #DDE4F0' : 'none',
              }}>
                <div style={{
                  minWidth: 130, fontSize: 11, fontFamily: "'Fira Code', monospace",
                  color: '#6478A0', paddingTop: 2,
                }}>
                  {fmtDateFull(ev.uploaded_at)}
                </div>
                <div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontWeight: 600, fontFamily: "'Fira Code', monospace",
                    background: badge.bg, color: badge.color,
                    border: `1px solid ${badge.border}`,
                    padding: '2px 8px', borderRadius: 9999,
                    marginBottom: 6,
                  }}>
                    {badge.label}
                  </span>
                  <div style={{ fontSize: 13, color: '#0C1B3A' }}>
                    {ev.file_name}
                    {ev.uploaded_by_name && (
                      <span style={{ color: '#6478A0', fontWeight: 400 }}> · {ev.uploaded_by_name}</span>
                    )}
                    {ev.notes && (
                      <span style={{ color: '#6478A0', fontWeight: 400 }}> · {ev.notes}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#6478A0', fontFamily: "'Fira Code', monospace", marginTop: 3 }}>
                    v{ev.version} · {ev.sha256_hash?.slice(0, 12)}…
                    {ev.document_date && <span> · Protocol date: {fmtDateFull(ev.document_date)}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─── Status dot ───────────────────────────────────────────────────────────── */

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    indexed:    { bg: '#ECFDF5', color: '#059669', label: 'Indexed' },
    processing: { bg: '#EFF6FF', color: '#2563EB', label: 'Processing' },
    pending:    { bg: '#FFFBEB', color: '#D97706', label: 'Pending' },
    error:      { bg: '#FEF2F2', color: '#DC2626', label: 'Error' },
  }
  const s = map[status] ?? { bg: '#EDF1F8', color: '#6478A0', label: status }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color,
      padding: '2px 8px', borderRadius: 9999,
      fontFamily: "'Fira Code', monospace",
    }}>
      {s.label}
    </span>
  )
}

/* ─── Main Page ─────────────────────────────────────────────────────────────── */

type Tab = 'timeline' | 'graph' | 'field'

export default function ProtocolLineagePage() {
  const orgId = useOrgId()
  const [studies, setStudies] = useState<Study[]>([])
  const [selectedStudyId, setSelectedStudyId] = useState('')
  const [protocols, setProtocols] = useState<ProtocolVersion[]>([])
  const [loadingStudies, setLoadingStudies] = useState(true)
  const [loadingProtocols, setLoadingProtocols] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('timeline')

  const loadStudies = useCallback(async () => {
    setLoadingStudies(true)
    try {
      const res = await fetch(`${STUDY_GRAPH_URL}/studies?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        const list: Study[] = data.studies || []
        setStudies(list)
        if (list.length) setSelectedStudyId(list[0].id)
      }
    } catch { /* non-fatal */ } finally {
      setLoadingStudies(false)
    }
  }, [orgId])

  const loadLineage = useCallback(async (sid: string) => {
    if (!sid) return
    setLoadingProtocols(true)
    setProtocols([])
    try {
      const res = await fetch(`${INGESTION_URL}/studies/${sid}/protocol-lineage?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setProtocols(data.protocols || [])
      }
    } catch { /* non-fatal */ } finally {
      setLoadingProtocols(false)
    }
  }, [orgId])

  useEffect(() => { loadStudies() }, [loadStudies])
  useEffect(() => { if (selectedStudyId) loadLineage(selectedStudyId) }, [selectedStudyId, loadLineage])

  const selectedStudy = studies.find(s => s.id === selectedStudyId)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'field',    label: 'Field History' },
    { id: 'graph',    label: 'Graph' },
  ]

  return (
    <div style={{ padding: '0', maxWidth: 1200 }}>
      {/* ── Page header ── */}
      <div style={{ marginBottom: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-display, "Plus Jakarta Sans", sans-serif)',
            fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em',
            color: '#0C1B3A', marginBottom: 5, lineHeight: 1.15,
          }}>
            Lineage Explorer
          </div>
          <div style={{ color: '#6478A0', fontSize: 13 }}>
            Protocol version history
            {selectedStudy && (
              <> · Study: <span style={{ fontFamily: "'Fira Code', monospace", color: '#0C1B3A' }}>
                {selectedStudy.protocol_number || selectedStudy.id}
              </span> · {selectedStudy.name}</>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            style={{
              height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: 'transparent', color: '#0C1B3A', border: '1.5px solid #C2CEDF', cursor: 'pointer',
            }}
            onClick={() => alert('PROV-O export coming soon')}
          >
            Export PROV-O
          </button>
        </div>
      </div>

      {/* ── Controls row: tabs + study filter ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        {/* View toggle */}
        <div style={{
          display: 'flex', gap: 0, border: '1px solid #C2CEDF', borderRadius: 8,
          overflow: 'hidden', width: 'fit-content',
        }}>
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                borderRight: i < tabs.length - 1 ? '1px solid #C2CEDF' : 'none',
                background: activeTab === t.id ? 'linear-gradient(135deg,#1A3680,#2563EB)' : 'white',
                color: activeTab === t.id ? 'white' : '#2E4066',
                border: 'none', transition: 'background 120ms, color 120ms',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Study select */}
        <select
          value={selectedStudyId}
          onChange={e => setSelectedStudyId(e.target.value)}
          disabled={loadingStudies}
          style={{
            height: 34, border: '1px solid #C2CEDF', borderRadius: 8,
            padding: '0 12px', fontFamily: 'inherit', fontSize: 13,
            color: '#2E4066', background: 'white', outline: 'none', cursor: 'pointer',
            minWidth: 220,
          }}
        >
          {loadingStudies ? (
            <option>Loading studies…</option>
          ) : studies.length === 0 ? (
            <option value="">No studies yet — create one in Protocol Hub</option>
          ) : (
            studies.map(s => (
              <option key={s.id} value={s.id}>
                {s.protocol_number ? `${s.protocol_number} — ` : ''}{s.name || s.id}
                {s.phase ? ` (${s.phase})` : ''}
              </option>
            ))
          )}
        </select>

        {!loadingProtocols && protocols.length > 0 && (
          <span style={{ fontSize: 12, color: '#6478A0' }}>
            {protocols.length} version{protocols.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {!loadingStudies && studies.length === 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10,
          padding: '12px 16px', marginBottom: 8,
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span style={{ fontSize: 13, color: '#1E40AF' }}>
            No studies found. Create a study first in{' '}
            <a href="/protocols" style={{ color: '#2563EB', fontWeight: 600, textDecoration: 'underline' }}>Protocol Hub</a>
            , then upload a protocol to see lineage here.
          </span>
        </div>
      )}

      {/* ── Panel ── */}
      <div style={{
        background: 'white', border: '1px solid #DDE4F0', borderRadius: 14,
        overflow: 'hidden', transition: 'box-shadow 200ms',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #DDE4F0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'white',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0C1B3A', letterSpacing: '-0.01em' }}>
            {activeTab === 'timeline' && <>Protocol &amp; version timeline{selectedStudy && <> · <span style={{ fontFamily: "'Fira Code', monospace" }}>{selectedStudy.protocol_number || ''}</span></>}</>}
            {activeTab === 'graph'    && <>Lineage Graph{selectedStudy && <> · {selectedStudy.protocol_number || ''}</>}</>}
            {activeTab === 'field'    && 'Field History · all events'}
          </span>
          {activeTab === 'timeline' && (
            <span style={{ fontSize: 12, color: '#6478A0' }}>Scroll to zoom · click node for details</span>
          )}
          {activeTab === 'graph' && protocols.length > 0 && (
            <div style={{ display: 'flex', gap: 8 }}>
              {['Force', 'Hierarchical', 'Fit view'].map(b => (
                <button key={b} style={{
                  height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: 'transparent', color: '#0C1B3A', border: '1.5px solid #C2CEDF', cursor: 'pointer',
                }}>{b}</button>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        {loadingProtocols ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '64px 0', color: '#6478A0' }}>
            <Loader2 style={{ width: 20, height: 20, animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 13 }}>Loading lineage…</span>
          </div>
        ) : !selectedStudyId ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: '#6478A0', fontSize: 13 }}>
            Select a study to view its protocol lineage
          </div>
        ) : protocols.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: '#6478A0', fontSize: 13 }}>
            No protocols uploaded for this study yet
          </div>
        ) : (
          <>
            {activeTab === 'timeline' && <TimelineSVG protocols={protocols} />}
            {activeTab === 'graph'    && <GraphView protocols={protocols} />}
            {activeTab === 'field'    && <EventHistoryView protocols={protocols} orgId={orgId} />}
          </>
        )}
      </div>
    </div>
  )
}
