'use client'
import { useState } from 'react'

export type DataSourceConfig =
  | { type: 'static'; data: Array<{ label: string; value: number }> }
  | { type: 'agent'; agentInstallationId: string; queryTemplate: string }
  | { type: 'database'; dataType: 'sdtm' | 'adam' | 'ctms' | 'budget'; domain: string; studyId: string }

interface Installation {
  id: string
  agentId: string
  agent: { id: string; name: string }
}

interface DataSourcePickerProps {
  value: DataSourceConfig | undefined
  onChange: (v: DataSourceConfig) => void
  installations: Installation[]
}

const TABS = ['static', 'agent', 'database'] as const
type Tab = typeof TABS[number]

export default function DataSourcePicker({ value, onChange, installations }: DataSourcePickerProps) {
  const [tab, setTab] = useState<Tab>((value?.type as Tab) || 'static')
  const [rawJson, setRawJson] = useState<string>(
    value?.type === 'static' ? JSON.stringify(value.data, null, 2) : ''
  )
  const [parseError, setParseError] = useState<string | null>(null)

  const handleParseStatic = () => {
    setParseError(null)
    try {
      const parsed = JSON.parse(rawJson)
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array')
      const normalized = parsed.map((item: unknown, i: number) => {
        if (typeof item === 'object' && item !== null && 'label' in item && 'value' in item) {
          return { label: String((item as { label: unknown }).label), value: Number((item as { value: unknown }).value) }
        }
        throw new Error(`Item at index ${i} must have "label" and "value" keys`)
      })
      onChange({ type: 'static', data: normalized })
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }

  const agentVal = value?.type === 'agent' ? value : null
  const dbVal = value?.type === 'database' ? value : null

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex border-b border-slate-200 bg-slate-50">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 text-xs font-medium capitalize transition-colors ${
              tab === t ? 'bg-white text-brand-700 border-b-2 border-brand-500' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-3 space-y-3">
        {tab === 'static' && (
          <>
            <div>
              <label className="block text-xs text-slate-500 mb-1">JSON Array (label + value)</label>
              <textarea
                rows={4}
                value={rawJson}
                onChange={e => setRawJson(e.target.value)}
                placeholder={'[{"label": "Mild", "value": 12}, {"label": "Moderate", "value": 7}]'}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            {parseError && <p className="text-xs text-red-600">{parseError}</p>}
            {value?.type === 'static' && !parseError && (
              <p className="text-xs text-green-600">{value.data.length} data point(s) loaded</p>
            )}
            <button
              onClick={handleParseStatic}
              className="px-3 py-1.5 bg-brand-500 text-white text-xs rounded hover:bg-brand-600"
            >
              Parse
            </button>
          </>
        )}

        {tab === 'agent' && (
          <>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Agent Installation</label>
              <select
                value={agentVal?.agentInstallationId || ''}
                onChange={e => onChange({ type: 'agent', agentInstallationId: e.target.value, queryTemplate: agentVal?.queryTemplate || '' })}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select agent...</option>
                {installations.map(inst => (
                  <option key={inst.id} value={inst.id}>{inst.agent.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Query Template (use {'{'}{'{'}'studyId'{'}'}{'}'})</label>
              <textarea
                rows={3}
                value={agentVal?.queryTemplate || ''}
                onChange={e => onChange({ type: 'agent', agentInstallationId: agentVal?.agentInstallationId || '', queryTemplate: e.target.value })}
                placeholder="Show AE data for study {{studyId}}"
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </>
        )}

        {tab === 'database' && (
          <>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Data Type</label>
              <select
                value={dbVal?.dataType || 'sdtm'}
                onChange={e => onChange({ type: 'database', dataType: e.target.value as 'sdtm' | 'adam' | 'ctms' | 'budget', domain: dbVal?.domain || '', studyId: dbVal?.studyId || '' })}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="sdtm">SDTM</option>
                <option value="adam">ADaM</option>
                <option value="ctms">CTMS</option>
                <option value="budget">Budget</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Domain</label>
              <input
                value={dbVal?.domain || ''}
                onChange={e => onChange({ type: 'database', dataType: dbVal?.dataType || 'sdtm', domain: e.target.value, studyId: dbVal?.studyId || '' })}
                placeholder="AE"
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Study ID</label>
              <input
                value={dbVal?.studyId || ''}
                onChange={e => onChange({ type: 'database', dataType: dbVal?.dataType || 'sdtm', domain: dbVal?.domain || '', studyId: e.target.value })}
                placeholder="STUDY-001"
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
