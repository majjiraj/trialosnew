'use client'
import { FileCheck, RefreshCw, CheckCircle, XCircle, AlertTriangle, Play, Wand2, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

interface SectionResult {
  id: string
  title: string
  status: 'found' | 'partial' | 'missing' | 'unknown'
  usdm_covered: boolean
  critical: boolean
}

interface ValidationResult {
  score: number
  conformant: boolean
  sections_present: Record<string, string>
  usdm_coverage: Record<string, boolean>
  findings: Array<{ section_id: string; severity: string; message: string }>
}

interface ConversionSection {
  id: string
  title: string
  status: 'extracted' | 'missing'
  content: string
  critical: boolean
}

const SECTION_META: Record<string, { title: string; critical: boolean }> = {
  S01: { title: 'General Information',        critical: true  },
  S02: { title: 'Protocol Summary',           critical: true  },
  S03: { title: 'Background and Rationale',   critical: true  },
  S04: { title: 'Objectives and Estimands',   critical: true  },
  S05: { title: 'Eligibility Criteria',       critical: true  },
  S06: { title: 'Study Design',               critical: true  },
  S07: { title: 'Study Interventions',        critical: false },
  S08: { title: 'Schedule of Activities',     critical: true  },
  S09: { title: 'Statistical Considerations', critical: true  },
  S10: { title: 'Data Management',            critical: false },
  S11: { title: 'Monitoring',                 critical: false },
  S12: { title: 'Safety Reporting',           critical: true  },
  S13: { title: 'Ethical Considerations',     critical: false },
  S14: { title: 'Supporting Documentation',   critical: false },
}

function ScoreArc({ score }: { score: number }) {
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'
  const r = 54
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  return (
    <div className="flex flex-col items-center">
      <svg width="140" height="80" viewBox="0 0 140 80">
        <path d="M 10 70 A 60 60 0 0 1 130 70" fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <path
          d="M 10 70 A 60 60 0 0 1 130 70"
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeDasharray={`${(score / 100) * 188} 188`}
          strokeLinecap="round"
        />
        <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="bold" fill={color}>
          {score}
        </text>
        <text x="70" y="78" textAnchor="middle" fontSize="10" fill="#6b7280">
          / 100
        </text>
      </svg>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'found') return <span className="flex items-center gap-1 text-green-600 text-sm"><CheckCircle className="w-4 h-4" /> Found</span>
  if (status === 'partial') return <span className="flex items-center gap-1 text-yellow-600 text-sm"><AlertTriangle className="w-4 h-4" /> Partial</span>
  if (status === 'missing') return <span className="flex items-center gap-1 text-red-600 text-sm"><XCircle className="w-4 h-4" /> Missing</span>
  return <span className="text-gray-400 text-sm">—</span>
}

export default function ICHM11Page() {
  const [studyId, setStudyId]               = useState('')
  const [validating, setValidating]         = useState(false)
  const [converting, setConverting]         = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [conversionSections, setConversionSections] = useState<Record<string, ConversionSection> | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
  const standardsUrl = process.env.NEXT_PUBLIC_STANDARDS_REGISTRY_URL || 'http://localhost:8012'

  const getOrgId = () =>
    typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
  const getStudyId = () =>
    studyId || (typeof window !== 'undefined' ? localStorage.getItem('study_id') || '' : '')

  const runValidation = async () => {
    setValidating(true)
    setError(null)
    setValidationResult(null)
    try {
      // First try direct standards-registry call for immediate result
      const sid = getStudyId()
      const directRes = await fetch(`${standardsUrl}/ich-m11/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structured_sections: {}, protocol_text: null, usdm_data: null }),
      })
      if (directRes.ok) {
        const data = await directRes.json()
        setValidationResult(data)
      }
      // Also launch the full validator agent for a complete run
      await fetch(`${runtimeUrl}/runs/by-slug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_slug: 'ich-m11-validator',
          org_id: getOrgId(),
          study_id: sid || undefined,
          input_context: { trigger_source: 'manual_dashboard' },
        }),
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setValidating(false)
    }
  }

  const runConversion = async () => {
    setConverting(true)
    setError(null)
    setConversionSections(null)
    try {
      const res = await fetch(`${runtimeUrl}/runs/by-slug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_slug: 'protocol-ich-m11-converter',
          org_id: getOrgId(),
          study_id: getStudyId() || undefined,
          input_context: { trigger_source: 'manual_dashboard' },
        }),
      })
      if (!res.ok) throw new Error(`Agent launch failed: ${res.status}`)
      const data = await res.json()
      // Show placeholder sections indicating conversion queued
      const placeholder: Record<string, ConversionSection> = {}
      Object.entries(SECTION_META).forEach(([id, meta]) => {
        placeholder[id] = { id, ...meta, status: 'missing', content: 'Conversion queued — run_id: ' + data.run_id }
      })
      setConversionSections(placeholder)
    } catch (e) {
      setError(String(e))
    } finally {
      setConverting(false)
    }
  }

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const sectionRows = Object.entries(SECTION_META).map(([id, meta]) => {
    const status = validationResult?.sections_present?.[id] || 'unknown'
    const usdmCovered = validationResult?.usdm_coverage?.[id] || false
    return { id, ...meta, status, usdmCovered }
  })

  const conformant = validationResult ? validationResult.score >= 80 : null

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <FileCheck className="w-7 h-7 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ICH M11 CeSHarP Validation</h1>
          <p className="text-sm text-gray-500">Validate and convert protocols against ICH M11 Clinical Electronic Structured Harmonised Protocol standard</p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Study ID (optional — uses active study if blank)"
            value={studyId}
            onChange={e => setStudyId(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={runValidation}
            disabled={validating}
            className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {validating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Validate Protocol
          </button>
          <button
            onClick={runConversion}
            disabled={converting}
            className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {converting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            Convert to ICH M11
          </button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">{error}</div>
        )}
      </div>

      {/* Validation Score */}
      {validationResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start gap-8">
            <ScoreArc score={validationResult.score} />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-lg font-semibold ${conformant ? 'text-green-600' : 'text-red-600'}`}>
                  {conformant ? 'Conformant' : 'Non-Conformant'}
                </span>
                <span className="text-gray-400 text-sm">ICH M11 v2 (CeSHarP 2024)</span>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-2">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-gray-800">
                    {Object.values(validationResult.sections_present).filter(s => s === 'found').length}
                    <span className="text-base font-normal text-gray-500">/14</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Sections Found</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-gray-800">
                    {Object.values(validationResult.usdm_coverage || {}).filter(Boolean).length}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">USDM-Covered</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-red-600">
                    {(validationResult.findings || []).filter(f => f.severity?.toLowerCase() === 'critical').length}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Critical Issues</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section-by-Section Table */}
      {validationResult && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
            <h2 className="font-semibold text-gray-700 text-sm">Section-by-Section Results</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500 text-xs">
                <th className="px-5 py-2">ID</th>
                <th className="px-5 py-2">Section</th>
                <th className="px-5 py-2">Status</th>
                <th className="px-5 py-2">USDM</th>
                <th className="px-5 py-2">Critical</th>
              </tr>
            </thead>
            <tbody>
              {sectionRows.map(row => (
                <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-5 py-2 font-mono text-gray-500">{row.id}</td>
                  <td className="px-5 py-2 text-gray-800">{row.title}</td>
                  <td className="px-5 py-2"><StatusBadge status={row.status} /></td>
                  <td className="px-5 py-2">
                    {row.usdmCovered
                      ? <CheckCircle className="w-4 h-4 text-green-500" />
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-5 py-2">
                    {row.critical
                      ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Critical</span>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Findings */}
      {validationResult && (validationResult.findings || []).length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-2">
          <h2 className="font-semibold text-gray-700 text-sm mb-3">Findings</h2>
          {validationResult.findings.map((f, i) => (
            <div key={i} className={`flex items-start gap-2 text-sm p-2 rounded-lg ${
              f.severity?.toLowerCase() === 'critical' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'
            }`}>
              {f.severity?.toLowerCase() === 'critical'
                ? <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              <span><strong>[{f.section_id}]</strong> {f.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Conversion Output */}
      {conversionSections && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-emerald-50 flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-emerald-600" />
            <h2 className="font-semibold text-emerald-700 text-sm">ICH M11 Conversion Output</h2>
            <span className="ml-auto text-xs text-emerald-600">
              {Object.values(conversionSections).filter(s => s.status === 'extracted').length}/14 sections extracted
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            {Object.values(conversionSections).map(sec => (
              <div key={sec.id} className="px-5 py-3">
                <button
                  onClick={() => toggleSection(sec.id)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-gray-400 w-8">{sec.id}</span>
                    <span className={`text-sm font-medium ${sec.status === 'extracted' ? 'text-gray-800' : 'text-gray-400'}`}>
                      {sec.title}
                    </span>
                    {sec.critical && (
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Critical</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {sec.status === 'extracted'
                      ? <CheckCircle className="w-4 h-4 text-green-500" />
                      : <XCircle className="w-4 h-4 text-red-400" />}
                    {expandedSections.has(sec.id) ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </div>
                </button>
                {expandedSections.has(sec.id) && (
                  <div className="mt-2 ml-11 text-sm text-gray-600 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">
                    {sec.content || (sec.status === 'missing' ? '— Requires human completion —' : '')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!validationResult && !conversionSections && !validating && !converting && (
        <div className="text-center py-16 text-gray-400">
          <FileCheck className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter a Study ID and click <strong>Validate Protocol</strong> to check ICH M11 compliance,</p>
          <p className="text-sm">or click <strong>Convert to ICH M11</strong> to restructure the protocol.</p>
        </div>
      )}
    </div>
  )
}
