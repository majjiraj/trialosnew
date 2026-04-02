'use client'
import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, FileText } from 'lucide-react'
import FileBrowseBlock from './FileBrowseBlock'
import ConversationBlock from './ConversationBlock'
import ChartBlockRuntime from './ChartBlockRuntime'
import type { DataSourceConfig } from './DataSourcePicker'

interface FormSchema {
  formId: string
  title: string
  jsonSchema: Record<string, unknown>
  uiSchema?: Record<string, unknown>
  conditionalLogic?: unknown[]
}

interface PageComponent {
  id: string
  type: 'file_browse' | 'conversation' | 'chart'
  label: string
  agentInstallationId?: string
  agentName?: string
  placeholder?: string
  contextHint?: string
  chartType?: 'bar' | 'line' | 'pie' | 'scatter'
  dataSource?: DataSourceConfig
  defaultStudyId?: string
}

interface RichFormRendererProps {
  schema: FormSchema
  orgId: string
  studyId?: string
  userId?: string
  initialData?: Record<string, unknown>
  onSubmit: (data: Record<string, unknown>) => void
}

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

function FileUploadWidget({
  fieldKey, label, required, allowedTypes, maxFiles, orgId, studyId, userId,
  value, onChange,
}: {
  fieldKey: string; label: string; required: boolean
  allowedTypes?: string[]; maxFiles?: number
  orgId: string; studyId?: string; userId?: string
  value: string[]; onChange: (ids: string[]) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const buildAccept = (types?: string[]): Record<string, string[]> | undefined => {
    if (!types || types.includes('any')) return undefined
    const map: Record<string, Record<string, string[]>> = {
      pdf: { 'application/pdf': ['.pdf'] },
      doc: { 'application/msword': ['.doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
      xlsx: { 'application/vnd.ms-excel': ['.xls'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
      images: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'] },
      xpt: { 'application/octet-stream': ['.xpt'] },
      sas: { 'application/octet-stream': ['.sas7bdat', '.sas'] },
    }
    return types.reduce<Record<string, string[]>>((acc, t) => ({ ...acc, ...(map[t] || {}) }), {})
  }

  const onDrop = useCallback(async (files: File[]) => {
    setUploading(true)
    setUploadError(null)
    try {
      const ids: string[] = [...value]
      for (const file of files.slice(0, (maxFiles || 10) - value.length)) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('org_id', orgId)
        if (studyId) fd.append('study_id', studyId)
        fd.append('document_type', 'other')
        fd.append('uploaded_by', userId || orgId)
        const res = await fetch(`${INGESTION_URL}/documents/upload`, { method: 'POST', body: fd })
        const data = await res.json()
        if (res.status === 409 && data.existing_document_id) {
          ids.push(data.existing_document_id) // already ingested — reuse it
        } else if (!res.ok) {
          throw new Error(`Upload failed: ${res.status}`)
        } else {
          ids.push(data.document_id)
        }
      }
      onChange(ids)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [value, orgId, studyId, maxFiles, onChange])

  const acceptMap = buildAccept(allowedTypes)
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: acceptMap as Record<string, string[]>,
    maxFiles: maxFiles,
    disabled: uploading || value.length >= (maxFiles || 10),
  })

  const removeFile = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          isDragActive ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
        } ${(uploading || value.length >= (maxFiles || 10)) ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input {...getInputProps()} />
        <Upload className="w-5 h-5 text-slate-400 mx-auto mb-1" />
        <p className="text-xs text-slate-500">
          {uploading ? 'Uploading...' : isDragActive ? 'Drop files here' : 'Drag & drop or click to upload'}
        </p>
        {allowedTypes && !allowedTypes.includes('any') && (
          <p className="text-xs text-slate-400 mt-0.5">Allowed: {allowedTypes.join(', ')}</p>
        )}
        {maxFiles && <p className="text-xs text-slate-400">Max {maxFiles} files ({value.length} uploaded)</p>}
      </div>
      {uploadError && <p className="text-xs text-red-600 mt-1">{uploadError}</p>}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {value.map((id, i) => (
            <span key={id} className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs">
              <FileText className="w-3 h-3" />
              {id.slice(0, 8)}...
              <button onClick={() => removeFile(i)} className="hover:text-blue-600">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RichFormRenderer({ schema, orgId, studyId, userId, initialData, onSubmit }: RichFormRendererProps) {
  const [formData, setFormData] = useState<Record<string, unknown>>(initialData || {})

  // Use the form's own study_id field value when the prop isn't available yet (e.g. task-1 upload form)
  const effectiveStudyId = studyId || (formData.study_id as string | undefined)

  const jsonSchema = schema.jsonSchema
  const uiSchema = (schema.uiSchema || {}) as Record<string, unknown>
  const properties = (jsonSchema.properties as Record<string, { type: string; title?: string; enum?: string[]; items?: unknown; maxItems?: number }>) || {}
  const required = (jsonSchema.required as string[]) || []
  const pageComponents: PageComponent[] = (uiSchema['ui:page_components'] as PageComponent[]) || []

  const updateField = (key: string, value: unknown) => setFormData(d => ({ ...d, [key]: value }))

  const fieldUi = (key: string) => (uiSchema[key] as Record<string, unknown> | undefined) || {}
  const fieldUiOpts = (key: string) => fieldUi(key)['ui:options'] as Record<string, unknown> | undefined
  const fieldHint = (key: string) => fieldUi(key)['ui:help'] as string | undefined

  const HintText = ({ text }: { text?: string }) =>
    text ? <p className="text-xs text-slate-400 mt-1">{text}</p> : null

  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(formData) }} className="space-y-4">
      {Object.entries(properties).map(([key, prop]) => {
        const fu = fieldUi(key)
        const widget = fu['ui:widget'] as string | undefined
        const opts = fieldUiOpts(key)
        const hint = fieldHint(key)

        // file_upload field
        if (prop.type === 'array' && widget === 'file_upload') {
          return (
            <div key={key}>
              <FileUploadWidget
                fieldKey={key}
                label={prop.title || key}
                required={required.includes(key)}
                allowedTypes={opts?.allowedTypes as string[] | undefined}
                maxFiles={opts?.maxFiles as number | undefined}
                orgId={orgId}
                studyId={effectiveStudyId}
                userId={userId}
                value={(formData[key] as string[]) || []}
                onChange={ids => updateField(key, ids)}
              />
              <HintText text={hint} />
            </div>
          )
        }

        // multi-select (array:enum)
        if (prop.type === 'array' && prop.enum) {
          const currentVal = (formData[key] as string[]) || []
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {prop.title || key}
                {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
              </label>
              <div className="space-y-1">
                {(prop.enum as string[]).map(opt => (
                  <label key={opt} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={currentVal.includes(opt)}
                      onChange={e => { const next = e.target.checked ? [...currentVal, opt] : currentVal.filter(v => v !== opt); updateField(key, next) }}
                      className="rounded" />
                    <span className="text-sm text-slate-600">{opt}</span>
                  </label>
                ))}
              </div>
              <HintText text={hint} />
            </div>
          )
        }

        // select/dropdown
        if (prop.enum) {
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {prop.title || key}
                {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
              </label>
              <select value={String(formData[key] || '')} onChange={e => updateField(key, e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">Select...</option>
                {(prop.enum as string[]).map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              <HintText text={hint} />
            </div>
          )
        }

        // boolean
        if (prop.type === 'boolean') {
          return (
            <div key={key}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!formData[key]} onChange={e => updateField(key, e.target.checked)} className="rounded" />
                <span className="text-sm font-medium text-slate-700">
                  {prop.title || key}
                  {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
                </span>
              </label>
              <HintText text={hint} />
            </div>
          )
        }

        // textarea
        if (widget === 'textarea' || (prop.type === 'string' && (key === 'narrative' || key === 'description' || (prop.title || '').length > 20))) {
          const rows = (opts?.rows as number) || 3
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {prop.title || key}
                {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
              </label>
              <textarea rows={rows} value={String(formData[key] || '')} onChange={e => updateField(key, e.target.value)}
                placeholder={(opts?.placeholder as string) || ''}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <HintText text={hint} />
            </div>
          )
        }

        // date
        if (widget === 'date' || prop.type === 'string' && (jsonSchema.properties as Record<string, { format?: string }>)[key]?.format === 'date') {
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {prop.title || key}
                {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input type="date" value={String(formData[key] || '')} onChange={e => updateField(key, e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <HintText text={hint} />
            </div>
          )
        }

        // default text/number
        return (
          <div key={key}>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {prop.title || key}
              {required.includes(key) && <span className="text-red-500 ml-1">*</span>}
            </label>
            <input
              type={prop.type === 'number' ? 'number' : 'text'}
              value={String(formData[key] || '')}
              onChange={e => updateField(key, prop.type === 'number' ? Number(e.target.value) : e.target.value)}
              placeholder={(opts?.placeholder as string) || ''}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <HintText text={hint} />
          </div>
        )
      })}

      <button type="submit" className="w-full px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 mt-4">
        Submit Form
      </button>

      {pageComponents.length > 0 && (
        <div className="mt-6 space-y-4 pt-4 border-t border-slate-200">
          <h3 className="text-sm font-semibold text-slate-600">Additional Tools</h3>
          {pageComponents.map(pc => {
            if (pc.type === 'file_browse') {
              return (
                <FileBrowseBlock
                  key={pc.id}
                  label={pc.label}
                  orgId={orgId}
                  studyId={effectiveStudyId}
                  defaultStudyId={pc.defaultStudyId}
                />
              )
            }
            if (pc.type === 'conversation' && pc.agentInstallationId) {
              return (
                <ConversationBlock
                  key={pc.id}
                  label={pc.label}
                  agentInstallationId={pc.agentInstallationId}
                  agentName={pc.agentName || 'Agent'}
                  placeholder={pc.placeholder}
                  contextHint={pc.contextHint}
                  orgId={orgId}
                  studyId={effectiveStudyId}
                />
              )
            }
            if (pc.type === 'chart' && pc.dataSource) {
              return (
                <ChartBlockRuntime
                  key={pc.id}
                  label={pc.label}
                  chartType={pc.chartType || 'bar'}
                  dataSource={pc.dataSource}
                  orgId={orgId}
                  studyId={effectiveStudyId}
                />
              )
            }
            return null
          })}
        </div>
      )}
    </form>
  )
}
