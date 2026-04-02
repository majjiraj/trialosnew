'use client'
import { useState, useEffect, useRef } from 'react'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
import { Wand2, Code2, MessageSquare, Plus, Trash2, Save, Sparkles, Tag, X, ChevronDown, BookOpen, Wrench, Globe, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'

const SDTM_TEMPLATES = [
  {
    id: 'sdtm_domain_reference',
    label: 'SDTM Domain Reference',
    type: 'prompt' as const,
    name: 'sdtm_domain_reference',
    description: 'Returns required/optional variables, controlled terms and conformance rules for a given SDTM domain',
    tags: 'sdtm, cdisc, mapping',
    body: `You are a CDISC SDTM Implementation Guide expert (SDTM IG v3.4, CDISC 2022).

Reference the following SDTM domain registry (source of truth):

DOMAIN | REQUIRED VARIABLES | KEY CONTROLLED TERMS
DM     | STUDYID, DOMAIN, USUBJID, SUBJID, RFSTDTC, RFENDTC, SITEID, AGE, AGEU, SEX, RACE, ETHNIC, COUNTRY | SEX: M/F/U, AGEU: YEARS/MONTHS/DAYS
AE     | STUDYID, DOMAIN, USUBJID, AESEQ, AETERM, AESTDTC | AESEV: MILD/MODERATE/SEVERE, AESER: Y/N, AEREL: NOT RELATED/POSSIBLY RELATED/PROBABLY RELATED/RELATED
LB     | STUDYID, DOMAIN, USUBJID, LBSEQ, LBTESTCD, LBTEST, LBORRES, LBDTC | LBNRIND: LOW/NORMAL/HIGH/ABNORMAL
VS     | STUDYID, DOMAIN, USUBJID, VSSEQ, VSTESTCD, VSTEST, VSORRES, VSDTC | VSTESTCD: SYSBP/DIABP/PULSE/TEMP/WEIGHT/HEIGHT/BMI
CM     | STUDYID, DOMAIN, USUBJID, CMSEQ, CMTRT, CMSTDTC
EX     | STUDYID, DOMAIN, USUBJID, EXSEQ, EXTRT, EXDOSE, EXDOSU, EXROUTE, EXSTDTC
MH     | STUDYID, DOMAIN, USUBJID, MHSEQ, MHTERM
DS     | STUDYID, DOMAIN, USUBJID, DSSEQ, DSTERM, DSDECOD, EPOCH, DSSTDTC

Additional implementation guide context: @sdtm-ig-graph

For the domain specified in the state, output ONLY valid JSON:
{
  "domain": "<DOMAIN>",
  "required_vars": [...],
  "optional_vars": [...],
  "controlled_terms": {"VAR": ["VALUE1", ...]},
  "conformance_rules": ["<rule text>", ...]
}`,
  },
  {
    id: 'sdtm_field_mapper',
    label: 'SDTM Field Mapper',
    type: 'prompt' as const,
    name: 'sdtm_field_mapper',
    description: 'Maps raw EDC column names to SDTM variables given a domain reference',
    tags: 'sdtm, cdisc, mapping, edc',
    body: `You are a clinical data mapper specialising in EDC-to-SDTM transformation.

You will receive:
- "edc_fields": list of raw EDC column names from a CRF form
- "domain_reference": SDTM domain definition with required and optional variables

Your task:
1. Map each EDC field to the most appropriate SDTM variable
2. Flag required variables that have no EDC source (set to null)
3. Note controlled term transformations needed

Output ONLY valid JSON:
{
  "mapping_rules": {"EDC_COLUMN": "SDTM_VARIABLE", ...},
  "unmapped_required": ["SDTM_VAR_WITH_NO_SOURCE", ...],
  "transform_notes": {"SDTM_VAR": "transformation instruction", ...}
}

Do not add explanations outside the JSON.`,
  },
  {
    id: 'sdtm_mapping_validator',
    label: 'SDTM Mapping Validator',
    type: 'function' as const,
    name: 'sdtm_mapping_validator',
    description: 'Validates mapping_rules against SDTM required variables and reports coverage',
    tags: 'sdtm, cdisc, validation',
    body: `REQUIRED_VARS = {
    "AE": ["STUDYID","DOMAIN","USUBJID","AESEQ","AETERM","AESTDTC"],
    "DM": ["STUDYID","DOMAIN","USUBJID","SUBJID","RFSTDTC","RFENDTC","SITEID","AGE","AGEU","SEX","RACE","ETHNIC","COUNTRY"],
    "LB": ["STUDYID","DOMAIN","USUBJID","LBSEQ","LBTESTCD","LBTEST","LBORRES","LBDTC"],
    "VS": ["STUDYID","DOMAIN","USUBJID","VSSEQ","VSTESTCD","VSTEST","VSORRES","VSDTC"],
    "CM": ["STUDYID","DOMAIN","USUBJID","CMSEQ","CMTRT","CMSTDTC"],
    "EX": ["STUDYID","DOMAIN","USUBJID","EXSEQ","EXTRT","EXDOSE","EXDOSU","EXROUTE","EXSTDTC"],
    "MH": ["STUDYID","DOMAIN","USUBJID","MHSEQ","MHTERM"],
    "DS": ["STUDYID","DOMAIN","USUBJID","DSSEQ","DSTERM","DSDECOD","EPOCH","DSSTDTC"],
}
domain = params.get("domain", "")
mapping = state_data.get("sdtm_field_mapper", {}).get("mapping_rules", {})
required = set(REQUIRED_VARS.get(domain.upper(), []))
mapped   = set(mapping.values())
missing  = required - mapped
result = {
    "domain": domain,
    "valid": len(missing) == 0,
    "missing_required": list(missing),
    "coverage_pct": round(len(required & mapped) / len(required) * 100, 1) if required else 100.0,
    "findings": [f"Missing required SDTM variable: {v}" for v in sorted(missing)],
}`,
  },
]

const MARKETPLACE_URL = 'http://localhost:8005'
const CONTEXT_GRAPH_URL = 'http://localhost:8008'

interface Skill {
  id: string
  name: string
  description: string
  skill_type: 'function' | 'prompt'
  body?: string
  input_schema?: Record<string, unknown>
  tags: string[]
  created_at?: string
}

interface StandardSkill extends Skill {
  is_published: boolean
  published_at: string | null
}

type FilterTab = 'all' | 'function' | 'prompt' | 'platform'

const TYPE_BADGE: Record<string, string> = {
  function: 'bg-green-100 text-green-700',
  prompt:   'bg-purple-100 text-purple-700',
}

export default function SkillsPage() {
  const orgId       = useOrgId()
  const { user }    = useAuth()

  const [skills,          setSkills]          = useState<Skill[]>([])
  const [standardSkills,  setStandardSkills]  = useState<StandardSkill[]>([])
  const [clonedIds,       setClonedIds]       = useState<Set<string>>(new Set())
  const [cloning,         setCloning]         = useState<string | null>(null)
  const [copiedId,        setCopiedId]        = useState<string | null>(null)
  const [availableGraphs, setAvailableGraphs] = useState<{id: string; name: string}[]>([])
  const [filter,          setFilter]          = useState<FilterTab>('all')
  const [selected,        setSelected]        = useState<Skill | null>(null)
  const [isNew,           setIsNew]           = useState(false)
  const [loading,         setLoading]         = useState(false)
  const [generating,      setGenerating]      = useState(false)

  // Form state
  const [formName,        setFormName]        = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formType,        setFormType]        = useState<'function' | 'prompt'>('function')
  const [formBody,        setFormBody]        = useState('')
  const [formSchema,      setFormSchema]      = useState('{}')
  const [formTags,        setFormTags]        = useState('')
  const [generateDesc,    setGenerateDesc]    = useState('')
  const [generateGraphId, setGenerateGraphId] = useState('')
  const [fixing,          setFixing]          = useState(false)
  const [fixGraphId,      setFixGraphId]      = useState('')
  const [showTemplates,   setShowTemplates]   = useState(false)
  const bodyRef    = useRef<HTMLDivElement>(null)
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const templateDropdownRef = useRef<HTMLDivElement>(null)

  const applyTemplate = (tpl: typeof SDTM_TEMPLATES[number]) => {
    setFormType(tpl.type)
    setFormName(tpl.name)
    setFormDescription(tpl.description)
    setFormBody(tpl.body)
    setFormTags(tpl.tags)
    setShowTemplates(false)
    setTimeout(() => bodyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }

  const isSdtmHint = formName.toLowerCase().includes('sdtm') ||
    formTags.toLowerCase().includes('sdtm')

  const fetchSkills = async () => {
    if (!orgId) return
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills?org_id=${orgId}`)
      const d = await r.json()
      if (d.skills) setSkills(d.skills)
    } catch {
      // ignore
    }
  }

  const fetchStandardSkills = async () => {
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/standard?published_only=true`)
      const d = await r.json()
      if (d.skills) setStandardSkills(d.skills)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchSkills()
    fetchStandardSkills()
    if (orgId) {
      fetch(`${CONTEXT_GRAPH_URL}/standard-graphs?org_id=${orgId}`)
        .then(r => r.json())
        .then(d => { if (d.graphs) setAvailableGraphs(d.graphs) })
        .catch(() => {})
    }
  }, [orgId])

  // Track which standard skills are already cloned (by name match)
  useEffect(() => {
    if (standardSkills.length === 0 || skills.length === 0) return
    const orgSkillNames = new Set(skills.map(s => s.name))
    const alreadyCloned = new Set(
      standardSkills.filter(s => orgSkillNames.has(s.name)).map(s => s.id)
    )
    setClonedIds(alreadyCloned)
  }, [standardSkills, skills])

  const handleClone = async (skill: StandardSkill) => {
    if (!orgId) return
    setCloning(skill.id)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/${skill.id}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, cloned_by: user?.id }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail || 'Clone failed')
      }
      toast.success(`"${skill.name}" added to your library`)
      setClonedIds(ids => new Set([...ids, skill.id]))
      await fetchSkills()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Clone failed')
    } finally {
      setCloning(null)
    }
  }

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  const filteredSkills = filter === 'platform'
    ? []
    : filter === 'all' ? skills : skills.filter(s => s.skill_type === filter)

  const openNew = () => {
    setIsNew(true)
    setSelected(null)
    setFormName('')
    setFormDescription('')
    setFormType('function')
    setFormBody('')
    setFormSchema('{}')
    setFormTags('')
    setGenerateDesc('')
    setGenerateGraphId('')
    setShowTemplates(false)
  }

  const openEdit = async (skill: Skill) => {
    setIsNew(false)
    // Fetch full skill including body
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/${skill.id}?org_id=${orgId}`)
      const full = await r.json()
      setSelected(full)
      setFormName(full.name || '')
      setFormDescription(full.description || '')
      setFormType(full.skill_type || 'function')
      setFormBody(full.body || '')
      setFormSchema(JSON.stringify(full.input_schema || {}, null, 2))
      setFormTags((full.tags || []).join(', '))
      setGenerateDesc('')
    } catch {
      toast.error('Failed to load skill')
    }
  }

  const handleGenerate = async () => {
    if (!generateDesc.trim()) { toast.error('Enter a description first'); return }
    setGenerating(true)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          description: generateDesc,
          skill_type: formType,
          ...(generateGraphId ? { context_graph_id: generateGraphId } : {}),
        }),
      })
      const d = await r.json()
      if (d.generated_body) {
        setFormBody(d.generated_body)
        setTimeout(() => bodyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
      }
      if (d.suggested_name && !formName) setFormName(d.suggested_name)
      if (d.description && !formDescription) setFormDescription(d.description)
      if (d.input_schema) setFormSchema(JSON.stringify(d.input_schema, null, 2))
      if (d.generated_body) {
        toast.success('Skill generated — review the code below before saving')
      } else {
        toast.warning('Generated empty body — try a more specific description')
      }
    } catch {
      toast.error('Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const handleFix = async () => {
    if (!formBody.trim()) { toast.error('No skill code to fix'); return }
    setFixing(true)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          original_code: formBody,
          original_prompt: formDescription || formName,
          ...(fixGraphId ? { context_graph_id: fixGraphId } : {}),
        }),
      })
      const d = await r.json()
      if (d.generated_body) {
        setFormBody(d.generated_body)
        if (d.suggested_name && !formName) setFormName(d.suggested_name)
        if (d.description) setFormDescription(d.description)
        if (d.input_schema && Object.keys(d.input_schema).length > 0)
          setFormSchema(JSON.stringify(d.input_schema, null, 2))
        if (d.tags?.length && !formTags)
          setFormTags(d.tags.join(', '))
        setTimeout(() => bodyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
        toast.success('Skill upgraded — review before saving')
      } else {
        toast.warning('Fix returned empty body')
      }
    } catch {
      toast.error('Fix & Upgrade failed')
    } finally {
      setFixing(false)
    }
  }

  const handleSave = async () => {
    if (!formName.trim()) { toast.error('Name is required'); return }
    if (!formBody.trim()) { toast.error('Skill body is required'); return }
    setLoading(true)
    try {
      let schema = {}
      try { schema = JSON.parse(formSchema) } catch { /* keep empty */ }
      const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)

      if (isNew) {
        const r = await fetch(`${MARKETPLACE_URL}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org_id: orgId,
            name: formName.trim(),
            description: formDescription.trim(),
            skill_type: formType,
            body: formBody,
            input_schema: schema,
            tags,
            created_by: user?.id,
          }),
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({})) as { detail?: string }
          throw new Error(err.detail || 'Failed to create skill')
        }
        toast.success('Skill created')
      } else if (selected) {
        const r = await fetch(`${MARKETPLACE_URL}/skills/${selected.id}?org_id=${orgId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formName.trim(),
            description: formDescription.trim(),
            skill_type: formType,
            body: formBody,
            input_schema: schema,
            tags,
          }),
        })
        if (!r.ok) throw new Error('Failed to update skill')
        toast.success('Skill updated')
      }
      await fetchSkills()
      setIsNew(false)
      setSelected(null)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"?`)) return
    try {
      await fetch(`${MARKETPLACE_URL}/skills/${skill.id}?org_id=${orgId}`, { method: 'DELETE' })
      toast.success('Skill deleted')
      if (selected?.id === skill.id) setSelected(null)
      await fetchSkills()
    } catch {
      toast.error('Delete failed')
    }
  }

  const showForm = isNew || selected !== null

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — skill list */}
      <div className="w-72 flex-shrink-0 border-r border-slate-200 flex flex-col bg-white">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-pink-500" />
              Skills Library
            </h1>
            <button
              onClick={openNew}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-pink-500 hover:bg-pink-600 text-white rounded-lg transition-colors"
            >
              <Plus className="w-3 h-3" />New Skill
            </button>
          </div>
          {/* Filter tabs */}
          <div className="flex gap-1 flex-wrap">
            {(['all', 'function', 'prompt'] as FilterTab[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-1 px-2 py-1 text-xs rounded-md capitalize transition-colors ${
                  filter === f
                    ? 'bg-slate-900 text-white font-medium'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >{f}</button>
            ))}
            <button
              onClick={() => setFilter('platform')}
              className={`flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
                filter === 'platform'
                  ? 'bg-pink-600 text-white font-medium'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              <Globe className="w-3 h-3 inline mr-0.5" />Platform
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {filteredSkills.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-400 text-xs">
              No skills yet.{' '}
              <button onClick={openNew} className="text-pink-500 hover:underline">Create one →</button>
            </div>
          ) : (
            filteredSkills.map(skill => (
              <div
                key={skill.id}
                onClick={() => openEdit(skill)}
                className={`mx-2 mb-1 px-3 py-2.5 rounded-lg cursor-pointer border transition-all group ${
                  selected?.id === skill.id
                    ? 'border-pink-300 bg-pink-50'
                    : 'border-transparent hover:border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {skill.skill_type === 'function' ? (
                      <Code2 className="w-3.5 h-3.5 flex-shrink-0 text-green-500" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-purple-500" />
                    )}
                    <span className="text-sm font-medium text-slate-900 truncate">{skill.name}</span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(skill) }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-300 hover:text-red-500 transition-all flex-shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {skill.description && (
                  <p className="text-xs text-slate-400 truncate mt-0.5 pl-5">{skill.description}</p>
                )}
                <div className="flex items-center gap-1 mt-1 pl-5 flex-wrap">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TYPE_BADGE[skill.skill_type]}`}>
                    {skill.skill_type}
                  </span>
                  {(skill.tags || []).slice(0, 3).map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">{tag}</span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel — create/edit form OR platform standard skills */}
      <div className="flex-1 overflow-y-auto bg-white">
        {filter === 'platform' ? (
          <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">
            <div className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-pink-500" />
              <div>
                <h2 className="text-base font-bold text-slate-900">Platform Standard Skills</h2>
                <p className="text-xs text-slate-500">Published by your platform admin. Clone to your library to customise, or reference by UUID in flow nodes.</p>
              </div>
            </div>

            {standardSkills.length === 0 ? (
              <div className="py-10 text-center text-slate-400">
                <Globe className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm">No published platform skills yet.</p>
              </div>
            ) : standardSkills.map(skill => (
              <div key={skill.id} className="border border-slate-200 rounded-xl p-4 space-y-2 hover:border-slate-300 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900">{skill.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TYPE_BADGE[skill.skill_type]}`}>
                        {skill.skill_type}
                      </span>
                    </div>
                    {skill.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{skill.description}</p>
                    )}
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      {(skill.tags || []).map(tag => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">{tag}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleClone(skill)}
                      disabled={clonedIds.has(skill.id) || cloning === skill.id}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        clonedIds.has(skill.id)
                          ? 'border-green-200 text-green-600 bg-green-50 cursor-default'
                          : 'border-pink-200 text-pink-600 hover:bg-pink-50'
                      }`}
                    >
                      {cloning === skill.id
                        ? <><Wand2 className="w-3 h-3 animate-spin" />Cloning…</>
                        : clonedIds.has(skill.id)
                          ? <><Check className="w-3 h-3" />Cloned</>
                          : <><Plus className="w-3 h-3" />Clone to Library</>}
                    </button>
                  </div>
                </div>

                {/* UUID chip for direct reference */}
                <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
                  <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">UUID for flow node:</span>
                  <code className="text-[10px] font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded flex-1 min-w-0 truncate">{skill.id}</code>
                  <button
                    onClick={() => copyId(skill.id)}
                    className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100 transition-colors flex-shrink-0"
                    title="Copy UUID"
                  >
                    {copiedId === skill.id ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : showForm ? (
          <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">
                {isNew ? 'Create New Skill' : `Edit: ${formName}`}
              </h2>
              {/* Templates dropdown */}
              <div className="relative" ref={templateDropdownRef}>
                <button
                  onClick={() => setShowTemplates(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition-colors"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  Templates
                  <ChevronDown className={`w-3 h-3 transition-transform ${showTemplates ? 'rotate-180' : ''}`} />
                </button>
                {showTemplates && (
                  <div className="absolute right-0 top-8 z-20 w-64 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                      SDTM Mapping Skills
                    </div>
                    {SDTM_TEMPLATES.map(tpl => (
                      <button
                        key={tpl.id}
                        onClick={() => applyTemplate(tpl)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {tpl.type === 'function'
                            ? <Code2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                            : <MessageSquare className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" />}
                          <span className="text-xs font-medium text-slate-800">{tpl.label}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5 pl-5 truncate">{tpl.description}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* SDTM hint banner */}
            {isSdtmHint && (
              <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                <BookOpen className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>
                  SDTM skill detected. Use <strong>Templates</strong> to load pre-built domain reference, field mapper, or validator starters.
                  Add <code className="font-mono bg-blue-100 px-1 rounded">@sdtm-ig-graph</code> to inject live IG context at runtime.
                </span>
              </div>
            )}

            {/* Name & description */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
                <input
                  type="text" value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="count_records"
                  className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Tags (comma-separated)</label>
                <div className="relative">
                  <Tag className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text" value={formTags}
                    onChange={e => setFormTags(e.target.value)}
                    placeholder="data, analysis, sdtm"
                    className="w-full pl-7 pr-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
              <input
                type="text" value={formDescription}
                onChange={e => setFormDescription(e.target.value)}
                placeholder="One-line description of what this skill does"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-500"
              />
            </div>

            {/* Type toggle */}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden w-48 text-sm font-medium">
                <button
                  onClick={() => setFormType('function')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 transition-colors ${
                    formType === 'function' ? 'bg-green-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Code2 className="w-3.5 h-3.5" />Function
                </button>
                <button
                  onClick={() => setFormType('prompt')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 transition-colors ${
                    formType === 'prompt' ? 'bg-purple-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5" />Prompt
                </button>
              </div>
            </div>

            {/* AI generation */}
            <div className="p-4 bg-gradient-to-br from-pink-50 to-purple-50 rounded-xl border border-pink-100">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-4 h-4 text-pink-500" />
                <span className="text-sm font-semibold text-slate-800">Generate from Description</span>
              </div>
              <p className="text-xs text-slate-500 mb-2">Describe what this skill should do and AI will write the code or prompt.</p>
              <textarea
                rows={2}
                value={generateDesc}
                onChange={e => setGenerateDesc(e.target.value)}
                placeholder={formType === 'function'
                  ? 'e.g. Count the number of records in state_data and return the count'
                  : 'e.g. A clinical summariser that condenses data into a concise narrative'}
                className="w-full px-2.5 py-1.5 border border-pink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-400 resize-none bg-white"
              />
              {availableGraphs.length > 0 && (
                <div className="mt-2">
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Context Graph <span className="font-normal text-slate-400">(optional — grounds generation in domain knowledge)</span>
                  </label>
                  <select
                    value={generateGraphId}
                    onChange={e => setGenerateGraphId(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-pink-200 rounded-md text-xs bg-white focus:outline-none focus:ring-2 focus:ring-pink-400 text-slate-700"
                  >
                    <option value="">None</option>
                    {availableGraphs.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <button
                onClick={handleGenerate}
                disabled={generating || !generateDesc.trim()}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                {generating ? 'Generating…' : 'Generate with AI'}
              </button>
            </div>

            {/* Body editor */}
            <div ref={bodyRef}>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {formType === 'function' ? 'Python Code' : 'System Prompt'}
              </label>
              {formType === 'function' && (
                <p className="text-xs text-slate-400 mb-1">
                  Variables: <code className="text-pink-600">state_data</code>, <code className="text-pink-600">messages</code>, <code className="text-pink-600">params</code> — assign to <code className="text-pink-600">result</code>
                </p>
              )}
              <textarea
                ref={bodyTextareaRef}
                rows={12}
                value={formBody}
                onChange={e => setFormBody(e.target.value)}
                placeholder={formType === 'function'
                  ? '# Write your Python skill here\n# Assign your output to result\nresult = {"count": len(state_data)}'
                  : 'You are a clinical expert.\nUse @protocol-graph to answer questions about the study design.\nAlways cite the specific section when referencing protocol content.'}
                className={`w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 resize-none ${
                  formType === 'function' ? 'font-mono bg-slate-900 text-green-300' : ''
                }`}
              />
              {formType === 'prompt' && availableGraphs.length > 0 && (
                <div className="mt-1.5 p-2 bg-purple-50 border border-purple-100 rounded-md">
                  <p className="text-[11px] text-purple-600 mb-1.5">
                    💡 Type <code className="font-mono bg-purple-100 px-1 rounded">@graphname</code> to inject live context. Available graphs:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {availableGraphs.map(g => {
                      const slug = g.name.toLowerCase().replace(/[\s_]+/g, '-')
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => {
                            const ta = bodyTextareaRef.current
                            if (ta) {
                              const pos = ta.selectionStart
                              const mention = `@${slug}`
                              setFormBody(prev => prev.slice(0, pos) + mention + prev.slice(pos))
                              setTimeout(() => {
                                ta.focus()
                                ta.setSelectionRange(pos + mention.length, pos + mention.length)
                              }, 0)
                            } else {
                              setFormBody(prev => prev + `@${slug}`)
                            }
                          }}
                          className="px-2 py-0.5 text-[11px] font-mono bg-white border border-purple-200 text-purple-700 rounded-full hover:bg-purple-100 transition-colors"
                        >
                          @{slug}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Fix & Upgrade */}
            {formBody.trim() && (
              <div className="p-4 bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border border-amber-100">
                <div className="flex items-center gap-1.5 mb-1">
                  <Wrench className="w-4 h-4 text-amber-500" />
                  <span className="text-sm font-semibold text-slate-800">Fix &amp; Upgrade</span>
                </div>
                <p className="text-xs text-slate-500 mb-2">
                  Rewrites the current code to enforce the full output contract, add traceability, domain detection, and validation layer. Uses two focused LLM passes to avoid token cutoff.
                </p>
                {availableGraphs.length > 0 && (
                  <div className="mb-2">
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">
                      Context Graph <span className="font-normal text-slate-400">(optional)</span>
                    </label>
                    <select
                      value={fixGraphId}
                      onChange={e => setFixGraphId(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-amber-200 rounded-md text-xs bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 text-slate-700"
                    >
                      <option value="">None</option>
                      {availableGraphs.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  onClick={handleFix}
                  disabled={fixing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  <Wrench className="w-3 h-3" />
                  {fixing ? 'Upgrading…' : 'Fix & Upgrade Skill'}
                </button>
              </div>
            )}

            {/* Input schema */}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Input Schema (JSON)</label>
              <textarea
                rows={4}
                value={formSchema}
                onChange={e => setFormSchema(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-pink-500 resize-none bg-slate-50"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
              <button
                onClick={handleSave}
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                {loading ? 'Saving…' : 'Save Skill'}
              </button>
              <button
                onClick={() => { setIsNew(false); setSelected(null) }}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <X className="w-3.5 h-3.5" />Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 p-8">
            <Wand2 className="w-10 h-10 text-pink-200 mb-3" />
            <p className="text-sm font-medium text-slate-500">Select a skill to edit</p>
            <p className="text-xs mt-1">or create a new one</p>
            <button
              onClick={openNew}
              className="mt-4 flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-pink-500 hover:bg-pink-600 text-white rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />New Skill
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
