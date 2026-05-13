'use client'
import { useState, useEffect, useRef } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CDASHDomain {
  id: string
  code: string
  name: string
  class: string
  sdtm_domain: string
  field_count: number
  description: string
  sdtm_node_id?: string | null
}

interface DomainPos {
  id: string
  x: number
  y: number
  r: number
  color: string
  label: string
  fullName: string
  cdashClass: string
  sdtmTarget: string
  fieldCount: number
  description: string
  isSDTM?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CDASH_CLASSES = ['Events', 'Findings', 'Interventions', 'Special Purpose'] as const

const CLASS_COLOR: Record<string, string> = {
  'Events':          '#EF4444',
  'Findings':        '#0D9488',
  'Interventions':   '#7C3AED',
  'Special Purpose': '#D97706',
}

const CLASS_BG: Record<string, string> = {
  'Events':          '#FEF2F2',
  'Findings':        '#F0FDFA',
  'Interventions':   '#F5F3FF',
  'Special Purpose': '#FFFBEB',
}

const VB_W = 840, VB_H = 580

// ─── Layout ───────────────────────────────────────────────────────────────────

function computeLayout(
  byClass: Record<string, CDASHDomain[]>,
  activeClasses: Set<string>,
): DomainPos[] {
  const positions: DomainPos[] = []

  // Collect unique SDTM targets visible in filtered domains
  const sdtmSet = new Set<string>()
  for (const cls of CDASH_CLASSES) {
    if (!activeClasses.has(cls)) continue
    for (const d of byClass[cls] ?? []) sdtmSet.add(d.sdtm_domain)
  }
  const sdtmList = [...sdtmSet].sort()

  // Right zone: SDTM target circles at x=710
  const sdtmY0 = 60, sdtmGap = sdtmList.length > 1 ? Math.min(52, (VB_H - 100) / (sdtmList.length - 1)) : 0
  const sdtmPosMap: Record<string, { x: number; y: number }> = {}
  sdtmList.forEach((code, i) => {
    const y = sdtmY0 + i * sdtmGap
    sdtmPosMap[code] = { x: 710, y }
    positions.push({
      id: `sdtm-${code}`, x: 710, y, r: 18,
      color: '#1A3680', label: code,
      fullName: code, cdashClass: '', sdtmTarget: code,
      fieldCount: 0, description: '',
      isSDTM: true,
    })
  })

  // Left zone: CDASH domains grouped by class
  let leftY = 32
  for (const cls of CDASH_CLASSES) {
    if (!activeClasses.has(cls)) continue
    const domains = byClass[cls] ?? []
    if (!domains.length) continue

    // Class header band
    const cols = 2, colGap = 130, rowGap = 58
    const rows = Math.ceil(domains.length / cols)
    const clsH = rows * rowGap + 24

    // Class section background rectangle (drawn via SVG in the render)
    // position class label at leftY
    domains.forEach((d, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const x = 55 + col * colGap
      const y = leftY + 28 + row * rowGap
      positions.push({
        id: d.id, x, y, r: 14,
        color: CLASS_COLOR[cls] ?? '#64748B',
        label: d.code, fullName: d.name,
        cdashClass: cls, sdtmTarget: d.sdtm_domain,
        fieldCount: d.field_count, description: d.description,
      })
    })
    leftY += clsH + 14
  }

  return positions
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CdashBrowserPage() {
  const { user } = useAuth()

  const [domains,      setDomains]      = useState<CDASHDomain[]>([])
  const [byClass,      setByClass]      = useState<Record<string, CDASHDomain[]>>({})
  const [loading,      setLoading]      = useState(true)
  const [seeding,      setSeeding]      = useState(false)
  const [seedMsg,      setSeedMsg]      = useState('')
  const [activeClasses, setActiveClasses] = useState<Set<string>>(new Set(CDASH_CLASSES))
  const [hovered,      setHovered]      = useState<string | null>(null)
  const [selected,     setSelected]     = useState<string | null>(null)
  const [zoom,         setZoom]         = useState(1)
  const [pan,          setPan]          = useState({ x: 0, y: 0 })
  const dragging  = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })

  const loadDomains = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/standards/cdash-domains`)
      if (res.ok) {
        const data = await res.json()
        setDomains(data.domains ?? [])
        setByClass(data.by_class ?? {})
      }
    } catch {} finally { setLoading(false) }
  }

  useEffect(() => { loadDomains() }, [])

  const handleSeed = async () => {
    setSeeding(true)
    setSeedMsg('')
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/standards/seed-cdash`, { method: 'POST' })
      const data = await res.json()
      setSeedMsg(`Seeded ${data.seeded} domains (${data.edges_linked} SDTM links). Reloading…`)
      await loadDomains()
    } catch (e) {
      setSeedMsg('Seed failed — check context-graph service')
    } finally { setSeeding(false) }
  }

  const positions = computeLayout(byClass, activeClasses)
  const posMap    = new Map(positions.map(p => [p.id, p]))

  // Selected domain info
  const selPos    = selected ? posMap.get(selected) : null
  const selDomain = selPos && !selPos.isSDTM
    ? domains.find(d => d.id === selected) ?? null
    : null

  // For a selected non-SDTM node, find its SDTM target position
  const sdtmTargetId = selDomain ? `sdtm-${selDomain.sdtm_domain}` : null

  function toggleClass(cls: string) {
    setActiveClasses(prev => {
      const next = new Set(prev)
      next.has(cls) ? next.delete(cls) : next.add(cls)
      return next
    })
  }

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
    setPan(p => ({ x: p.x + e.clientX - lastMouse.current.x, y: p.y + e.clientY - lastMouse.current.y }))
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }
  function handleMouseUp() { dragging.current = false }

  // Class section bands for background rects
  const classBands: { cls: string; y: number; h: number }[] = []
  let bandY = 32
  for (const cls of CDASH_CLASSES) {
    if (!activeClasses.has(cls)) continue
    const ds = byClass[cls] ?? []
    if (!ds.length) continue
    const rows = Math.ceil(ds.length / 2)
    const h = rows * 58 + 24
    classBands.push({ cls, y: bandY, h })
    bandY += h + 14
  }

  const totalDomains = domains.length
  const totalFields  = domains.reduce((s, d) => s + (d.field_count ?? 0), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#F8FAFC', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ background: 'white', borderBottom: '1px solid #E2E8F0', padding: '18px 24px 14px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', fontFamily: 'var(--font-display,DM Sans),sans-serif', margin: 0 }}>
                CDASH Model v1.1.0
              </h1>
              <span style={{ fontSize: 11, background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>
                CDISC Foundational
              </span>
              <a href="https://www.cdisc.org/standards/foundational/cdash" target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#2563EB', textDecoration: 'none' }}>
                <ExternalLink style={{ width: 12, height: 12 }} />
                cdisc.org
              </a>
            </div>
            <p style={{ fontSize: 13, color: '#64748B', margin: '3px 0 0' }}>
              {totalDomains > 0
                ? `${totalDomains} domains · ${totalFields.toLocaleString()} total fields · 4 CDASH classes`
                : 'Clinical Data Acquisition Standards Harmonization — domain browser'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {seedMsg && <span style={{ fontSize: 12, color: '#15803D' }}>{seedMsg}</span>}
            {totalDomains === 0 && (
              <button onClick={handleSeed} disabled={seeding} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#10B981', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {seeding ? 'Seeding…' : 'Seed CDASH Data'}
              </button>
            )}
            <button onClick={loadDomains} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #E2E8F0', background: 'white', color: '#475569', fontSize: 13, cursor: 'pointer' }}>
              <RefreshCw style={{ width: 14, height: 14 }} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ── Left panel ── */}
        <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid #E2E8F0', background: 'white', overflowY: 'auto', padding: '14px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>CDASH Classes</div>
          {CDASH_CLASSES.map(cls => {
            const count = byClass[cls]?.length ?? 0
            const on = activeClasses.has(cls)
            return (
              <label key={cls} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => toggleClass(cls)}
                  style={{ accentColor: CLASS_COLOR[cls], width: 13, height: 13 }} />
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: CLASS_COLOR[cls], display: 'inline-block', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{cls}</span>
                <span style={{ fontFamily: 'Fira Code, monospace', fontSize: 11, color: '#94A3B8' }}>{count}</span>
              </label>
            )
          })}

          <div style={{ borderTop: '1px solid #E9EEF5', marginTop: 14, paddingTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>Legend</div>
            {CDASH_CLASSES.map(cls => (
              <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: CLASS_COLOR[cls], flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#4B5563' }}>{cls}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, marginBottom: 4 }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#1A3680', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#4B5563' }}>SDTM target domain</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
              <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#94A3B8" strokeWidth="1.5" strokeDasharray="4,3"/></svg>
              <span style={{ fontSize: 11, color: '#4B5563' }}>maps_to SDTM</span>
            </div>
          </div>

          {/* Detail panel when a domain is selected */}
          {selDomain && (
            <div style={{ borderTop: '1px solid #E9EEF5', marginTop: 14, paddingTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>Selected</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 18, fontFamily: 'Fira Code, monospace', fontWeight: 700, color: CLASS_COLOR[selDomain.class] }}>{selDomain.code}</span>
                <span style={{ fontSize: 11, background: CLASS_BG[selDomain.class], color: CLASS_COLOR[selDomain.class], border: `1px solid ${CLASS_COLOR[selDomain.class]}33`, borderRadius: 5, padding: '1px 6px', fontWeight: 600 }}>{selDomain.class}</span>
              </div>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#0F172A', margin: '0 0 4px' }}>{selDomain.name}</p>
              <p style={{ fontSize: 11, color: '#64748B', margin: '0 0 8px', lineHeight: 1.4 }}>{selDomain.description}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: '#94A3B8' }}>SDTM target</span>
                <span style={{ fontFamily: 'Fira Code, monospace', fontWeight: 700, color: '#1A3680' }}>{selDomain.sdtm_domain}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: '#94A3B8' }}>Field count</span>
                <span style={{ fontFamily: 'Fira Code, monospace', fontWeight: 700, color: '#0F172A' }}>{selDomain.field_count}</span>
              </div>
            </div>
          )}
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
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(241,245,249,0.85)', zIndex: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <RefreshCw style={{ width: 24, height: 24, color: '#94A3B8', margin: '0 auto 8px', display: 'block' }} className="animate-spin" />
                <p style={{ fontSize: 13, color: '#64748B', margin: 0 }}>Loading CDASH domains…</p>
              </div>
            </div>
          )}

          {!loading && totalDomains === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <p style={{ fontSize: 14, color: '#64748B', margin: 0 }}>CDASH domains not yet seeded</p>
              <button onClick={handleSeed} disabled={seeding} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#10B981', color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {seeding ? 'Seeding…' : 'Seed CDASH Model v1.1.0'}
              </button>
            </div>
          )}

          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            style={{ width: '100%', height: '100%', display: 'block' }}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="1" stdDeviation="3" floodOpacity="0.12"/>
              </filter>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>

              {/* Zone backgrounds */}
              <rect x="8" y="8" width="395" height={VB_H - 16} rx="12" fill="#F8FAFC" opacity="0.6"/>
              <rect x="415" y="8" width={VB_W - 423} height={VB_H - 16} rx="12" fill="#EFF6FF" opacity="0.5"/>

              {/* Zone separator */}
              <line x1="408" y1="20" x2="408" y2={VB_H - 20} stroke="#C2CEDF" strokeWidth="1" strokeDasharray="4,5"/>

              {/* Zone labels */}
              <text x="20" y="22" fontSize="10" fill="#6B7787" fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.08em">CDASH MODEL v1.1.0</text>
              <text x="420" y="22" fontSize="10" fill="#6B7787" fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.08em">SDTM TARGET DOMAINS</text>

              {/* Class section background bands */}
              {classBands.map(({ cls, y, h }) => (
                <rect key={cls} x="14" y={y} width="380" height={h} rx="6"
                  fill={CLASS_BG[cls]} opacity="0.7"
                  stroke={CLASS_COLOR[cls]} strokeWidth="0.5" strokeOpacity="0.3"
                />
              ))}

              {/* Class labels */}
              {classBands.map(({ cls, y }) => (
                <text key={`lbl-${cls}`} x="20" y={y + 14} fontSize="8.5"
                  fill={CLASS_COLOR[cls]} fontFamily="DM Sans,sans-serif" fontWeight="700" letterSpacing="0.06em">
                  {cls.toUpperCase()}
                </text>
              ))}

              {/* ── Edges (maps_to: CDASH → SDTM) ── */}
              {positions.filter(p => !p.isSDTM).map(p => {
                const sdtmPos = posMap.get(`sdtm-${p.sdtmTarget}`)
                if (!sdtmPos) return null
                const isHighlighted = !selected || selected === p.id || sdtmTargetId === `sdtm-${p.sdtmTarget}`
                const mx = (p.x + sdtmPos.x) / 2 + 60
                const my = (p.y + sdtmPos.y) / 2
                return (
                  <path key={`e-${p.id}`}
                    d={`M ${p.x + p.r} ${p.y} Q ${mx} ${my} ${sdtmPos.x - sdtmPos.r} ${sdtmPos.y}`}
                    fill="none"
                    stroke={p.color}
                    strokeWidth={selected === p.id ? 1.5 : 1}
                    strokeDasharray="5,4"
                    opacity={isHighlighted ? (selected === p.id ? 0.85 : 0.35) : 0.08}
                  />
                )
              })}

              {/* ── Nodes ── */}
              {positions.map(p => {
                const isHov = hovered === p.id
                const isSel = selected === p.id
                const isDim = selected
                  ? !isSel && (p.isSDTM ? sdtmTargetId !== p.id : selected !== p.id)
                  : false

                return (
                  <g key={p.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    style={{ cursor: 'pointer' }}
                    opacity={isDim ? 0.2 : 1}
                  >
                    <circle cx={0} cy={0} r={p.r + 6} fill="transparent"
                      onMouseEnter={() => setHovered(p.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => setSelected(s => s === p.id ? null : p.id)}
                    />
                    {(isHov || isSel) && (
                      <circle cx={0} cy={0} r={p.r + 4} fill="none"
                        stroke={isSel ? 'white' : p.color}
                        strokeWidth={isSel ? 2 : 1.5}
                        opacity={isSel ? 0.9 : 0.45}
                        pointerEvents="none"
                      />
                    )}
                    <circle cx={0} cy={0} r={p.r}
                      fill={p.color}
                      opacity={p.isSDTM ? 0.82 : 0.85}
                      filter={isSel ? 'url(#shadow)' : undefined}
                      pointerEvents="none"
                    />
                    <text x={0} y={1} textAnchor="middle"
                      fontSize={p.isSDTM ? 7.5 : 6.5}
                      fill="white"
                      fontFamily="Fira Code, monospace"
                      fontWeight="700"
                      pointerEvents="none"
                    >
                      {p.label}
                    </text>
                    {/* Domain name label to the right of CDASH circles */}
                    {!p.isSDTM && (
                      <text x={p.r + 4} y={1} textAnchor="start"
                        fontSize="7"
                        fill="#374151"
                        fontFamily="DM Sans,sans-serif"
                        pointerEvents="none"
                      >
                        {p.fullName.length > 18 ? p.fullName.slice(0, 16) + '…' : p.fullName}
                      </text>
                    )}
                    {/* Field count below SDTM circles */}
                    {p.isSDTM && (
                      <text x={0} y={p.r + 10} textAnchor="middle"
                        fontSize="7"
                        fill="#64748B"
                        fontFamily="DM Sans,sans-serif"
                        pointerEvents="none"
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* ── Tooltip ── */}
              {hovered && (() => {
                const p = posMap.get(hovered)
                if (!p) return null
                const tx = p.x > 500 ? p.x - 175 : p.x + p.r + 10
                const ty = Math.max(30, Math.min(VB_H - 60, p.y - 28))
                const line1 = p.isSDTM ? `SDTM: ${p.label}` : `${p.label} — ${p.fullName}`
                const line2 = p.isSDTM ? 'SDTM target domain' : `${p.cdashClass} · ${p.fieldCount} fields`
                return (
                  <g pointerEvents="none">
                    <rect x={tx} y={ty} width={170} height={44} rx="6" fill="white" stroke="#E2E8F0" strokeWidth="1" filter="url(#shadow)"/>
                    <text x={tx + 8} y={ty + 16} fontSize="10" fontWeight="600" fill="#0F172A" fontFamily="DM Sans,sans-serif">
                      {line1.length > 22 ? line1.slice(0, 20) + '…' : line1}
                    </text>
                    <text x={tx + 8} y={ty + 31} fontSize="9" fill="#94A3B8" fontFamily="DM Sans,sans-serif">
                      {line2}
                    </text>
                  </g>
                )
              })()}

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
