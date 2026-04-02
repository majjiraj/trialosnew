'use client'
import React, { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Wand2, RefreshCw, Save, Edit2, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle, Loader2, Bot, Wrench, Brain, Users, Sparkles,
  GitBranch, Search, X, ChevronRight, ClipboardList, Code2,
  Send, Play, FlaskConical, BarChart2, Globe, Upload, CheckSquare,
  MessageSquare, Zap, Star, Eye,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'
const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

async function apiFetch(path: string, body: unknown) {
  const res = await fetch(`${MARKETPLACE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

type TargetType = 'agent' | 'skill'
type AgentMode = 'standard' | 'deep'
type RightTab = 'artifacts' | 'test' | 'evaluate'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  artifactSnapshot?: ArtifactSet
  changesSummary?: string
}

interface TestScenario {
  name: string
  description: string
  input_context: Record<string, unknown>
  expected_behavior: string
  expected_output_keywords: string[]
  success_criteria: string
  test_type: string
}

interface EvaluatorResult {
  evaluator_id: string
  evaluator_name: string
  score?: number
  verdict?: string
  summary?: string
  findings?: string[]
  details?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
}

interface StructuredWarning {
  message: string
  recommended_fix: string
  auto_fixable: boolean
  location: string
  severity: 'error' | 'warning'
}

interface StandardPrompt {
  title: string
  description: string
  prompt: string
  mode?: AgentMode
  category: string
  tags: string[]
}

const STANDARD_PROMPTS: Record<TargetType, StandardPrompt[]> = {
  agent: [
    {
      title: 'SDTM Compliance Checker',
      description: 'Validates SDTM datasets against CDISC IG rules and controlled terminology',
      category: 'Data Management', mode: 'standard', tags: ['SDTM', 'CDISC', 'validation'],
      prompt: `Build an agent that validates SDTM domain datasets (AE, CM, DM, VS, LB) against CDISC SDTM Implementation Guide rules. The agent should:\n1. Check that all required variables are present and non-null\n2. Validate controlled terminology values against CDISC CT for each variable\n3. Verify derivation rules for computed variables (e.g., --DY, --STDY, AGE, BMI)\n4. Identify domain-level structural violations (missing USUBJID, wrong data types)\n5. Produce a structured compliance report with severity levels (ERROR, WARNING, INFO) for each finding, grouped by domain and subject`,
    },
    {
      title: 'Adverse Event Safety Monitor',
      description: 'Real-time monitoring of AE data for safety signals and severity patterns',
      category: 'Safety', mode: 'standard', tags: ['AE', 'safety', 'pharmacovigilance'],
      prompt: `Build a safety monitoring agent that scans SDTM AE domain data for high-severity adverse events. The agent should:\n1. Identify events where AESEV = 'SEVERE' or AEACN = 'DRUG WITHDRAWN'\n2. Group related events by AEBODSYS (MedDRA body system organ class)\n3. Calculate incidence rates by treatment arm using DM domain exposure data\n4. Flag potential safety signals where incidence exceeds 5% threshold or is statistically significant\n5. Check for events meeting SAE criteria (AESER = 'Y') and their outcomes\n6. Generate a formatted pharmacovigilance signal report with subject-level detail and timeline`,
    },
    {
      title: 'Demographics Summary Generator',
      description: 'Generates publication-ready Table 1 demographics from SDTM DM domain',
      category: 'Analytics', mode: 'standard', tags: ['DM', 'demographics', 'statistics'],
      prompt: `Build an agent that reads SDTM DM domain data and generates a standard clinical trial demographics summary table. The agent should:\n1. Calculate age statistics (mean, median, SD, min, max, 95% CI) by treatment arm\n2. Produce counts and percentages for sex (SEX), race (RACE), and ethnicity (ETHNIC)\n3. Compute BMI statistics if VSHEIGHT and VSWEIGHT available from VS domain\n4. Apply appropriate statistical tests (Chi-square for categorical, ANOVA for continuous)\n5. Format output as a publication-ready Table 1 per ICH E3 standards\n6. Flag any significant demographic imbalances between treatment arms`,
    },
    {
      title: 'Protocol Deviation Monitor',
      description: 'Validates study execution against protocol-specified requirements',
      category: 'Regulatory', mode: 'standard', tags: ['protocol', 'GCP', 'compliance'],
      prompt: `Build an agent that validates clinical study execution against the approved protocol. The agent should:\n1. Verify visit windows are within +-3 days of scheduled dates using SDTM SV domain\n2. Check that inclusion/exclusion criteria were properly assessed at screening (SDTM SC domain)\n3. Confirm prohibited medications were not administered during washout period (CM domain)\n4. Identify missing or overdue protocol-required assessments by visit\n5. Categorize deviations by severity (major/minor/other) per ICH E6(R3) GCP\n6. Generate a protocol deviation report grouped by site, subject, and deviation type`,
    },
    {
      title: 'SDTM Raw Data Mapper (Deep Agent)',
      description: 'Maps raw EDC data to SDTM with AI self-validation and human expert review',
      category: 'Data Management', mode: 'deep', tags: ['SDTM', 'mapping', 'HITL', 'deep'],
      prompt: `Build a deep agent that maps raw EDC study data to SDTM domains with human review. The agent should:\n1. Parse uploaded raw EDC files (CSV/XLS) and extract column names, data types, and sample values\n2. Retrieve relevant SDTM Implementation Guide sections for target domains (AE, CM, DM, VS, LB)\n3. Apply exact-match logic for obvious mappings, then use LLM reasoning for ambiguous columns\n4. Self-validate: check required variable coverage, controlled terminology, and derivation completeness\n5. PAUSE FOR HUMAN REVIEW: present a structured mapping table where the data manager can edit source-to-SDTM variable mappings, derivation rules, and confidence scores\n6. After approval: generate Python transformation scripts, Excel mapping spec, and SDTM output datasets\n\nInclude a HITL node. The review form must show: source file, source column, mapped SDTM variable, derivation type (direct_copy/derived/constant/computed), confidence score, formula/rule, and editable notes.`,
    },
    {
      title: 'Clinical Study Report Reviewer (Deep Agent)',
      description: 'Validates CSR drafts against SAP and data outputs with medical writer sign-off',
      category: 'Medical Writing', mode: 'deep', tags: ['CSR', 'medical writing', 'HITL', 'deep'],
      prompt: `Build a deep agent that reviews a Clinical Study Report (CSR) draft for accuracy and regulatory compliance. The agent should:\n1. Extract all statistical claims, p-values, table references, and efficacy/safety summaries from the CSR\n2. Cross-reference each claim against actual statistical analysis outputs and the SAP\n3. Verify ICH E3 structure compliance -- all required sections present with appropriate content depth\n4. Check narrative consistency: efficacy discussion matches tables, safety summary matches listings\n5. PAUSE FOR MEDICAL WRITER REVIEW: present prioritized issues with draft corrections suggested\n6. After sign-off: generate a tracked-changes version of the CSR with all approved corrections applied\n\nInclude HITL node. The review form should show each issue with: section reference, original text, identified problem, suggested correction, and accept/reject/modify options.`,
    },
    {
      title: 'ADaM Dataset Generator (Deep Agent)',
      description: 'Derives ADaM analysis datasets from SDTM with biostatistician review',
      category: 'Analytics', mode: 'deep', tags: ['ADaM', 'ADSL', 'biostatistics', 'HITL', 'deep'],
      prompt: `Build a deep agent that derives ADaM analysis datasets from SDTM source data. The agent should:\n1. Read SDTM DM, AE, LB, VS, CM domains for the specified study\n2. Derive ADSL (Analysis Data Subject Level) with treatment flags, disposition, and demographic variables\n3. Create ADAE (Analysis Data Adverse Events) with analysis flags per the Statistical Analysis Plan\n4. Generate derivation documentation for each computed variable with algorithm and source variable audit trail\n5. Run completeness and consistency checks against SAP-specified analysis populations (ITT, PP, Safety)\n6. PAUSE FOR BIOSTATISTICIAN REVIEW: present derivation audit trail and flagged ambiguous derivations\n7. After sign-off: finalize datasets and generate define.xml metadata file\n\nInclude HITL node. The review form should show each derived variable: derivation rule, source variables, population flag assignment, and any inconsistencies found.`,
    },
    {
      title: 'Site Performance Analyzer (Deep Agent)',
      description: 'Identifies underperforming sites with CRA manager review and action planning',
      category: 'Site Monitoring', mode: 'deep', tags: ['site monitoring', 'CRA', 'HITL', 'deep'],
      prompt: `Build a deep site performance monitoring agent. The agent should:\n1. Retrieve enrollment rates, query rates, protocol deviation counts, and data entry lag by site\n2. Calculate composite performance scores: enrollment (40%), data quality (35%), compliance (25%)\n3. Identify underperforming sites using outlier detection (>2 SD below mean composite score)\n4. For flagged sites: retrieve 6-month trend data and last 3 monitoring visit notes\n5. PAUSE FOR CRA MANAGER REVIEW: present prioritized site risk dashboard with recommended actions\n6. After approval: generate tailored site visit plans and trigger automated query letters for data issues\n\nInclude HITL node. The review form should show each flagged site: composite score, component breakdown, risk level, and recommended action type.`,
    },
  ],
  skill: [
    {
      title: 'ISO 8601 Date Converter',
      description: 'Converts any clinical date format to ISO 8601 including partial dates',
      category: 'Data Transformation', tags: ['dates', 'ISO 8601', 'CDISC'],
      prompt: `Create a skill that converts clinical trial date values to ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS). Handle: SAS date values (days since 1960-01-01), DD-MON-YYYY format (e.g. 15-JAN-2024), DD/MM/YYYY and MM/DD/YYYY, Excel serial date numbers, partial dates (YYYY, YYYY-MM) per CDISC ISO 8601 convention, and unknown date components (represented as dashes). Return the converted date string, a is_partial flag, and source format detected.`,
    },
    {
      title: 'CDISC CT Validator',
      description: 'Validates values against CDISC Controlled Terminology codelists',
      category: 'Validation', tags: ['CDISC', 'controlled terminology', 'validation'],
      prompt: `Build a skill that validates a given value against CDISC Controlled Terminology for a specified codelist. Accept: codelist name (e.g. RACE, SEX, AESEV, AGEU), submission value to check. Return: is_valid boolean, preferred term, NCI concept code, synonyms list, and for invalid values the closest fuzzy match. Handle extensible vs non-extensible codelists differently.`,
    },
    {
      title: 'SDTM Variable Deriver',
      description: 'Derives standard SDTM computed variables (--DY, AGE, BMI, flags)',
      category: 'Data Transformation', tags: ['SDTM', 'derivation', 'variables'],
      prompt: `Create a skill that derives common SDTM computed variables from raw EDC fields. Handle: --DY (Study Day) from RFSTDTC and event date, --STDY and --ENDY for interval records, AGE from BRTHDTC and RFSTDTC, BMI from height/weight, baseline flag (--BLFL = Y), and change from baseline (--CHG, --PCHG). Input is a dictionary of source field values. Output is each derived SDTM variable with its value and the derivation rule applied.`,
    },
    {
      title: 'Lab Normalcy Classifier',
      description: 'Classifies lab results vs reference ranges with CTCAE grading',
      category: 'Safety', tags: ['lab', 'LB', 'reference ranges', 'CTCAE'],
      prompt: `Build a skill that classifies laboratory results as normal, abnormal, or critically abnormal. Accept: lab test name, numeric value, unit, patient sex and age. Look up standard clinical reference ranges. Apply CDISC LBNRIND values (NORMAL, LOW, HIGH, CRITICALLY LOW, CRITICALLY HIGH). Handle unit conversion for common parameters (mg/dL to mmol/L). Return: LBNRIND classification, reference range used, CTCAE grade (1-5) if abnormal, and clinical significance flag.`,
    },
    {
      title: 'Descriptive Statistics Calculator',
      description: 'Calculates ICH E3-compliant descriptive statistics for continuous variables',
      category: 'Analytics', tags: ['statistics', 'biostatistics', 'tables'],
      prompt: `Create a skill that calculates standard descriptive statistics for continuous clinical trial variables. Produce: n (non-missing), mean, SD, median, min, max, Q1, Q3, 95% CI for the mean. Handle missing values (exclude, report count). Format output per ICH E3 standards with appropriate decimal places. Support stratification by a grouping variable (e.g. treatment arm) for comparative summaries.`,
    },
  ],
}

interface SkillArtifact {
  name: string
  description?: string
  skill_type?: 'function' | 'prompt'
  execution_type?: string
  tags?: string[]
  body?: string
  input_schema?: Record<string, unknown>
  output_schema?: Record<string, unknown>
  safety_constraints?: string[]
  test_cases?: unknown[]
}

interface ArtifactSet {
  agent_spec?: Record<string, unknown>
  allowed_purposes?: string[]
  retrieval_recipe?: Record<string, unknown>
  output_schema?: Record<string, unknown>
  prompt_contract?: Record<string, unknown>
  flow_definition?: Record<string, unknown>
  hitl_form_schema?: Record<string, unknown>
  test_cases?: unknown[]
  skills?: SkillArtifact[]
  skill_spec?: Record<string, unknown>
  input_output_contract?: Record<string, unknown>
  execution_type?: string
  safety_constraints?: string[]
  body?: string
}

function JsonViewer({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-slate-50 rounded-lg p-3 overflow-auto max-h-48 text-slate-700 border border-slate-200">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function ArtifactCard({
  title, children, onRegenerate, loading, badge,
}: {
  title: string; children: React.ReactNode; onRegenerate?: () => void; loading?: boolean; badge?: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {badge}
        </div>
        <div className="flex items-center gap-2">
          {onRegenerate && (
            <button onClick={onRegenerate} disabled={loading} title="Regenerate this section"
              className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors disabled:opacity-40">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
          )}
          <button onClick={() => setCollapsed(c => !c)} className="p-1 rounded text-slate-400 hover:text-slate-600">
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {!collapsed && <div className="p-4">{children}</div>}
    </div>
  )
}

function FlowPreview({ flow }: { flow: Record<string, unknown> }) {
  const nodes = (flow.nodes as Array<Record<string, unknown>>) || []
  const edges = (flow.edges as Array<Record<string, unknown>>) || []
  if (!nodes.length) return <p className="text-xs text-slate-400">No nodes generated</p>
  const hasHitl = nodes.some(n => n.type === 'hitl')
  const hasSkill = nodes.some(n => n.type === 'skill')
  const hasMemory = nodes.some(n => n.type === 'memory')
  const hasReflect = nodes.some(n => n.type === 'reflect')
  const hasCG = nodes.some(n => n.type === 'context_graph')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {hasHitl && (
          <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
            <Users className="w-3 h-3" /> HITL Review
          </span>
        )}
        {hasSkill && (
          <span className="flex items-center gap-1 text-xs text-pink-700 bg-pink-50 border border-pink-200 rounded-full px-2.5 py-0.5">
            <Wrench className="w-3 h-3" /> Custom Skills
          </span>
        )}
        {hasMemory && (
          <span className="flex items-center gap-1 text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2.5 py-0.5">
            <Brain className="w-3 h-3" /> Memory
          </span>
        )}
        {hasReflect && (
          <span className="flex items-center gap-1 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2.5 py-0.5">
            <Search className="w-3 h-3" /> Self-Reflect
          </span>
        )}
        {hasCG && (
          <span className="flex items-center gap-1 text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-2.5 py-0.5">
            <GitBranch className="w-3 h-3" /> Knowledge Graph
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {nodes.map((n, i) => (
          <div key={i} className={clsx(
            'px-2.5 py-1 rounded-lg text-xs font-medium border flex items-center gap-1',
            n.type === 'hitl' ? 'bg-amber-50 border-amber-200 text-amber-700' :
            n.type === 'llm' ? 'bg-brand-50 border-brand-200 text-brand-700' :
            n.type === 'output' ? 'bg-green-50 border-green-200 text-green-700' :
            n.type === 'condition' ? 'bg-purple-50 border-purple-200 text-purple-700' :
            n.type === 'data_source' ? 'bg-blue-50 border-blue-200 text-blue-700' :
            n.type === 'reflect' ? 'bg-pink-50 border-pink-200 text-pink-700' :
            n.type === 'skill' ? 'bg-pink-50 border-pink-200 text-pink-700' :
            n.type === 'memory' ? 'bg-sky-50 border-sky-200 text-sky-700' :
            n.type === 'context_graph' ? 'bg-violet-50 border-violet-200 text-violet-700' :
            'bg-slate-50 border-slate-200 text-slate-600'
          )}>
            {n.type === 'hitl' && <Users className="w-3 h-3" />}
            {n.type === 'llm' && <Brain className="w-3 h-3" />}
            {n.type === 'skill' && <Wrench className="w-3 h-3" />}
            {String(n.label || n.type)}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">{nodes.length} nodes · {edges.length} edges</p>
    </div>
  )
}

function HitlFormPreview({ schema }: { schema: Record<string, unknown> }) {
  const fields = (schema.fields as Array<Record<string, unknown>>) || []
  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardList className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-800">{String(schema.title || 'Human Review Form')}</span>
        </div>
        {!!schema.instructions && <p className="text-xs text-amber-700">{String(schema.instructions)}</p>}
      </div>
      {fields.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-500">Review Form Fields ({fields.length})</p>
          {fields.map((f, i) => (
            <div key={i} className="flex items-center gap-3 text-xs border border-slate-100 rounded-lg p-2.5 bg-slate-50">
              <span className="font-mono text-brand-700 bg-brand-50 px-2 py-0.5 rounded flex-shrink-0">{String(f.name || f.field || `field_${i}`)}</span>
              <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0',
                f.editable ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500')}>
                {f.editable ? 'editable' : 'read-only'}
              </span>
              <span className="text-slate-400 flex-shrink-0">{String(f.type || 'text')}</span>
              <span className="text-slate-600 truncate">{String(f.label || f.description || '')}</span>
            </div>
          ))}
        </div>
      )}
      {(schema.actions as string[])?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1.5">Reviewer Actions</p>
          <div className="flex flex-wrap gap-1.5">
            {(schema.actions as string[]).map((a, i) => (
              <span key={i} className="text-xs bg-slate-100 text-slate-700 border border-slate-200 px-2.5 py-1 rounded-full">{a}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SkillCard({ skill }: { skill: SkillArtifact }) {
  const [expanded, setExpanded] = useState(false)
  const execColor: Record<string, string> = {
    transformation: 'bg-orange-50 border-orange-200 text-orange-700',
    query: 'bg-blue-50 border-blue-200 text-blue-700',
    reasoning: 'bg-purple-50 border-purple-200 text-purple-700',
    tool_call: 'bg-green-50 border-green-200 text-green-700',
  }
  const typeColor = skill.skill_type === 'function'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-blue-50 text-blue-700 border-blue-200'
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Wrench className="w-3.5 h-3.5 text-pink-500 flex-shrink-0" />
            <p className="text-sm font-semibold text-slate-800 truncate">{skill.name}</p>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            <span className={`text-[10px] border px-1.5 py-0.5 rounded-full font-mono font-medium ${typeColor}`}>
              {skill.skill_type || 'function'}
            </span>
            {skill.execution_type && (
              <span className={`text-[10px] border px-1.5 py-0.5 rounded-full font-medium ${execColor[skill.execution_type] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                {skill.execution_type}
              </span>
            )}
            {(skill.tags || []).map((tag, i) => (
              <span key={i} className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{tag}</span>
            ))}
          </div>
          {skill.description && (
            <p className="text-xs text-slate-500">{skill.description}</p>
          )}
        </div>
        <button onClick={() => setExpanded(e => !e)} className="p-1 text-slate-400 hover:text-slate-600 flex-shrink-0">
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>
      {expanded && skill.body && (
        <div className="border-t border-slate-200">
          <div className="flex items-center gap-2 px-4 py-2 bg-slate-800">
            <Code2 className="w-3 h-3 text-slate-400" />
            <span className="text-xs text-slate-400 font-mono">
              {skill.skill_type === 'function' ? 'Python code' : 'Prompt template'}
            </span>
          </div>
          <pre className="text-xs font-mono text-green-300 bg-slate-900 p-4 overflow-x-auto max-h-64 leading-relaxed">
            {skill.body}
          </pre>
        </div>
      )}
      {expanded && (skill.input_schema || skill.safety_constraints?.length) && (
        <div className="border-t border-slate-200 px-4 py-3 space-y-2 bg-white">
          {skill.safety_constraints && skill.safety_constraints.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1">Safety Constraints</p>
              <ul className="space-y-0.5">
                {skill.safety_constraints.map((c, i) => (
                  <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 flex-shrink-0" />{c}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PromptCard({ p, onUse }: { p: StandardPrompt; onUse: (prompt: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border border-slate-200 rounded-lg bg-white hover:border-brand-200 transition-colors">
      <div className="flex items-start gap-2 p-3 pb-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-800">{p.title}</span>
            {p.mode === 'deep' && (
              <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-0.5">
                <Users className="w-2.5 h-2.5" /> Deep
              </span>
            )}
            <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">{p.category}</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{p.description}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 px-3 py-2">
        <button onClick={() => onUse(p.prompt)}
          className="flex items-center gap-1 px-2.5 py-1 bg-brand-500 hover:bg-brand-600 text-white text-[11px] font-medium rounded-lg transition-colors">
          <Wand2 className="w-3 h-3" /> Use
        </button>
        <button onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors">
          {expanded ? 'Hide' : 'Preview'}
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-3 py-2.5 bg-slate-50">
          <pre className="text-[11px] text-slate-600 whitespace-pre-wrap leading-relaxed font-sans">{p.prompt}</pre>
        </div>
      )}
    </div>
  )
}

export default function VibePage() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const router = useRouter()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [targetType, setTargetType] = useState<TargetType>('agent')
  const [agentMode, setAgentMode] = useState<AgentMode>('standard')
  const [description, setDescription] = useState('')
  const [refinement, setRefinement] = useState('')
  const [artifacts, setArtifacts] = useState<ArtifactSet | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [confidence, setConfidence] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refining, setRefining] = useState(false)
  const [sectionRefining, setSectionRefining] = useState<string | null>(null)
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [error, setError] = useState('')
  const [showPrompts, setShowPrompts] = useState(true)
  const [promptSearch, setPromptSearch] = useState('')

  // Structured warnings + auto-fix
  const [warningsStructured, setWarningsStructured] = useState<StructuredWarning[]>([])
  const [autoFixes, setAutoFixes] = useState<Array<{issue: string; fix: string; location: string}>>([])
  const [autofixing, setAutofixing] = useState(false)

  // Chat history
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Save / Publish state
  const [savedAgentId, setSavedAgentId] = useState<string | null>(null)
  const [savedInstallationId, setSavedInstallationId] = useState<string | null>(null)
  const [savedSlug, setSavedSlug] = useState<string | null>(null)
  const [isPublished, setIsPublished] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // Right panel tabs
  const [rightTab, setRightTab] = useState<RightTab>('artifacts')

  // Test runner
  const [testScenario, setTestScenario] = useState('')
  const [testScenarios, setTestScenarios] = useState<TestScenario[]>([])
  const [recommendedEvaluators, setRecommendedEvaluators] = useState<string[]>([])
  const [generatingTests, setGeneratingTests] = useState(false)
  const [selectedScenarioIdx, setSelectedScenarioIdx] = useState(0)
  const [testRunId, setTestRunId] = useState<string | null>(null)
  const [testRunStatus, setTestRunStatus] = useState<string | null>(null)
  const [testRunResult, setTestRunResult] = useState<Record<string, unknown> | null>(null)
  const [runningTest, setRunningTest] = useState(false)

  // Evaluator
  const [evaluatorCatalog, setEvaluatorCatalog] = useState<Array<Record<string, unknown>>>([])
  const [evaluatorResults, setEvaluatorResults] = useState<EvaluatorResult[]>([])
  const [runningEvaluator, setRunningEvaluator] = useState<string | null>(null)

  const filteredPrompts = STANDARD_PROMPTS[targetType].filter(p => {
    const q = promptSearch.toLowerCase()
    if (!q) {
      if (targetType === 'agent' && agentMode === 'standard') return p.mode !== 'deep'
      if (targetType === 'agent' && agentMode === 'deep') return p.mode === 'deep'
      return true
    }
    return p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q)) || p.category.toLowerCase().includes(q)
  })

  const usePrompt = useCallback((prompt: string) => {
    setDescription(prompt)
    setShowPrompts(false)
    setTimeout(() => textareaRef.current?.focus(), 50)
  }, [])

  async function handleGenerate() {
    if (!description.trim() || !orgId) return
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-build', {
        org_id: orgId,
        description: description.trim(),
        target_type: targetType,
        context: { agent_mode: targetType === 'agent' ? agentMode : undefined },
      })
      setArtifacts(res.artifacts)
      setWarnings(res.warnings || [])
      setWarningsStructured(res.warnings_structured || [])
      setAutoFixes(res.auto_fixes_applied || [])
      setConfidence(res.confidence || 0)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleRefine() {
    if (!refinement.trim() || !artifacts || !orgId) return
    const userMsg = refinement.trim()
    setRefinement('')
    const prevNodeCount = (artifacts.flow_definition?.nodes as unknown[])?.length || 0
    setChatHistory(h => [...h, { role: 'user', content: userMsg, timestamp: new Date().toISOString() }])
    setRefining(true)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-refine', {
        org_id: orgId,
        previous_artifacts: { target_type: targetType, artifacts },
        refinement: userMsg,
      })
      const newNodeCount = (res.artifacts?.flow_definition?.nodes as unknown[])?.length || 0
      const delta = newNodeCount - prevNodeCount
      const summary = delta > 0 ? `Added ${delta} node(s)` : delta < 0 ? `Removed ${Math.abs(delta)} node(s)` : 'Updated flow logic'
      setChatHistory(h => [...h, {
        role: 'assistant',
        content: `Applied: ${userMsg}`,
        changesSummary: `${summary} · Confidence: ${Math.round((res.confidence || 0) * 100)}%`,
        timestamp: new Date().toISOString(),
        artifactSnapshot: res.artifacts,
      }])
      setArtifacts(res.artifacts)
      setWarnings(res.warnings || [])
      setWarningsStructured(res.warnings_structured || [])
      setAutoFixes(f => [...f, ...(res.auto_fixes_applied || [])])
      setConfidence(res.confidence || 0)
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Refinement failed')
      setChatHistory(h => [...h, { role: 'assistant', content: 'Refinement failed. Please try again.', timestamp: new Date().toISOString() }])
    } finally {
      setRefining(false)
    }
  }

  async function handleSectionRegenerate(section: string) {
    if (!artifacts || !orgId) return
    setSectionRefining(section)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-refine', {
        org_id: orgId,
        previous_artifacts: { target_type: targetType, artifacts },
        refinement: `Regenerate the ${section} section`,
        section,
      })
      setArtifacts(res.artifacts)
      setWarnings(res.warnings || [])
      setConfidence(res.confidence || 0)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Regeneration failed')
    } finally {
      setSectionRefining(null)
    }
  }

  function startEdit(section: string, value: unknown) {
    setEditingSection(section)
    setEditValue(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }

  function applyEdit(section: string) {
    if (!artifacts) return
    try { setArtifacts({ ...artifacts, [section]: JSON.parse(editValue) })
    } catch { setArtifacts({ ...artifacts, [section]: editValue }) }
    setEditingSection(null)
  }

  async function handleAutoFix() {
    if (!artifacts || !orgId) return
    setAutofixing(true)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-autofix', {
        org_id: orgId,
        artifacts,
        target_type: targetType,
      })
      setArtifacts(res.artifacts)
      setWarnings(res.warnings || [])
      setWarningsStructured(res.warnings_structured || [])
      setAutoFixes(f => [...f, ...(res.fixes_applied || [])])
      setConfidence(res.confidence || 0)
      const count = (res.fixes_applied || []).length
      setChatHistory(h => [...h, {
        role: 'assistant',
        content: `🔧 Auto-fixed ${count} issue${count !== 1 ? 's' : ''}: ${(res.fixes_applied || []).map((f: {issue: string}) => f.issue).join(', ')}`,
        changesSummary: `New confidence: ${Math.round((res.confidence || 0) * 100)}%`,
        timestamp: new Date().toISOString(),
        artifactSnapshot: res.artifacts,
      }])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Auto-fix failed')
    } finally {
      setAutofixing(false)
    }
  }

  async function handleSave() {
    if (!artifacts || !orgId || !user) return
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-save', {
        org_id: orgId, created_by: user.id, target_type: targetType, artifacts,
      })
      if (res.target_type === 'agent') {
        setSavedAgentId(res.agent_id)
        setSavedInstallationId(res.installation_id)
        setSavedSlug(res.slug)
        setIsPublished(false)
        const skillCount = (res.skills_created || []).length
        setChatHistory(h => [...h, {
          role: 'assistant',
          content: `✅ Draft saved successfully${skillCount > 0 ? ` with ${skillCount} auto-created skill${skillCount > 1 ? 's' : ''}` : ''}. You can now test, evaluate, or publish this agent.`,
          timestamp: new Date().toISOString(),
        }])
        setRightTab('test')
      } else {
        router.push('/agents/skills')
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    if (!savedAgentId) return
    setPublishing(true)
    setError('')
    try {
      const res = await fetch(`${MARKETPLACE_URL}/agents/${savedAgentId}/publish`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setIsPublished(true)
      setChatHistory(h => [...h, {
        role: 'assistant',
        content: `🚀 Agent published! It is now available in your workspace.`,
        timestamp: new Date().toISOString(),
      }])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  async function handleGenerateTestData() {
    if (!artifacts || !orgId) return
    setGeneratingTests(true)
    setError('')
    try {
      const res = await apiFetch('/agents/vibe-generate-test-data', {
        org_id: orgId,
        artifacts,
        target_type: targetType,
        scenario: testScenario.trim(),
      })
      setTestScenarios(res.test_scenarios || [])
      setRecommendedEvaluators(res.recommended_evaluators || [])
      setSelectedScenarioIdx(0)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Test data generation failed')
    } finally {
      setGeneratingTests(false)
    }
  }

  async function handleRunTest() {
    if (!savedInstallationId || testScenarios.length === 0) return
    const scenario = testScenarios[selectedScenarioIdx]
    setRunningTest(true)
    setTestRunStatus('starting')
    setTestRunResult(null)
    setTestRunId(null)
    setError('')
    try {
      const runRes = await fetch(`${AGENT_RUNTIME_URL}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installation_id: savedInstallationId,
          study_id: scenario.input_context?.study_id || 'VIBE-TEST-001',
          org_id: orgId,
          input_context: { ...scenario.input_context, vibe_test: true, scenario_name: scenario.name },
          is_test_run: true,
        }),
      })
      if (!runRes.ok) throw new Error(`Run failed: HTTP ${runRes.status}`)
      const runData = await runRes.json()
      const runId = runData.run_id || runData.id
      setTestRunId(runId)
      setTestRunStatus('running')

      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const pollRes = await fetch(`${AGENT_RUNTIME_URL}/runs/${runId}`)
        if (!pollRes.ok) continue
        const pollData = await pollRes.json()
        const status = pollData.status || pollData.run_status
        setTestRunStatus(status)
        if (status === 'completed' || status === 'failed' || status === 'error') {
          setTestRunResult(pollData)
          break
        }
      }

      // Load evaluator catalog
      const catRes = await fetch(`${AGENT_RUNTIME_URL}/evaluators/catalog?org_id=${orgId}`)
      if (catRes.ok) {
        const catData = await catRes.json()
        setEvaluatorCatalog(catData.evaluators || catData || [])
      }
      setRightTab('evaluate')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Test run failed')
      setTestRunStatus('error')
    } finally {
      setRunningTest(false)
    }
  }

  async function handleRunEvaluator(evaluatorId: string, evaluatorName: string) {
    if (!testRunId) return
    setRunningEvaluator(evaluatorId)
    setEvaluatorResults(r => [
      ...r.filter(x => x.evaluator_id !== evaluatorId),
      { evaluator_id: evaluatorId, evaluator_name: evaluatorName, status: 'running' },
    ])
    try {
      const res = await fetch(`${AGENT_RUNTIME_URL}/runs/${testRunId}/evaluate/${evaluatorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setEvaluatorResults(r => [
        ...r.filter(x => x.evaluator_id !== evaluatorId),
        {
          evaluator_id: evaluatorId,
          evaluator_name: evaluatorName,
          score: data.score ?? data.result?.score,
          verdict: data.verdict ?? data.result?.verdict,
          summary: data.summary ?? data.result?.summary ?? data.description,
          findings: data.findings ?? data.result?.findings ?? [],
          details: data,
          status: 'done',
        },
      ])
    } catch (e: unknown) {
      setEvaluatorResults(r => [
        ...r.filter(x => x.evaluator_id !== evaluatorId),
        { evaluator_id: evaluatorId, evaluator_name: evaluatorName, status: 'error', summary: String(e) },
      ])
    } finally {
      setRunningEvaluator(null)
    }
  }

  const isAgent = targetType === 'agent'
  const hasArtifacts = !!artifacts
  const hasHitl = hasArtifacts && ((artifacts.flow_definition?.nodes as Array<Record<string, unknown>>) || []).some(n => n.type === 'hitl')

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-brand-500 rounded-lg flex items-center justify-center">
              <Wand2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900">Vibe Builder</h1>
              <p className="text-xs text-slate-500">Describe what you want — get a complete, production-ready agent or skill in seconds</p>
            </div>
          </div>
          {hasArtifacts && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-slate-500">Confidence:</span>
                <span className={clsx('font-bold text-sm',
                  confidence >= 0.8 ? 'text-green-600' : confidence >= 0.6 ? 'text-amber-600' : 'text-red-600')}>
                  {Math.round(confidence * 100)}%
                </span>
              </div>
              {savedAgentId && (
                <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full border flex items-center gap-1',
                  isPublished ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200')}>
                  {isPublished ? <><CheckCircle className="w-3 h-3" /> Published</> : <><Eye className="w-3 h-3" /> Draft</>}
                </span>
              )}
              {error && (
                <span className="text-xs text-red-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />{error}
                </span>
              )}
              {savedAgentId && !isPublished && (
                <button onClick={handlePublish} disabled={publishing}
                  className="flex items-center gap-1.5 px-3 py-2 border border-brand-300 text-brand-600 hover:bg-brand-50 disabled:opacity-50 text-sm font-medium rounded-lg transition-colors">
                  {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                  {publishing ? 'Publishing...' : 'Publish'}
                </button>
              )}
              {savedAgentId && (
                <button onClick={() => router.push(`/agents/${savedSlug || savedAgentId}`)}
                  className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors">
                  <Eye className="w-3.5 h-3.5" /> View Agent
                </button>
              )}
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving...' : savedAgentId ? 'Save Draft' : `Save ${isAgent ? 'Agent' : 'Skill'}`}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT PANEL */}
        <div className="w-[480px] flex-shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-hidden">

          {/* Type + Mode selectors */}
          <div className="p-4 border-b border-slate-100 space-y-3 flex-shrink-0">
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              <button onClick={() => { setTargetType('agent'); setArtifacts(null); setPromptSearch('') }}
                className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors',
                  targetType === 'agent' ? 'bg-brand-500 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                <Bot className="w-3.5 h-3.5" /> Build an Agent
              </button>
              <button onClick={() => { setTargetType('skill'); setArtifacts(null); setPromptSearch('') }}
                className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors',
                  targetType === 'skill' ? 'bg-brand-500 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                <Wrench className="w-3.5 h-3.5" /> Build a Skill
              </button>
            </div>

            {isAgent && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1.5">Agent Type</p>
                <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                  <button onClick={() => { setAgentMode('standard'); setArtifacts(null) }}
                    className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                      agentMode === 'standard' ? 'bg-slate-700 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                    <GitBranch className="w-3.5 h-3.5" /> Standard Agent
                  </button>
                  <button onClick={() => { setAgentMode('deep'); setArtifacts(null) }}
                    className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                      agentMode === 'deep' ? 'bg-amber-500 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                    <Users className="w-3.5 h-3.5" /> Deep Agent (HITL)
                  </button>
                </div>
                {agentMode === 'deep' && (
                  <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1.5 mt-1.5 leading-relaxed">
                    Deep agents include a Human-in-the-Loop review step, multi-phase reasoning, self-validation, and generate a custom review form for clinical expert approval — similar to the SDTM Mapper.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Standard Prompts */}
          <div className={clsx('border-b border-slate-100 flex-shrink-0', showPrompts && 'overflow-hidden')}>
            <button onClick={() => setShowPrompts(s => !s)}
              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-brand-500" />
                <span className="text-xs font-semibold text-slate-700">Standard Prompts</span>
                <span className="text-[10px] bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-full font-medium">{filteredPrompts.length}</span>
              </div>
              {showPrompts ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
            </button>

            {showPrompts && (
              <div className="px-3 pb-3 max-h-64 overflow-y-auto space-y-2">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  <input value={promptSearch} onChange={e => setPromptSearch(e.target.value)}
                    placeholder="Search prompts..."
                    className="w-full pl-8 pr-8 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  {promptSearch && (
                    <button onClick={() => setPromptSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                      <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
                    </button>
                  )}
                </div>
                {filteredPrompts.length === 0
                  ? <p className="text-xs text-slate-400 text-center py-3">No matching prompts</p>
                  : filteredPrompts.map((p, i) => <PromptCard key={i} p={p} onUse={usePrompt} />)
                }
              </div>
            )}
          </div>

          {/* Prompt textarea + generate */}
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-y-auto min-h-0">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700">Your Description</label>
              {description && (
                <button onClick={() => setDescription('')} className="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-0.5">
                  <X className="w-3 h-3" /> Clear
                </button>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={description}
              onChange={e => setDescription(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate() }}
              placeholder={
                isAgent && agentMode === 'deep'
                  ? 'Describe the deep agent: what data it reads, how it reasons through multiple steps, what the clinical expert reviews in the HITL step, and what outputs it produces after approval...\n\nTip: use a standard prompt above as a starting point.'
                  : isAgent
                  ? 'Describe the agent: what data it reads, what it analyses or transforms, compliance rules it should follow, and what it produces...\n\nTip: use a standard prompt above as a starting point.'
                  : 'Describe the skill: input data format, the transformation or computation to perform, output format, and edge cases to handle...'
              }
              className="w-full flex-1 text-sm border border-slate-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 text-slate-700 placeholder-slate-300 leading-relaxed"
              style={{ minHeight: '200px' }}
            />
            <p className="text-[10px] text-slate-400 -mt-1">⌘+Enter to generate</p>

            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{error}
              </div>
            )}

            <button onClick={handleGenerate} disabled={loading || !description.trim()}
              className="w-full flex items-center justify-center gap-2 py-3 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {loading ? 'Generating...' : `Generate ${isAgent ? (agentMode === 'deep' ? 'Deep Agent' : 'Agent') : 'Skill'}`}
            </button>

            {hasArtifacts && (
              <div className="space-y-2 p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Confidence</span>
                  <span className={clsx('font-bold',
                    confidence >= 0.8 ? 'text-green-600' : confidence >= 0.6 ? 'text-amber-600' : 'text-red-600')}>
                    {Math.round(confidence * 100)}%
                  </span>
                </div>
                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all',
                    confidence >= 0.8 ? 'bg-green-500' : confidence >= 0.6 ? 'bg-amber-400' : 'bg-red-400')}
                    style={{ width: `${Math.round(confidence * 100)}%` }} />
                </div>

                {/* Auto-fixes applied banner */}
                {autoFixes.length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-2">
                    <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-green-500" />
                    <div>
                      <span className="font-semibold">{autoFixes.length} issue{autoFixes.length !== 1 ? 's' : ''} auto-fixed</span>
                      <ul className="mt-0.5 space-y-0.5">
                        {autoFixes.map((f, i) => (
                          <li key={i} className="text-[10px] text-green-600">✓ {f.fix} ({f.location})</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {/* Structured warnings with recommended fixes */}
                {warningsStructured.length > 0 && (
                  <div className="space-y-1.5">
                    {/* Auto-fix all button */}
                    {warningsStructured.some(w => w.auto_fixable) && (
                      <button onClick={handleAutoFix} disabled={autofixing}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors">
                        {autofixing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                        {autofixing ? 'Fixing...' : `Auto-fix ${warningsStructured.filter(w => w.auto_fixable).length} issue${warningsStructured.filter(w => w.auto_fixable).length !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    {warningsStructured.map((w, i) => (
                      <div key={i} className={clsx('rounded-lg border px-2.5 py-2 text-xs',
                        w.severity === 'error' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200')}>
                        <div className="flex items-start gap-1.5">
                          <AlertTriangle className={clsx('w-3 h-3 mt-0.5 flex-shrink-0',
                            w.severity === 'error' ? 'text-red-500' : 'text-amber-500')} />
                          <div className="flex-1 min-w-0">
                            <p className={w.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{w.message}</p>
                            {w.location && <p className="text-[10px] text-slate-400 mt-0.5">📍 {w.location}</p>}
                            <p className={clsx('text-[10px] mt-1 font-medium',
                              w.auto_fixable ? 'text-green-700' : 'text-slate-500')}>
                              {w.auto_fixable ? '⚡ ' : '💡 '}{w.recommended_fix}
                            </p>
                          </div>
                          {w.auto_fixable && <span className="text-[9px] bg-green-100 text-green-700 border border-green-200 px-1 py-0.5 rounded font-medium flex-shrink-0">Auto-fixable</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {warningsStructured.length === 0 && confidence >= 0.8 && (
                  <div className="flex items-center gap-1.5 text-xs text-green-700">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500" /> No issues detected — ready to save
                  </div>
                )}
              </div>
            )}

            {/* Chat / Refinement History */}
            {hasArtifacts && (
              <div className="flex-1 flex flex-col min-h-0 border border-slate-200 rounded-xl overflow-hidden bg-white">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50 flex-shrink-0">
                  <MessageSquare className="w-3.5 h-3.5 text-brand-500" />
                  <span className="text-xs font-semibold text-slate-700">Refinement Chat</span>
                  {chatHistory.length > 0 && (
                    <span className="text-[10px] bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-full font-medium ml-auto">
                      {chatHistory.length} message{chatHistory.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0" style={{ maxHeight: '220px' }}>
                  {chatHistory.length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-4">
                      Ask me to refine, add nodes, change logic, generate test data, or explain the agent...
                    </p>
                  )}
                  {chatHistory.map((msg, i) => (
                    <div key={i} className={clsx('flex flex-col gap-0.5', msg.role === 'user' ? 'items-end' : 'items-start')}>
                      <div className={clsx('max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed',
                        msg.role === 'user'
                          ? 'bg-brand-500 text-white rounded-br-sm'
                          : 'bg-slate-100 text-slate-700 rounded-bl-sm')}>
                        {msg.content}
                      </div>
                      {msg.changesSummary && (
                        <span className="text-[10px] text-slate-400 flex items-center gap-1 px-1">
                          <Zap className="w-2.5 h-2.5 text-amber-400" />{msg.changesSummary}
                        </span>
                      )}
                      {msg.artifactSnapshot && (
                        <button
                          onClick={() => { setArtifacts(msg.artifactSnapshot!); setConfidence(0) }}
                          className="text-[10px] text-brand-600 hover:underline px-1">
                          ↩ Restore this version
                        </button>
                      )}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="border-t border-slate-100 p-2 flex-shrink-0">
                  <div className="flex gap-2">
                    <textarea
                      value={refinement}
                      onChange={e => setRefinement(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRefine() } }}
                      placeholder="Ask to refine... (Enter to send, Shift+Enter for newline)"
                      rows={2}
                      className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-brand-500 text-slate-700 placeholder-slate-300" />
                    <button onClick={handleRefine} disabled={refining || !refinement.trim()}
                      className="px-3 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg flex items-center justify-center flex-shrink-0 transition-colors self-end">
                      {refining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          {hasArtifacts && (
            <div className="flex items-center gap-0 border-b border-slate-200 bg-white flex-shrink-0 px-4">
              {([
                { key: 'artifacts', label: 'Artifacts', icon: <Sparkles className="w-3.5 h-3.5" /> },
                { key: 'test', label: 'Test', icon: <FlaskConical className="w-3.5 h-3.5" /> },
                { key: 'evaluate', label: 'Evaluate', icon: <BarChart2 className="w-3.5 h-3.5" />, badge: evaluatorResults.filter(r => r.status === 'done').length || undefined },
              ] as Array<{ key: RightTab; label: string; icon: React.ReactNode; badge?: number }>).map(tab => (
                <button key={tab.key} onClick={() => setRightTab(tab.key)}
                  className={clsx('flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors relative',
                    rightTab === tab.key
                      ? 'text-brand-600 border-brand-600'
                      : 'text-slate-500 border-transparent hover:text-slate-700')}>
                  {tab.icon}{tab.label}
                  {tab.badge ? (
                    <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-brand-500 text-white text-[10px] rounded-full flex items-center justify-center">
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {rightTab === 'test' && hasArtifacts ? (
              <div className="p-6 space-y-5">
                <div>
                  <h2 className="text-sm font-bold text-slate-800 mb-1">Test Your Agent</h2>
                  <p className="text-xs text-slate-500">Generate synthetic test data with AI, then run a live test against your saved draft.</p>
                </div>
                {!savedAgentId && (
                  <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    Save the agent as a draft first before running tests.
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-700">Test Scenario (optional)</label>
                  <textarea value={testScenario} onChange={e => setTestScenario(e.target.value)}
                    placeholder="Describe a specific test scenario, e.g. 'Test with a patient who has 3 severe AEs and a protocol deviation in Visit 2'"
                    rows={3}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 text-slate-700 placeholder-slate-300" />
                  <button onClick={handleGenerateTestData} disabled={generatingTests || !artifacts}
                    className="w-full flex items-center justify-center gap-2 py-2.5 border border-brand-300 text-brand-600 hover:bg-brand-50 disabled:opacity-50 text-sm font-medium rounded-xl transition-colors">
                    {generatingTests ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {generatingTests ? 'Generating test data...' : 'Generate Test Data with AI'}
                  </button>
                </div>

                {testScenarios.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-700">Generated Test Scenarios</p>
                      <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{testScenarios.length} scenarios</span>
                    </div>
                    <div className="space-y-2">
                      {testScenarios.map((s, i) => (
                        <button key={i} onClick={() => setSelectedScenarioIdx(i)}
                          className={clsx('w-full text-left p-3 rounded-xl border transition-colors',
                            selectedScenarioIdx === i ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300')}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                              s.test_type === 'happy_path' ? 'bg-green-50 text-green-700' :
                              s.test_type === 'edge_case' ? 'bg-amber-50 text-amber-700' :
                              'bg-red-50 text-red-700')}>{s.test_type?.replace('_', ' ')}</span>
                            <span className="text-xs font-semibold text-slate-800">{s.name}</span>
                          </div>
                          <p className="text-xs text-slate-500">{s.description}</p>
                          {selectedScenarioIdx === i && (
                            <div className="mt-2 pt-2 border-t border-brand-100">
                              <p className="text-[10px] font-medium text-slate-500 mb-1">Input Context</p>
                              <pre className="text-[10px] text-slate-600 bg-white border border-slate-100 rounded-lg p-2 overflow-x-auto max-h-24 font-mono">
                                {JSON.stringify(s.input_context, null, 2)}
                              </pre>
                              <p className="text-[10px] text-slate-500 mt-1.5"><span className="font-medium">Expected:</span> {s.expected_behavior}</p>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                    <button onClick={handleRunTest} disabled={runningTest || !savedInstallationId}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
                      {runningTest ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      {runningTest ? `Running test... (${testRunStatus || 'starting'})` : 'Run Selected Test'}
                    </button>
                  </div>
                )}

                {testRunResult && (
                  <div className={clsx('p-4 rounded-xl border', testRunStatus === 'completed' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200')}>
                    <div className="flex items-center gap-2 mb-2">
                      {testRunStatus === 'completed' ? <CheckCircle className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-red-600" />}
                      <span className="text-sm font-semibold">{testRunStatus === 'completed' ? 'Test Completed' : 'Test Failed'}</span>
                      {testRunId && <span className="text-[10px] text-slate-400 font-mono ml-auto">{testRunId.slice(0, 8)}...</span>}
                    </div>
                    {testRunResult.output != null && (
                      <pre className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-3 overflow-x-auto max-h-40 font-mono">
                        {typeof testRunResult.output === 'string' ? testRunResult.output : JSON.stringify(testRunResult.output, null, 2)}
                      </pre>
                    )}
                    <button onClick={() => setRightTab('evaluate')} className="mt-2 text-xs text-brand-600 hover:underline flex items-center gap-1">
                      <BarChart2 className="w-3.5 h-3.5" /> Run evaluators on this result →
                    </button>
                  </div>
                )}
              </div>
            ) : rightTab === 'evaluate' && hasArtifacts ? (
              <div className="p-6 space-y-5">
                <div>
                  <h2 className="text-sm font-bold text-slate-800 mb-1">Run Evaluators</h2>
                  <p className="text-xs text-slate-500">
                    {testRunId ? `Evaluating run ${testRunId.slice(0, 8)}...` : 'Run a test first, then evaluate its results here.'}
                  </p>
                </div>
                {!testRunId && (
                  <div className="flex items-center gap-2 p-3 bg-slate-100 border border-slate-200 rounded-xl text-xs text-slate-600">
                    <FlaskConical className="w-4 h-4 flex-shrink-0" />
                    No test run yet. Go to the Test tab to run a test first.
                  </div>
                )}
                {recommendedEvaluators.length > 0 && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Star className="w-3.5 h-3.5 text-amber-400" />
                    Recommended: {recommendedEvaluators.join(', ')}
                  </div>
                )}
                {evaluatorCatalog.length > 0 && (
                  <div className="space-y-3">
                    {evaluatorCatalog.map((ev) => {
                      const evId = String(ev.id || ev.evaluator_id || '')
                      const evName = String(ev.name || ev.evaluator_name || ev.id || '')
                      const result = evaluatorResults.find(r => r.evaluator_id === evId)
                      const isRecommended = recommendedEvaluators.some(r => r.toLowerCase().includes(evName.toLowerCase()) || evName.toLowerCase().includes(r.toLowerCase()))
                      return (
                        <div key={evId} className={clsx('border rounded-xl overflow-hidden', isRecommended ? 'border-amber-200' : 'border-slate-200')}>
                          <div className="flex items-start gap-3 p-3 bg-white">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5">
                                {isRecommended && <Star className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                                <p className="text-sm font-semibold text-slate-800">{evName}</p>
                                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0',
                                  ev.type === 'llm_judge' ? 'bg-purple-50 text-purple-700' :
                                  ev.type === 'threshold' ? 'bg-blue-50 text-blue-700' :
                                  'bg-slate-100 text-slate-600')}>{String(ev.type || 'custom')}</span>
                              </div>
                              <p className="text-xs text-slate-500 line-clamp-2">{String(ev.description || '')}</p>
                            </div>
                            <button onClick={() => handleRunEvaluator(evId, evName)}
                              disabled={!testRunId || runningEvaluator === evId}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0">
                              {runningEvaluator === evId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              {result?.status === 'done' ? 'Re-run' : 'Run'}
                            </button>
                          </div>
                          {result && (
                            <div className={clsx('border-t px-3 py-2.5',
                              result.status === 'running' ? 'bg-slate-50' :
                              result.status === 'error' ? 'bg-red-50 border-red-100' :
                              'bg-white border-slate-100')}>
                              {result.status === 'running' && (
                                <div className="flex items-center gap-2 text-xs text-slate-500">
                                  <Loader2 className="w-3 h-3 animate-spin" /> Running evaluation...
                                </div>
                              )}
                              {result.status === 'done' && (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-3">
                                    {result.score != null && (
                                      <>
                                        <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                                          <div className={clsx('h-full rounded-full',
                                            result.score >= 0.8 ? 'bg-green-500' : result.score >= 0.5 ? 'bg-amber-400' : 'bg-red-400')}
                                            style={{ width: `${Math.round(result.score * 100)}%` }} />
                                        </div>
                                        <span className={clsx('text-sm font-bold',
                                          result.score >= 0.8 ? 'text-green-600' : result.score >= 0.5 ? 'text-amber-600' : 'text-red-600')}>
                                          {Math.round(result.score * 100)}%
                                        </span>
                                      </>
                                    )}
                                    {result.verdict && (
                                      <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded-full',
                                        result.verdict.toLowerCase().includes('pass') ? 'bg-green-50 text-green-700' :
                                        result.verdict.toLowerCase().includes('fail') ? 'bg-red-50 text-red-700' :
                                        'bg-slate-100 text-slate-600')}>{result.verdict}</span>
                                    )}
                                  </div>
                                  {result.summary && <p className="text-xs text-slate-700">{result.summary}</p>}
                                  {result.findings && result.findings.length > 0 && (
                                    <ul className="space-y-0.5">
                                      {result.findings.map((f, fi) => (
                                        <li key={fi} className="text-xs text-slate-600 flex items-start gap-1.5">
                                          <CheckSquare className="w-3 h-3 text-brand-400 mt-0.5 flex-shrink-0" />{f}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              )}
                              {result.status === 'error' && (
                                <p className="text-xs text-red-600">{result.summary}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {testRunId && evaluatorCatalog.length === 0 && (
                  <div className="text-center py-8 text-sm text-slate-400">
                    <BarChart2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    Loading evaluator catalog...
                  </div>
                )}
              </div>
            ) : (
            <>
            {!hasArtifacts ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 gap-6">
              <div className="w-16 h-16 bg-brand-50 rounded-2xl flex items-center justify-center">
                <Wand2 className="w-8 h-8 text-brand-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-700 mb-2">
                  {isAgent ? `Build a ${agentMode === 'deep' ? 'Deep' : 'Standard'} Agent` : 'Build a Skill'}
                </h2>
                <p className="text-sm text-slate-400 max-w-sm mx-auto">
                  {isAgent && agentMode === 'deep'
                    ? "Pick a standard prompt or describe your deep agent. You'll get a complete spec with HITL flow, prompt contract, retrieval recipe, human review form schema, and test cases."
                    : isAgent
                    ? "Pick a standard prompt or describe your agent. You'll get a flow definition, prompt contract, retrieval recipe, output schema, and test cases."
                    : "Describe your skill. You'll get typed I/O contract, generated code or prompt template, safety constraints, and test cases."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-sm w-full text-left">
                {[
                  isAgent && agentMode === 'deep'
                    ? { icon: <Users className="w-4 h-4 text-amber-500" />, text: 'Human review form generated' }
                    : { icon: <GitBranch className="w-4 h-4 text-brand-500" />, text: 'Visual flow definition' },
                  { icon: <Brain className="w-4 h-4 text-purple-500" />, text: 'System prompt generated' },
                  { icon: <CheckCircle className="w-4 h-4 text-green-500" />, text: 'Test cases included' },
                  { icon: <Sparkles className="w-4 h-4 text-brand-500" />, text: 'Ready to save and run' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-slate-600 bg-white border border-slate-100 rounded-lg p-2.5">
                    {item.icon} {item.text}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-6 space-y-4 max-w-3xl">
              {isAgent ? (
                <>
                  <ArtifactCard title="Agent Spec"
                    onRegenerate={() => handleSectionRegenerate('agent_spec')}
                    loading={sectionRefining === 'agent_spec'}
                    badge={
                      <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-medium',
                        String(artifacts.agent_spec?.agent_mode || agentMode) === 'deep'
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-slate-100 text-slate-600')}>
                        {String(artifacts.agent_spec?.agent_mode || agentMode)}
                      </span>
                    }>
                    {editingSection === 'agent_spec' ? (
                      <div className="space-y-2">
                        <textarea value={editValue} onChange={e => setEditValue(e.target.value)} rows={6}
                          className="w-full text-xs font-mono border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                        <div className="flex gap-2">
                          <button onClick={() => applyEdit('agent_spec')} className="px-3 py-1 bg-brand-500 text-white text-xs rounded-lg">Apply</button>
                          <button onClick={() => setEditingSection(null)} className="px-3 py-1 bg-slate-100 text-slate-600 text-xs rounded-lg">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-900">{String(artifacts.agent_spec?.name || '—')}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{String(artifacts.agent_spec?.description || '')}</p>
                          </div>
                          <button onClick={() => startEdit('agent_spec', artifacts.agent_spec)} className="p-1 text-slate-400 hover:text-brand-600 flex-shrink-0">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {(artifacts.agent_spec?.category as string | undefined) && (
                            <span className="px-2 py-0.5 bg-brand-50 text-brand-700 border border-brand-100 rounded text-xs">{String(artifacts.agent_spec!.category)}</span>
                          )}
                          {(artifacts.agent_spec?.version as string | undefined) && (
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">v{String(artifacts.agent_spec!.version)}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </ArtifactCard>

                  <ArtifactCard
                    title={`Flow Definition (${((artifacts.flow_definition?.nodes as unknown[]) || []).length} nodes)`}
                    onRegenerate={() => handleSectionRegenerate('flow_definition')}
                    loading={sectionRefining === 'flow_definition'}>
                    {artifacts.flow_definition && <FlowPreview flow={artifacts.flow_definition} />}
                  </ArtifactCard>

                  {(hasHitl || artifacts.hitl_form_schema) && (
                    <ArtifactCard
                      title="Human Review Form Schema"
                      onRegenerate={() => handleSectionRegenerate('hitl_form_schema')}
                      loading={sectionRefining === 'hitl_form_schema'}
                      badge={<span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Users className="w-2.5 h-2.5" /> HITL</span>}>
                      {artifacts.hitl_form_schema
                        ? <HitlFormPreview schema={artifacts.hitl_form_schema} />
                        : (
                          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                            <p className="font-medium mb-1">HITL node detected in flow</p>
                            <p>This agent includes a human review step. Click <RefreshCw className="w-3 h-3 inline mx-0.5" /> to generate a detailed form schema specifying what fields the reviewer will see and interact with.</p>
                          </div>
                        )}
                    </ArtifactCard>
                  )}

                  <ArtifactCard title="Retrieval Recipe"
                    onRegenerate={() => handleSectionRegenerate('retrieval_recipe')}
                    loading={sectionRefining === 'retrieval_recipe'}>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1.5">Data Sources</p>
                        <div className="flex flex-wrap gap-1.5">
                          {((artifacts.retrieval_recipe?.data_sources as string[]) || []).map((s, i) => (
                            <span key={i} className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-100 rounded text-xs">{s}</span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1.5">Declared Tools</p>
                        <div className="flex flex-wrap gap-1.5">
                          {((artifacts.retrieval_recipe?.declared_tools as string[]) || []).map((t, i) => (
                            <span key={i} className="px-2 py-0.5 bg-green-50 text-green-700 border border-green-100 rounded text-xs font-mono">{t}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </ArtifactCard>

                  <ArtifactCard title="Prompt Contract"
                    onRegenerate={() => handleSectionRegenerate('prompt_contract')}
                    loading={sectionRefining === 'prompt_contract'}>
                    {editingSection === 'prompt_contract' ? (
                      <div className="space-y-2">
                        <textarea value={editValue} onChange={e => setEditValue(e.target.value)} rows={10}
                          className="w-full text-xs font-mono border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                        <div className="flex gap-2">
                          <button onClick={() => applyEdit('prompt_contract')} className="px-3 py-1 bg-brand-500 text-white text-xs rounded-lg">Apply</button>
                          <button onClick={() => setEditingSection(null)} className="px-3 py-1 bg-slate-100 text-slate-600 text-xs rounded-lg">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs text-slate-500 font-medium">System Prompt</p>
                          <button onClick={() => startEdit('prompt_contract', artifacts.prompt_contract)} className="p-1 text-slate-400 hover:text-brand-600">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <pre className="text-xs bg-slate-50 rounded-lg p-3 border border-slate-200 text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
                          {String((artifacts.prompt_contract as Record<string, unknown>)?.system_prompt || '—')}
                        </pre>
                      </div>
                    )}
                  </ArtifactCard>

                  <ArtifactCard title="Output Schema"
                    onRegenerate={() => handleSectionRegenerate('output_schema')}
                    loading={sectionRefining === 'output_schema'}>
                    <div className="space-y-1.5">
                      {!!(artifacts.output_schema?.format) && (
                        <p className="text-xs text-slate-600">Format: <span className="font-medium">{String(artifacts.output_schema.format)}</span></p>
                      )}
                      {((artifacts.output_schema?.fields as Array<Record<string, string>>) || []).map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded">{f.name}</span>
                          <span className="text-slate-400">{f.type}</span>
                          <span className="text-slate-500 truncate">{f.description}</span>
                        </div>
                      ))}
                    </div>
                  </ArtifactCard>

                  <ArtifactCard title={`Test Cases (${(artifacts.test_cases || []).length})`}
                    onRegenerate={() => handleSectionRegenerate('test_cases')}
                    loading={sectionRefining === 'test_cases'}>
                    <div className="space-y-2">
                      {(artifacts.test_cases || []).map((tc: unknown, i: number) => {
                        const t = tc as Record<string, unknown>
                        return (
                          <div key={i} className="border border-slate-100 rounded-lg p-3 bg-slate-50">
                            <div className="flex items-center gap-2 mb-1">
                              <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
                              <p className="text-xs font-medium text-slate-800">{String(t.name || `Test ${i + 1}`)}</p>
                            </div>
                            {!!t.description && <p className="text-xs text-slate-500 mb-1">{String(t.description)}</p>}
                            <p className="text-xs text-slate-400">Expected: {String(t.expected_output || '—')}</p>
                            {!!t.success_criteria && <p className="text-xs text-slate-400 mt-0.5">Criteria: {String(t.success_criteria)}</p>}
                          </div>
                        )
                      })}
                    </div>
                  </ArtifactCard>

                  {(artifacts.skills || []).length > 0 && (
                    <ArtifactCard
                      title={`Generated Skills (${(artifacts.skills || []).length})`}
                      onRegenerate={() => handleSectionRegenerate('skills')}
                      loading={sectionRefining === 'skills'}
                      badge={<span className="text-[10px] bg-pink-50 text-pink-700 border border-pink-200 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Wrench className="w-2.5 h-2.5" /> Auto-generated</span>}>
                      <div className="space-y-3">
                        <p className="text-xs text-slate-500">These skills will be created and linked to the agent automatically when you save.</p>
                        {(artifacts.skills || []).map((skill, i) => (
                          <SkillCard key={i} skill={skill} />
                        ))}
                      </div>
                    </ArtifactCard>
                  )}
                </>
              ) : (
                <>
                  <ArtifactCard title="Skill Spec"
                    onRegenerate={() => handleSectionRegenerate('skill_spec')}
                    loading={sectionRefining === 'skill_spec'}>
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-900">{String(artifacts.skill_spec?.name || '—')}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{String(artifacts.skill_spec?.description || '')}</p>
                        </div>
                        <button onClick={() => startEdit('skill_spec', artifacts.skill_spec)} className="p-1 text-slate-400 hover:text-brand-600">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {!!(artifacts.skill_spec?.skill_type) && (
                          <span className="px-2 py-0.5 bg-brand-50 text-brand-700 border border-brand-100 rounded text-xs">{String(artifacts.skill_spec.skill_type)}</span>
                        )}
                        {((artifacts.skill_spec?.tags as string[]) || []).map((t, i) => (
                          <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">{t}</span>
                        ))}
                      </div>
                    </div>
                  </ArtifactCard>

                  <ArtifactCard title="Input / Output Contract"
                    onRegenerate={() => handleSectionRegenerate('input_output_contract')}
                    loading={sectionRefining === 'input_output_contract'}>
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-slate-500">Input Schema</p>
                      <JsonViewer data={(artifacts.input_output_contract as Record<string, unknown>)?.input_schema || {}} />
                      <p className="text-xs font-medium text-slate-500">Output Schema</p>
                      <JsonViewer data={(artifacts.input_output_contract as Record<string, unknown>)?.output_schema || {}} />
                    </div>
                  </ArtifactCard>

                  <ArtifactCard title="Execution Type">
                    <span className={clsx('px-3 py-1 rounded-full text-sm font-medium',
                      artifacts.execution_type === 'transformation' ? 'bg-blue-50 text-blue-700 border border-blue-200' :
                      artifacts.execution_type === 'reasoning' ? 'bg-purple-50 text-purple-700 border border-purple-200' :
                      artifacts.execution_type === 'query' ? 'bg-green-50 text-green-700 border border-green-200' :
                      'bg-amber-50 text-amber-700 border border-amber-200')}>
                      {artifacts.execution_type || 'reasoning'}
                    </span>
                  </ArtifactCard>

                  {(artifacts.safety_constraints || []).length > 0 && (
                    <ArtifactCard title="Safety Constraints">
                      <ul className="space-y-1">
                        {(artifacts.safety_constraints || []).map((c, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />{c}
                          </li>
                        ))}
                      </ul>
                    </ArtifactCard>
                  )}

                  <ArtifactCard title="Code / Prompt Body"
                    onRegenerate={() => handleSectionRegenerate('body')}
                    loading={sectionRefining === 'body'}>
                    {editingSection === 'body' ? (
                      <div className="space-y-2">
                        <textarea value={editValue} onChange={e => setEditValue(e.target.value)} rows={16}
                          className="w-full text-xs font-mono border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                        <div className="flex gap-2">
                          <button onClick={() => applyEdit('body')} className="px-3 py-1 bg-brand-500 text-white text-xs rounded-lg">Apply</button>
                          <button onClick={() => setEditingSection(null)} className="px-3 py-1 bg-slate-100 text-slate-600 text-xs rounded-lg">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative">
                        <button onClick={() => startEdit('body', artifacts.body || '')} className="absolute top-2 right-2 p-1 text-slate-400 hover:text-brand-600 bg-slate-800 rounded z-10">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-4 overflow-auto max-h-80 font-mono leading-relaxed">
                          {artifacts.body || '# No code generated'}
                        </pre>
                      </div>
                    )}
                  </ArtifactCard>

                  <ArtifactCard title={`Test Cases (${(artifacts.test_cases || []).length})`}
                    onRegenerate={() => handleSectionRegenerate('test_cases')}
                    loading={sectionRefining === 'test_cases'}>
                    <div className="space-y-2">
                      {(artifacts.test_cases || []).map((tc: unknown, i: number) => {
                        const t = tc as Record<string, unknown>
                        return (
                          <div key={i} className="border border-slate-100 rounded-lg p-3 bg-slate-50 text-xs">
                            <div className="flex items-center gap-2 mb-1">
                              <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
                              <p className="font-medium text-slate-800">{String(t.name || `Test ${i + 1}`)}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-1">
                              <div>
                                <p className="text-slate-400 mb-0.5">Input</p>
                                <pre className="text-slate-600 bg-white rounded p-1.5 border border-slate-100 overflow-auto max-h-16">{JSON.stringify(t.input, null, 1)}</pre>
                              </div>
                              <div>
                                <p className="text-slate-400 mb-0.5">Expected</p>
                                <p className="text-slate-600">{String(t.expected_output || '—')}</p>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </ArtifactCard>
                </>
              )}
            </div>
          )}
          </>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
