'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Download, RefreshCw, ChevronDown } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const STUDY_GRAPH_URL   = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL   || 'http://localhost:8013'

// ─── Types ────────────────────────────────────────────────────────────────────

type KGLayer    = 'standards' | 'protocol' | 'usdm' | 'downstream'
type KGEdgeType = 'governs' | 'converts_to' | 'generates' | 'version_of'

interface KGNode {
  id: string
  layer: KGLayer
  label: string
  doc_type?: string
  version?: string
  status?: string
  document_date?: string | null
  study_id?: string | null
  study_name?: string | null
  uploaded_by_name?: string | null
  confidence?: number | null
  version_number?: number
  protocol_doc_id?: string
  metadata: Record<string, unknown>
}

interface KGEdge {
  id: string
  source: string
  target: string
  edge_type: KGEdgeType
  label: string
}

interface KGData {
  nodes: KGNode[]
  edges: KGEdge[]
  stats: {
    total_nodes: number
    standards_count: number
    cdash_count: number
    protocols_count: number
    usdm_count: number
    downstream_count: number
    total_edges: number
  }
}

interface Study { id: string; name: string; protocol_number: string; phase?: string }
interface NodePos { id: string; x: number; y: number; r: number; color: string; opacity: number; label1: string; label2?: string; node: KGNode }

// ─── Visual helpers ───────────────────────────────────────────────────────────

const DOC_LABEL: Record<string, string> = {
  usdm_ig: 'USDM IG', sdtm_ig: 'SDTM IG', adam_ig: 'ADaM IG',
  ich_guideline: 'ICH', controlled_terminology: 'CT',
  protocol: 'Protocol', crf: 'CRF', sap: 'SAP', csr: 'CSR',
  sdtm_dataset: 'SDTM', adam_dataset: 'ADaM',
  cdash_domain: 'CDASH',
}

function stdRadius(n: KGNode): number {
  switch (n.doc_type) {
    case 'usdm_ig':  return 34
    case 'sdtm_ig':  return 28
    case 'adam_ig':  return 26
    case 'ich_guideline': return 26
    case 'controlled_terminology': return 20
    case 'cdash_domain': return 14
    default: return 22
  }
}

function stdOpacity(n: KGNode): number {
  switch (n.doc_type) {
    case 'usdm_ig':  return 0.92
    case 'sdtm_ig':  return 0.78
    case 'adam_ig':  return 0.68
    case 'ich_guideline': return 0.68
    case 'cdash_domain': return 0.80
    default: return 0.55
  }
}

function sponsorRadius(n: KGNode): number {
  if (n.layer === 'protocol')   return 32
  if (n.layer === 'usdm')       return 28
  if (n.doc_type === 'crf' || n.doc_type === 'sap') return 24
  if (n.doc_type === 'csr')     return 22
  return 20
}

function sponsorColor(n: KGNode): string {
  if (n.layer === 'protocol')   return '#0EA5E9'
  if (n.layer === 'usdm')       return '#7C3AED'
  if (n.doc_type === 'crf' || n.doc_type === 'sap' || n.doc_type === 'csr') return '#B45309'
  return '#166534'
}

function sponsorOpacity(n: KGNode): number {
  if (n.layer === 'protocol') return 0.92
  if (n.layer === 'usdm')     return 0.85
  return 0.80
}

function shortLabel(name: string): string {
  return name
    .replace(/\.pdf$/i, '').replace(/\.docx?$/i, '')
    .replace(/Implementation Guide/i, 'IG')
    .replace(/Clinical Protocol/i, 'Protocol')
}

// Pre-defined organic positions for standards (left zone, viewBox 0-800)
// Indexed by node count to look natural
const STD_OFFSETS = [
  { dx:   0, dy:   0 },   // 0 = dominant (largest) always at center
  { dx: -80, dy: -85 },   // 1
  { dx:  75, dy: -70 },   // 2
  { dx: -90, dy:  75 },   // 3
  { dx:  65, dy:  90 },   // 4
  { dx: -30, dy: 130 },   // 5
  { dx:  30, dy:-130 },   // 6
  { dx: 120, dy:  10 },   // 7
]

function computePositions(
  nodes: KGNode[],
  showStandards: boolean,
  showCDASH: boolean,
  showProtocols: boolean,
  showUSDM: boolean,
  showDownstream: boolean,
  showCrosswalks: boolean,
): NodePos[] {
  const W = 800, H = 500
  const stdCX = 175, stdCY = 200   // standards cluster center (moved up slightly for CDASH grid below)
  const spCX  = 620                 // sponsor cluster horizontal center

  const allStdNodes = showStandards ? nodes.filter(n => n.layer === 'standards') : []
  const docStds  = allStdNodes.filter(n => n.doc_type !== 'cdash_domain')
  const cdashStds = showCDASH ? allStdNodes.filter(n => n.doc_type === 'cdash_domain') : []
  const protocols  = showProtocols  ? nodes.filter(n => n.layer === 'protocol')   : []
  const usdm       = showUSDM       ? nodes.filter(n => n.layer === 'usdm')       : []
  const downstream = showDownstream ? nodes.filter(n => n.layer === 'downstream') : []

  const positions: NodePos[] = []

  // Doc-based standards: organic cluster around (stdCX, stdCY)
  const sortedStd = [...docStds].sort((a, b) => stdRadius(b) - stdRadius(a))
  sortedStd.forEach((n, i) => {
    const off = STD_OFFSETS[i] ?? { dx: (i % 2 === 0 ? -1 : 1) * 40, dy: 40 + i * 20 }
    const r = stdRadius(n)
    const raw = shortLabel(n.label)
    const docTag = DOC_LABEL[n.doc_type ?? ''] ?? (n.doc_type ?? 'STD').toUpperCase()
    positions.push({
      id: n.id,
      x: Math.max(r + 10, Math.min(W / 2 - 40, stdCX + off.dx)),
      y: Math.max(r + 30, Math.min(220 - r, stdCY + off.dy)),
      r,
      color: '#1A3680',
      opacity: stdOpacity(n),
      label1: docTag,
      label2: raw !== docTag ? raw.slice(0, 20) : undefined,
      node: n,
    })
  })

  // CDASH domain nodes: compact 5-column micro-grid in lower-left of standards zone
  const CDASH_COLS = 5, CDASH_COL_GAP = 56, CDASH_ROW_GAP = 52
  const cdashStartX = 34, cdashStartY = 340
  cdashStds.forEach((n, i) => {
    const col = i % CDASH_COLS
    const row = Math.floor(i / CDASH_COLS)
    positions.push({
      id: n.id,
      x: cdashStartX + col * CDASH_COL_GAP,
      y: cdashStartY + row * CDASH_ROW_GAP,
      r: 14,
      color: '#10B981',
      opacity: 0.80,
      label1: n.label,
      node: n,
    })
  })

  // Protocols: top of sponsor zone
  protocols.forEach((n, i) => {
    const total = protocols.length
    const gap = total === 1 ? 0 : Math.min(130, 280 / (total - 1))
    const startX = spCX - (total - 1) * gap / 2
    const r = sponsorRadius(n)
    const sn = n.study_name ?? shortLabel(n.label)
    positions.push({
      id: n.id,
      x: startX + i * gap,
      y: 120,
      r,
      color: sponsorColor(n),
      opacity: sponsorOpacity(n),
      label1: sn.length > 16 ? sn.slice(0, 14) + '…' : sn,
      label2: n.version ? `v${n.version}` : undefined,
      node: n,
    })
  })

  // USDM: middle of sponsor zone
  usdm.forEach((n, i) => {
    const total = usdm.length
    const gap = total === 1 ? 0 : Math.min(140, 280 / (total - 1))
    const startX = spCX - (total - 1) * gap / 2
    const r = sponsorRadius(n)
    positions.push({
      id: n.id,
      x: startX + i * gap,
      y: 265,
      r,
      color: sponsorColor(n),
      opacity: sponsorOpacity(n),
      label1: 'USDM',
      label2: n.status === 'waiting_approval' ? 'pending' : (n.status ?? ''),
      node: n,
    })
  })

  // Downstream: bottom grid
  const dsCount = downstream.length
  const cols = Math.min(5, dsCount <= 3 ? dsCount : Math.ceil(Math.sqrt(dsCount * 1.6)))
  downstream.forEach((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const colGap = 52
    const rowGap = 46
    const startX = spCX - (Math.min(dsCount - 1, cols - 1)) * colGap / 2
    const r = sponsorRadius(n)
    const tag = DOC_LABEL[n.doc_type ?? ''] ?? n.doc_type ?? 'DOC'
    positions.push({
      id: n.id,
      x: startX + col * colGap,
      y: 390 + row * rowGap,
      r,
      color: sponsorColor(n),
      opacity: sponsorOpacity(n),
      label1: tag,
      label2: shortLabel(n.label).slice(0, 14),
      node: n,
    })
  })

  return positions
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function KnowledgeGraphPage() {
  const { user } = useAuth()
  const orgId = user?.org_id ?? '00000000-0000-0000-0000-000000000000'
  const orgName = user?.org_name ?? 'Sponsor'

  const [kgData,   setKgData]   = useState<KGData | null>(null)
  const [studies,  setStudies]  = useState<Study[]>([])
  const [studyId,  setStudyId]  = useState('')
  const [loading,  setLoading]  = useState(true)
  const [hovered,  setHovered]  = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Filter state – three sections matching spec
  const [showStandards,    setShowStandards]    = useState(true)
  const [showCDASH,        setShowCDASH]        = useState(true)
  const [showProtocols,    setShowProtocols]    = useState(true)
  const [showUSDM,         setShowUSDM]         = useState(true)
  const [showDownstream,   setShowDownstream]   = useState(true)
  const [showCrosswalks,   setShowCrosswalks]   = useState(true)
  const [showSponsorEdges, setShowSponsorEdges] = useState(true)

  // Pan & zoom
  const [zoom, setZoom] = useState(1)
  const [pan,  setPan]  = useState({ x: 0, y: 0 })
  const dragging  = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const svgRef    = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!orgId) return
    fetch(`${STUDY_GRAPH_URL}/studies?org_id=${orgId}`)
      .then(r => r.json()).then(d => setStudies(d.studies ?? [])).catch(() => {})
  }, [orgId])

  const loadKG = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const p = new URLSearchParams({ org_id: orgId })
      if (studyId) p.set('study_id', studyId)
      const res = await fetch(`${CONTEXT_GRAPH_URL}/knowledge-graph?${p}`)
      if (res.ok) setKgData(await res.json())
    } catch {} finally { setLoading(false) }
  }, [orgId, studyId])

  useEffect(() => { loadKG() }, [loadKG])

  const nodePositions = kgData
    ? computePositions(kgData.nodes, showStandards, showCDASH, showProtocols, showUSDM, showDownstream, showCrosswalks)
    : []

  const posMap = new Map(nodePositions.map(p => [p.id, p]))

  // Build visible edges
  const visibleEdges = (kgData?.edges ?? []).filter(e => {
    if (e.source === e.target) return false
    if (!posMap.has(e.source) || !posMap.has(e.target)) return false
    if (e.edge_type === 'governs' && !showCrosswalks) return false
    if ((e.edge_type === 'converts_to' || e.edge_type === 'generates' || e.edge_type === 'version_of') && !showSponsorEdges) return false
    return true
  })

  // Connected node IDs for highlight
  const connectedIds = selected ? new Set(
    visibleEdges
      .filter(e => e.source === selected || e.target === selected)
      .flatMap(e => [e.source, e.target])
  ) : null

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    setZoom(z => Math.max(0.3, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 0.91))))
  }

  function handleMouseDown(e: React.MouseEvent) {
    if ((e.target as SVGElement).closest('circle, text')) return
    dragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    setPan(p => ({ x: p.x + dx, y: p.y + dy }))
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  function handleMouseUp() { dragging.current = false }

  function handleExport() {
    if (!kgData) return
    const nodeRows = kgData.nodes.map(n =>
      [n.id, n.layer, JSON.stringify(n.label), n.doc_type ?? '', n.study_name ?? '', n.status ?? ''].join(',')
    )
    const edgeRows = kgData.edges.map(e => [e.source, e.target, e.edge_type].join(','))
    const csv = ['NODES\nid,layer,label,doc_type,study_name,status', ...nodeRows, '\nEDGES\nsource,target,type', ...edgeRows].join('\n')
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: 'knowledge-graph.csv',
    })
    a.click()
  }

  const stats = kgData?.stats
  const selectedStudy = studies.find(s => s.id === studyId)

  // Tooltip node
  const hoveredPos = hovered ? posMap.get(hovered) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#F8FAFC', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ background: 'white', borderBottom: '1px solid #E2E8F0', padding: '18px 24px 14px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', fontFamily: 'var(--font-display,DM Sans),sans-serif', margin: 0 }}>
              Knowledge Graph
            </h1>
            <p style={{ fontSize: 13, color: '#64748B', margin: '3px 0 0' }}>
              {selectedStudy
                ? `Standards + sponsor pipeline for ${selectedStudy.protocol_number}`
                : 'Standards ↔ Sponsor knowledge · compounding clinical asset'}
              {stats ? ` · ${stats.total_nodes} nodes · ${stats.total_edges} edges` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={loadKG} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #E2E8F0', background: 'white', color: '#475569', fontSize: 13, cursor: 'pointer' }}>
              <RefreshCw style={{ width: 14, height: 14 }} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button onClick={handleExport} disabled={!kgData} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#1A3680,#2563EB)', color: 'white', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
              <Download style={{ width: 14, height: 14 }} />
              Export
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ── Left filter panel (spec style) ── */}
        <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid #E2E8F0', background: 'white', overflowY: 'auto', padding: '16px' }}>

          {/* Study selector */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 7, textTransform: 'uppercase' }}>Study</div>
            <div style={{ position: 'relative' }}>
              <select value={studyId} onChange={e => setStudyId(e.target.value)}
                style={{ width: '100%', height: 32, border: '1px solid #CBD5E1', borderRadius: 7, padding: '0 24px 0 10px', fontSize: 12, color: '#1E293B', background: 'white', outline: 'none', appearance: 'none', cursor: 'pointer' }}>
                <option value="">All studies</option>
                {studies.map(s => <option key={s.id} value={s.id}>{s.protocol_number || s.name}</option>)}
              </select>
              <ChevronDown style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', width: 13, height: 13, color: '#94A3B8', pointerEvents: 'none' }} />
            </div>
          </div>

          {/* Standards section */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 7, textTransform: 'uppercase' }}>Standards</div>
            {[
              { label: 'USDM IG', key: 'showStandards' },
              { label: 'ICH M11 / Guidelines', key: 'showStandards' },
              { label: 'SDTM / ADaM IG', key: 'showStandards' },
              { label: 'Controlled Terminology', key: 'showStandards' },
            ].map(item => (
              <label key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={showStandards} onChange={() => setShowStandards(v => !v)} style={{ accentColor: '#1A3680', width: 13, height: 13 }} />
                {item.label}
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showCDASH} onChange={() => setShowCDASH(v => !v)} style={{ accentColor: '#10B981', width: 13, height: 13 }} />
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981', display: 'inline-block', flexShrink: 0 }} />
                CDASH Domains ({stats?.cdash_count ?? 0})
              </span>
            </label>
          </div>

          {/* Sponsor section */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 7, textTransform: 'uppercase' }}>Sponsor</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showProtocols} onChange={() => setShowProtocols(v => !v)} style={{ accentColor: '#0EA5E9', width: 13, height: 13 }} />
              Converted protocols
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showUSDM} onChange={() => setShowUSDM(v => !v)} style={{ accentColor: '#7C3AED', width: 13, height: 13 }} />
              USDM models
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showDownstream} onChange={() => setShowDownstream(v => !v)} style={{ accentColor: '#B45309', width: 13, height: 13 }} />
              Downstream artifacts
            </label>
          </div>

          {/* Crosswalks section */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 7, textTransform: 'uppercase' }}>Crosswalks</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showCrosswalks} onChange={() => setShowCrosswalks(v => !v)} style={{ accentColor: '#0EA5E9', width: 13, height: 13 }} />
              Standards governance
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSponsorEdges} onChange={() => setShowSponsorEdges(v => !v)} style={{ accentColor: '#64748B', width: 13, height: 13 }} />
              Sponsor internal edges
            </label>
          </div>

          {/* Stats */}
          <div style={{ borderTop: '1px solid #E9EEF5', paddingTop: 14, marginTop: 4 }}>
            {[
              { label: 'Total nodes',    val: stats?.total_nodes ?? '—' },
              { label: 'Total edges',    val: stats?.total_edges ?? '—' },
              { label: 'Standards',      val: stats?.standards_count ?? '—' },
              { label: 'CDASH domains',  val: stats?.cdash_count ?? '—' },
              { label: 'Studies',        val: studies.length || '—' },
              { label: 'USDM models',    val: stats?.usdm_count ?? '—' },
            ].map(s => (
              <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: '#94A3B8' }}>{s.label}</span>
                <span style={{ fontFamily: 'Fira Code, monospace', fontWeight: 700, color: '#0F172A' }}>{s.val}</span>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div style={{ borderTop: '1px solid #E9EEF5', paddingTop: 12, marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>Legend</div>
            {[
              { color: '#1A3680', label: 'Standards docs' },
              { color: '#10B981', label: 'CDASH domain' },
              { color: '#0EA5E9', label: 'Protocol' },
              { color: '#7C3AED', label: 'USDM model' },
              { color: '#B45309', label: 'CRF / SAP / CSR' },
              { color: '#166534', label: 'SDTM / ADaM' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: l.color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#4B5563' }}>{l.label}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, marginTop: 8 }}>
              <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#0EA5E9" strokeWidth="1.5" strokeDasharray="5,3"/></svg>
              <span style={{ fontSize: 11, color: '#4B5563' }}>Governs</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#1A3680" strokeWidth="2"/></svg>
              <span style={{ fontSize: 11, color: '#4B5563' }}>Converts to USDM</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#16a34a" strokeWidth="1.5"/></svg>
              <span style={{ fontSize: 11, color: '#4B5563' }}>Generates output</span>
            </div>
          </div>
        </div>

        {/* ── SVG Canvas ── */}
        <div style={{ flex: 1, position: 'relative', background: '#F1F5F9', overflow: 'hidden', cursor: dragging.current ? 'grabbing' : 'grab' }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(241,245,249,0.8)', zIndex: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <RefreshCw style={{ width: 24, height: 24, color: '#94A3B8', margin: '0 auto 8px', display: 'block' }} className="animate-spin" />
                <p style={{ fontSize: 13, color: '#64748B', margin: 0 }}>Loading knowledge graph…</p>
              </div>
            </div>
          )}

          <svg
            ref={svgRef}
            viewBox="0 0 800 500"
            style={{ width: '100%', height: '100%', display: 'block' }}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1" stdDeviation="3" floodOpacity="0.12"/>
              </filter>
              <marker id="arrow-crosswalk" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill="#0EA5E9" opacity="0.7"/>
              </marker>
              <marker id="arrow-converts" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill="#1A3680"/>
              </marker>
              <marker id="arrow-generates" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill="#16a34a"/>
              </marker>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>

              {/* Zone background tints */}
              <rect x="8" y="8" width="388" height="484" rx="12" fill="#E8EDF7" opacity="0.45"/>
              <rect x="408" y="8" width="384" height="484" rx="12" fill="#F0F9FF" opacity="0.45"/>

              {/* Zone vertical separator */}
              <line x1="400" y1="20" x2="400" y2="488" stroke="#C2CEDF" strokeWidth="1" strokeDasharray="4,5"/>

              {/* Zone labels */}
              <text x="60" y="30" fontSize="11" fill="#6B7787" fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.08em">STANDARDS</text>
              {showCDASH && nodePositions.some(p => p.node.doc_type === 'cdash_domain') && (
                <text x="28" y="340" fontSize="8" fill="#10B981" fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.06em" opacity="0.8">CDASH DOMAINS</text>
              )}
              <text x={460} y="30" fontSize="11" fill="#6B7787" fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.08em">
                {`SPONSOR${orgName && orgName !== 'Sponsor' ? ` (${orgName.toUpperCase()})` : ''}`}
              </text>

              {/* Sponsor tier labels */}
              {showProtocols && nodePositions.some(p => p.node.layer === 'protocol') && (
                <text x="780" y="123" fontSize="8" fill="#64748B" fontFamily="DM Sans,sans-serif" textAnchor="end" opacity="0.7">Protocol</text>
              )}
              {showUSDM && nodePositions.some(p => p.node.layer === 'usdm') && (
                <text x="780" y="268" fontSize="8" fill="#7C3AED" fontFamily="DM Sans,sans-serif" textAnchor="end" opacity="0.7">USDM JSON</text>
              )}
              {showDownstream && nodePositions.some(p => p.node.layer === 'downstream') && (
                <text x="780" y="393" fontSize="8" fill="#64748B" fontFamily="DM Sans,sans-serif" textAnchor="end" opacity="0.7">Downstream</text>
              )}

              {/* Crosswalk label */}
              {showCrosswalks && visibleEdges.some(e => e.edge_type === 'governs') && (
                <text x="400" y="150" textAnchor="middle" fontSize="9" fill="#0EA5E9" fontFamily="DM Sans,sans-serif" opacity="0.8">
                  Standards governance
                </text>
              )}

              {/* ── Edges (drawn before nodes so nodes appear on top) ── */}
              {visibleEdges.map(e => {
                const src = posMap.get(e.source)
                const tgt = posMap.get(e.target)
                if (!src || !tgt) return null

                const isHighlighted = !selected || (connectedIds?.has(e.source) && connectedIds?.has(e.target))
                const isCrosswalk   = e.edge_type === 'governs'
                const isConverts    = e.edge_type === 'converts_to'
                const isGenerates   = e.edge_type === 'generates'

                // Bezier control point: arc towards center of canvas for crosswalk edges
                const cx = isCrosswalk ? 400 : (src.x + tgt.x) / 2
                const cy = isCrosswalk
                  ? (src.y + tgt.y) / 2 - 20
                  : (src.y + tgt.y) / 2 - Math.abs(tgt.x - src.x) * 0.1

                const stroke = isCrosswalk ? '#0EA5E9' : isConverts ? '#1A3680' : isGenerates ? '#16a34a' : '#94A3B8'
                const width  = isCrosswalk ? 1 : isConverts ? 1.8 : 1.3
                const dash   = isCrosswalk ? '6,4' : undefined
                const marker = isCrosswalk ? 'url(#arrow-crosswalk)' : isConverts ? 'url(#arrow-converts)' : isGenerates ? 'url(#arrow-generates)' : undefined

                // Adjust endpoints to circle edge
                const dx = tgt.x - src.x, dy = tgt.y - src.y
                const dist = Math.sqrt(dx * dx + dy * dy) || 1
                const sx = src.x + (dx / dist) * src.r
                const sy = src.y + (dy / dist) * src.r
                const tx = tgt.x - (dx / dist) * (tgt.r + 4)
                const ty = tgt.y - (dy / dist) * (tgt.r + 4)

                return (
                  <path
                    key={e.id}
                    d={`M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={width}
                    strokeDasharray={dash}
                    opacity={isHighlighted ? (isCrosswalk ? 0.65 : 0.85) : 0.12}
                    markerEnd={marker}
                  />
                )
              })}

              {/* Standards internal cluster edges */}
              {showStandards && nodePositions.filter(p => p.node.layer === 'standards').length > 1 &&
                nodePositions
                  .filter(p => p.node.layer === 'standards')
                  .flatMap((a, i, arr) => arr.slice(i + 1, i + 2).map(b => (
                    <line
                      key={`std-${a.id}-${b.id}`}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="#CBD3DC" strokeWidth="0.8"
                      opacity={(selected && !connectedIds?.has(a.id)) ? 0.1 : 0.6}
                    />
                  )))
              }

              {/* ── Nodes ── */}
              {nodePositions.map(p => {
                const isHov = hovered === p.id
                const isSel = selected === p.id
                const isDim = selected ? (!connectedIds?.has(p.id) && p.id !== selected) : false

                return (
                  <g
                    key={p.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    style={{ cursor: 'pointer' }}
                    opacity={isDim ? 0.2 : 1}
                  >
                    {/* Invisible larger hit area — prevents flicker from geometry changes */}
                    <circle
                      cx={0} cy={0} r={p.r + 6}
                      fill="transparent"
                      onMouseEnter={() => setHovered(p.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => setSelected(s => s === p.id ? null : p.id)}
                    />
                    {/* Hover / selected outer ring — no geometry impact on the hit area */}
                    {(isHov || isSel) && (
                      <circle
                        cx={0} cy={0} r={p.r + 4}
                        fill="none"
                        stroke={isSel ? 'white' : p.color}
                        strokeWidth={isSel ? 2 : 1.5}
                        opacity={isSel ? 0.9 : 0.45}
                        pointerEvents="none"
                      />
                    )}
                    <circle
                      cx={0} cy={0} r={p.r}
                      fill={p.color}
                      opacity={p.opacity}
                      filter={isSel ? 'url(#shadow)' : undefined}
                      pointerEvents="none"
                    />
                    {/* Primary label */}
                    <text
                      x={0} y={p.label2 ? -3 : 1}
                      textAnchor="middle"
                      fontSize={Math.max(7, Math.min(12, p.r * 0.38))}
                      fill="white"
                      fontFamily="Fira Code, monospace"
                      fontWeight="600"
                      pointerEvents="none"
                    >
                      {p.label1}
                    </text>
                    {/* Secondary label */}
                    {p.label2 && (
                      <text
                        x={0} y={p.r * 0.55}
                        textAnchor="middle"
                        fontSize={Math.max(6, Math.min(10, p.r * 0.30))}
                        fill="rgba(255,255,255,0.8)"
                        fontFamily="Fira Code, monospace"
                        pointerEvents="none"
                      >
                        {p.label2}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* ── Tooltip ── */}
              {hoveredPos && (() => {
                const n  = hoveredPos.node
                const tx = hoveredPos.x > 500 ? hoveredPos.x - 170 : hoveredPos.x + hoveredPos.r + 10
                const ty = Math.max(30, Math.min(460, hoveredPos.y - 28))
                const isCDASH = n.doc_type === 'cdash_domain'
                const label = isCDASH
                  ? `${n.label} — ${String(n.metadata?.full_name ?? (n as any).full_name ?? n.label)}`
                  : shortLabel(n.label)
                const sub = isCDASH
                  ? `${n.metadata?.cdash_class ?? ''} · SDTM: ${n.metadata?.sdtm_domain ?? ''} · ${n.metadata?.field_count ?? 0} fields`
                  : [
                      n.doc_type ? (DOC_LABEL[n.doc_type] ?? n.doc_type) : null,
                      n.study_name,
                      n.version ? `v${n.version}` : null,
                      n.status,
                    ].filter(Boolean).join(' · ')
                return (
                  <g pointerEvents="none">
                    <rect x={tx} y={ty} width={165} height={sub ? 44 : 30} rx="6" fill="white" stroke="#E2E8F0" strokeWidth="1" filter="url(#shadow)"/>
                    <text x={tx + 8} y={ty + 16} fontSize="10" fontWeight="600" fill="#0F172A" fontFamily="DM Sans,sans-serif">
                      {label.length > 22 ? label.slice(0, 20) + '…' : label}
                    </text>
                    {sub && (
                      <text x={tx + 8} y={ty + 31} fontSize="9" fill="#94A3B8" fontFamily="DM Sans,sans-serif">
                        {sub.length > 28 ? sub.slice(0, 26) + '…' : sub}
                      </text>
                    )}
                  </g>
                )
              })()}

              {/* Empty state */}
              {!loading && nodePositions.length === 0 && (
                <text x="400" y="250" textAnchor="middle" fontSize="13" fill="#94A3B8" fontFamily="DM Sans,sans-serif">
                  No documents found — upload standards and protocols to populate this graph
                </text>
              )}
            </g>
          </svg>

          {/* Zoom controls */}
          <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {[
              { label: '+', onClick: () => setZoom(z => Math.min(3, z * 1.2)) },
              { label: '−', onClick: () => setZoom(z => Math.max(0.3, z / 1.2)) },
              { label: '⊙', onClick: () => { setZoom(1); setPan({ x: 0, y: 0 }) } },
            ].map(btn => (
              <button key={btn.label} onClick={btn.onClick} style={{
                width: 30, height: 30, borderRadius: 6, border: '1px solid #E2E8F0',
                background: 'white', color: '#475569', fontSize: 16, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
              }}>
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
