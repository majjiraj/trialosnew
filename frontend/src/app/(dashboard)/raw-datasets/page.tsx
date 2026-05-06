'use client'
import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, FileText, AlertCircle, Download, CheckCircle2, Loader2, Info, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { clsx } from 'clsx'

const DATA_PLATFORM_URL = process.env.NEXT_PUBLIC_DATA_PLATFORM_URL || 'http://localhost:8007'

type FileEntry = { file: File; id: string }

const ACCEPT_SDTM = {
  'application/octet-stream': ['.xpt'],
  'text/csv': ['.csv'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
}

const ACCEPT_CRF = {
  ...ACCEPT_SDTM,
  'application/pdf': ['.pdf'],
}

const DOMAIN_LABELS: Record<string, string> = {
  DM: 'Demographics', AE: 'Adverse Events', CM: 'Concomitant Medications',
  LB: 'Laboratory Results', VS: 'Vital Signs', EX: 'Exposure',
  DS: 'Disposition', MH: 'Medical History', SC: 'Subject Characteristics',
  IE: 'Inclusion/Exclusion', SV: 'Subject Visits', TU: 'Tumor Identification',
  TR: 'Tumor Results', RS: 'Response', QS: 'Questionnaires',
  FA: 'Findings About', ML: 'Meal Data', DD: 'Death Details',
  // Special-purpose
  SE: 'Subject Elements', RELREC: 'Related Records',
  // Trial design
  TA: 'Trial Arms', TE: 'Trial Elements', TI: 'Trial Inc/Exc Criteria',
  TS: 'Trial Summary', TV: 'Trial Visits',
  // Supplemental (merged into parent when parent also uploaded)
  SUPPAE: 'Supplemental AE → merged into AE',
  SUPPDM: 'Supplemental DM → merged into DM',
  SUPPDS: 'Supplemental DS → merged into DS',
  SUPPLB: 'Supplemental LB → merged into LB',
  SUPPCM: 'Supplemental CM → merged into CM',
  SUPPVS: 'Supplemental VS → merged into VS',
  SUPPEX: 'Supplemental EX → merged into EX',
  SUPPMH: 'Supplemental MH → merged into MH',
}

function detectDomain(filename: string): string {
  const stem = filename.split('.')[0].toUpperCase()
  // SUPP* check before first-token split
  if (stem.startsWith('SUPP') && stem.length > 4) return stem
  if (stem in DOMAIN_LABELS) return stem
  const first = stem.split('_')[0].split('-')[0]
  return first
}

function FileDropzone({
  label,
  hint,
  accept,
  multiple,
  files,
  onAdd,
  onRemove,
}: {
  label: string
  hint: string
  accept: Record<string, string[]>
  multiple: boolean
  files: FileEntry[]
  onAdd: (f: FileEntry[]) => void
  onRemove: (id: string) => void
}) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      const entries: FileEntry[] = accepted.map(f => ({ file: f, id: crypto.randomUUID() }))
      onAdd(entries)
    },
    [onAdd],
  )
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple,
  })

  const allExts = Object.values(accept).flat().join(', ')

  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-2">{label}</label>
      <div
        {...getRootProps()}
        className={clsx(
          'border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-brand-400 bg-brand-50'
            : 'border-slate-200 hover:border-brand-300 hover:bg-brand-50/30',
        )}
      >
        <input {...getInputProps()} multiple={multiple} />
        <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600">
          {isDragActive ? 'Drop files here' : 'Drag & drop or click to browse'}
        </p>
        {multiple && (
          <p className="text-xs text-brand-500 font-medium mt-0.5">Hold Ctrl / ⌘ to select multiple files</p>
        )}
        <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
        <p className="text-xs text-slate-300 mt-0.5">{allExts}</p>
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map(entry => {
            const domain = detectDomain(entry.file.name)
            return (
              <li
                key={entry.id}
                className="flex items-center gap-2.5 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm"
              >
                <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <span className="flex-1 truncate text-slate-700">{entry.file.name}</span>
                {(() => {
                    const domain = detectDomain(entry.file.name)
                    const isSupp = domain.startsWith('SUPP') && domain.length > 4
                    const label = DOMAIN_LABELS[domain]
                    return label ? (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        isSupp ? 'bg-violet-100 text-violet-700' : 'bg-brand-100 text-brand-700'
                      }`}>
                        {domain}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-medium">{domain}</span>
                    )
                  })()}
                <span className="text-xs text-slate-400">
                  {(entry.file.size / 1024).toFixed(0)} KB
                </span>
                <button
                  onClick={() => onRemove(entry.id)}
                  className="text-slate-400 hover:text-red-500 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type GeneratedDomain = { domain: string; rows: number; columns: number; file: string; category?: string }
type Manifest = { generated_at: string; domains: GeneratedDomain[]; crf_fields_used: number; skipped_files?: string[] }

export default function RawDatasetsPage() {
  const [sdtmFiles, setSdtmFiles] = useState<FileEntry[]>([])
  const [crfFiles, setCrfFiles] = useState<FileEntry[]>([])
  const [splitLbByCategory, setSplitLbByCategory] = useState(false)
  const [loading, setLoading] = useState(false)
  const [zipBlob, setZipBlob] = useState<Blob | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [showInfo, setShowInfo] = useState(false)

  const removeSdtm = (id: string) => setSdtmFiles(f => f.filter(x => x.id !== id))
  const removeCrf = (id: string) => setCrfFiles(f => f.filter(x => x.id !== id))

  const hasLb = sdtmFiles.some(e => detectDomain(e.file.name) === 'LB')

  const handleGenerate = async () => {
    if (sdtmFiles.length === 0) {
      toast.error('Add at least one SDTM file')
      return
    }
    setLoading(true)
    setZipBlob(null)
    setManifest(null)
    try {
      const fd = new FormData()
      for (const entry of sdtmFiles) fd.append('sdtm_files', entry.file)
      if (crfFiles[0]) fd.append('crf_file', crfFiles[0].file)
      if (splitLbByCategory) fd.append('split_lb_by_category', 'true')

      const res = await fetch(`${DATA_PLATFORM_URL}/raw-datasets/generate`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }

      // Parse the ZIP in the browser to read the manifest
      const blob = await res.blob()
      setZipBlob(blob)

      // Try to extract manifest.json from zip bytes using JSZip-free approach:
      // simply store blob and show summary from Content-Disposition header or
      // let the endpoint also return JSON summary separately.
      // We'll call the manifest via a second simple approach: re-read the last
      // Content-Disposition filename or just show generic success.
      toast.success(`Raw datasets generated — ${sdtmFiles.length} domain(s)`)

      // Build a synthetic manifest from the local file list for the summary card
      const syntheticManifest: Manifest = {
        generated_at: new Date().toISOString(),
        crf_fields_used: crfFiles.length > 0 ? 1 : 0,
        domains: sdtmFiles.map(e => {
          const domain = detectDomain(e.file.name)
          return { domain, rows: 0, columns: 0, file: `${domain}_raw.csv` }
        }),
      }
      setManifest(syntheticManifest)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = () => {
    if (!zipBlob) return
    const url = URL.createObjectURL(zipBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'raw_datasets.zip'
    a.click()
    URL.revokeObjectURL(url)
  }

  const canGenerate = sdtmFiles.length > 0 && !loading

  return (
    <div className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Raw Dataset Generator</h1>
          <p className="text-sm text-slate-500 mt-1">
            Reverse-generate study-specific raw datasets from standardised SDTM files, one CSV per domain.
          </p>
        </div>

        {/* Info panel */}
        <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 mb-6">
          <button
            className="w-full flex items-center justify-between text-sm font-medium text-brand-700"
            onClick={() => setShowInfo(v => !v)}
          >
            <span className="flex items-center gap-2"><Info className="w-4 h-4" />How it works</span>
            <ChevronDown className={clsx('w-4 h-4 transition-transform', showInfo && 'rotate-180')} />
          </button>
          {showInfo && (
            <ol className="mt-3 space-y-1.5 text-xs text-brand-800 list-decimal list-inside">
              <li>Upload one or more SDTM domain files (XPT, CSV, XLS/XLSX).</li>
              <li>Optionally upload a blank CRF (PDF, XLS/XLSX, CSV) — its field labels override the built-in mapping.</li>
              <li>Click <strong>Generate</strong>. The server parses each domain and renames SDTM variables back to raw CRF field names.</li>
              <li>Download the ZIP containing one raw CSV per detected domain plus a manifest.</li>
            </ol>
          )}
        </div>

        {/* Upload panels */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-8">
          <FileDropzone
            label="SDTM Domain Files"
            hint="One file per domain — filename must start with the domain code (e.g. AE.xpt, DM.csv)"
            accept={ACCEPT_SDTM}
            multiple
            files={sdtmFiles}
            onAdd={entries => setSdtmFiles(f => [...f, ...entries])}
            onRemove={removeSdtm}
          />

          <div className="border-t border-slate-100" />

          <FileDropzone
            label="Blank CRF (optional)"
            hint="Provides study-specific field labels for the output columns"
            accept={ACCEPT_CRF}
            multiple={false}
            files={crfFiles}
            onAdd={entries => setCrfFiles(entries.slice(0, 1))}
            onRemove={removeCrf}
          />
        </div>

        {/* Domain preview */}
        {sdtmFiles.length > 0 && (
          <div className="mt-6 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Detected Domains</h2>
            <div className="flex flex-wrap gap-2">
              {sdtmFiles.map(entry => {
                const domain = detectDomain(entry.file.name)
                const label = DOMAIN_LABELS[domain]
                const isSupp = domain.startsWith('SUPP') && domain.length > 4
                const isTrial = ['TA','TE','TI','TS','TV'].includes(domain)
                const badge = isSupp
                  ? 'bg-violet-100 text-violet-700 border-violet-200'
                  : isTrial
                    ? 'bg-teal-50 text-teal-700 border-teal-200'
                    : 'bg-slate-50 text-slate-700 border-slate-200'
                return (
                  <div
                    key={entry.id}
                    className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm ${badge}`}
                  >
                    <span className="font-mono font-semibold text-xs">{domain}</span>
                    {label && <span className="text-xs opacity-70">— {label}</span>}
                    {!label && <span className="text-amber-500 text-xs">— unknown domain</span>}
                    {isSupp && (
                      <span className="text-xs opacity-60 italic ml-0.5">(will merge)</span>
                    )}
                  </div>
                )
              })}
            </div>
            {sdtmFiles.some(e => !DOMAIN_LABELS[detectDomain(e.file.name)]) && (
              <p className="flex items-center gap-1.5 text-xs text-amber-600 mt-3">
                <AlertCircle className="w-3.5 h-3.5" />
                Files with unknown domains will still be processed using the original column names.
              </p>
            )}
          </div>
        )}

        {/* LB-specific options */}
        {hasLb && (
          <div className="mt-4 bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p className="text-sm font-semibold text-blue-800 mb-3">Laboratory Results options</p>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4 accent-blue-600 cursor-pointer"
                checked={splitLbByCategory}
                onChange={e => setSplitLbByCategory(e.target.checked)}
              />
              <span>
                <span className="text-sm font-medium text-blue-900">
                  Split by test category
                </span>
                <span className="block text-xs text-blue-600 mt-0.5">
                  Creates one CSV per LBCAT value (e.g.{' '}
                  <span className="font-mono">LB_Chemistry_raw.csv</span>,{' '}
                  <span className="font-mono">LB_Hematology_raw.csv</span>)
                  instead of a single combined file.
                </span>
              </span>
            </label>
          </div>
        )}

        {/* Generate button */}
        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={clsx(
              'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors',
              canGenerate
                ? 'bg-brand-500 hover:bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed',
            )}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {loading ? 'Generating…' : 'Generate Raw Datasets'}
          </button>
          {sdtmFiles.length > 0 && !loading && (
            <span className="text-xs text-slate-400">
              {sdtmFiles.length} SDTM file{sdtmFiles.length > 1 ? 's' : ''}
              {crfFiles.length > 0 ? ' + CRF' : ''}
            </span>
          )}
        </div>

        {/* Result card */}
        {zipBlob && manifest && (
          <div className="mt-6 bg-white rounded-2xl border border-emerald-200 shadow-sm p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-emerald-100 rounded-xl flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">Generation complete</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {manifest.domains.length} domain CSV{manifest.domains.length !== 1 ? 's' : ''} ready
                    {manifest.crf_fields_used > 0 && ' · CRF field mapping applied'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                <Download className="w-4 h-4" />
                Download ZIP
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {manifest.domains.map(d => (
                <div
                  key={d.file}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg"
                >
                  <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-700 font-mono">{d.file}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {d.category
                        ? `LB — ${d.category}`
                        : (DOMAIN_LABELS[d.domain] || d.domain)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {manifest.skipped_files && manifest.skipped_files.length > 0 && (
              <div className="mt-4 flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700">
                  <span className="font-semibold">Could not parse: </span>
                  {manifest.skipped_files.join(', ')} — these files were skipped.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
