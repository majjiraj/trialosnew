'use client'
import { useEffect, useState, useCallback } from 'react'
import { Wand2, Plus, Loader2, RefreshCw, Globe, EyeOff, Pencil, Trash2, X, Sparkles, Code2, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/components/layout/AuthContext'
import { useRouter } from 'next/navigation'
import { clsx } from 'clsx'

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'

interface StandardSkill {
  id: string
  name: string
  description: string
  skill_type: 'function' | 'prompt'
  body?: string
  input_schema?: Record<string, unknown>
  tags: string[]
  is_published: boolean
  published_at: string | null
  created_at: string
}

type FilterTab = 'all' | 'function' | 'prompt'

const emptyForm = {
  name: '',
  description: '',
  skill_type: 'function' as 'function' | 'prompt',
  body: '',
  tags: '',
}

export default function StandardSkillsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  const [skills, setSkills] = useState<StandardSkill[]>([])
  const [fetching, setFetching] = useState(true)
  const [filter, setFilter] = useState<FilterTab>('all')
  const [showModal, setShowModal] = useState(false)
  const [editSkill, setEditSkill] = useState<StandardSkill | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateDesc, setGenerateDesc] = useState('')

  useEffect(() => {
    if (!loading && !user?.is_platform_admin) router.push('/')
  }, [user, loading, router])

  const load = useCallback(async () => {
    setFetching(true)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/standard`)
      const d = await r.json()
      setSkills(d.skills || [])
    } catch {
      // service may not be running
    } finally {
      setFetching(false)
    }
  }, [])

  useEffect(() => {
    if (user?.is_platform_admin) load()
  }, [user, load])

  const openCreate = () => {
    setEditSkill(null)
    setForm(emptyForm)
    setGenerateDesc('')
    setShowModal(true)
  }

  const openEdit = async (skill: StandardSkill) => {
    setEditSkill(skill)
    setGenerateDesc('')
    try {
      // Fetch full skill (with body) — use org_id absent for platform skill
      const r = await fetch(`${MARKETPLACE_URL}/skills/standard`)
      // Already have the list; just fetch by checking full body via a hack-free route
      // We use the standard list which doesn't include body, so let's re-use the org skill endpoint
      // with a workaround: pass org_id as empty and fall through — instead just open with what we have
      setForm({
        name: skill.name,
        description: skill.description,
        skill_type: skill.skill_type,
        body: skill.body || '',
        tags: (skill.tags || []).join(', '),
      })
    } catch {
      setForm({
        name: skill.name,
        description: skill.description,
        skill_type: skill.skill_type,
        body: skill.body || '',
        tags: (skill.tags || []).join(', '),
      })
    }
    setShowModal(true)
  }

  const loadFullSkill = async (skill: StandardSkill) => {
    // Fetch full skill body from the standard list (body not included in list response)
    // We'll fetch from a dedicated endpoint once available, for now re-fetch list and find
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/standard`)
      const d = await r.json()
      const full = (d.skills || []).find((s: StandardSkill) => s.id === skill.id)
      return full || skill
    } catch {
      return skill
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
          org_id: null,
          description: generateDesc,
          skill_type: form.skill_type,
        }),
      })
      const d = await r.json()
      if (d.generated_body) setForm(f => ({ ...f, body: d.generated_body }))
      if (d.suggested_name && !form.name) setForm(f => ({ ...f, name: d.suggested_name }))
      if (d.description && !form.description) setForm(f => ({ ...f, description: d.description }))
      toast.success('Skill generated — review before saving')
    } catch {
      toast.error('Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    if (!form.body.trim()) { toast.error('Skill body is required'); return }
    setSaving(true)
    try {
      const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean)
      const payload = {
        org_id: null,
        name: form.name.trim(),
        description: form.description.trim(),
        skill_type: form.skill_type,
        body: form.body,
        tags,
        created_by: user?.id,
      }

      if (editSkill) {
        const r = await fetch(`${MARKETPLACE_URL}/skills/${editSkill.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload }),
        })
        if (!r.ok) throw new Error('Failed to update skill')
        toast.success('Skill updated')
      } else {
        const r = await fetch(`${MARKETPLACE_URL}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({})) as { detail?: string }
          throw new Error(err.detail || 'Failed to create skill')
        }
        toast.success('Standard skill created')
      }
      setShowModal(false)
      load()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const togglePublish = async (skill: StandardSkill) => {
    setToggling(skill.id)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/${skill.id}/publish`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_published: !skill.is_published, published_by: user?.id }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success(skill.is_published ? 'Skill unpublished' : 'Skill published to tenants')
      setSkills(ss => ss.map(s => s.id === skill.id ? { ...s, is_published: !s.is_published } : s))
    } catch {
      toast.error('Failed to update skill')
    } finally {
      setToggling(null)
    }
  }

  const handleDelete = async (skill: StandardSkill) => {
    if (!confirm(`Delete standard skill "${skill.name}"? This cannot be undone.`)) return
    setDeleting(skill.id)
    try {
      const r = await fetch(`${MARKETPLACE_URL}/skills/${skill.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error('Failed')
      toast.success('Skill deleted')
      setSkills(ss => ss.filter(s => s.id !== skill.id))
    } catch {
      toast.error('Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const filtered = filter === 'all' ? skills : skills.filter(s => s.skill_type === filter)

  if (loading || !user?.is_platform_admin) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Standard Skills</h1>
          <p className="text-sm text-slate-500 mt-1">
            Published skills are available to all tenant agents by direct reference or clone
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />New Skill
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1">
        {(['all', 'function', 'prompt'] as FilterTab[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors',
              filter === f ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'
            )}
          >{f}</button>
        ))}
      </div>

      {/* Skills table */}
      <div className="card">
        {fetching ? (
          <div className="px-5 py-10 flex items-center justify-center gap-2 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Wand2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No standard skills yet. Create one to share with tenants.</p>
          </div>
        ) : filtered.map(skill => (
          <div key={skill.id}
            className="px-5 py-4 flex items-center gap-4 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
            <div className={clsx(
              'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
              skill.skill_type === 'function' ? 'bg-green-50' : 'bg-purple-50'
            )}>
              {skill.skill_type === 'function'
                ? <Code2 className="w-4 h-4 text-green-600" />
                : <MessageSquare className="w-4 h-4 text-purple-600" />}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-900">{skill.name}</span>
                <span className={clsx(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                  skill.skill_type === 'function' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'
                )}>{skill.skill_type}</span>
                {skill.is_published && (
                  <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full">
                    <Globe className="w-3 h-3" />Published
                  </span>
                )}
              </div>
              {skill.description && (
                <p className="text-xs text-slate-500 mt-0.5 truncate">{skill.description}</p>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {(skill.tags || []).map(tag => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">{tag}</span>
                ))}
                <span className="text-xs text-slate-400">
                  {skill.published_at
                    ? `Published ${new Date(skill.published_at).toLocaleDateString()}`
                    : `Created ${new Date(skill.created_at).toLocaleDateString()}`}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => togglePublish(skill)}
                disabled={toggling === skill.id}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                  skill.is_published
                    ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    : 'border-green-200 text-green-600 hover:bg-green-50'
                )}
              >
                {toggling === skill.id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : skill.is_published
                    ? <><EyeOff className="w-3 h-3" />Unpublish</>
                    : <><Globe className="w-3 h-3" />Publish</>}
              </button>
              <button
                onClick={() => openEdit(skill)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDelete(skill)}
                disabled={deleting === skill.id}
                className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
              >
                {deleting === skill.id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">
                {editSkill ? `Edit: ${editSkill.name}` : 'New Standard Skill'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. sdtm_ae_mapper"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Description</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="One-line description of what this skill does"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* Type + Tags row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Type</label>
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm font-medium">
                    <button
                      onClick={() => setForm(f => ({ ...f, skill_type: 'function' }))}
                      className={clsx(
                        'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 transition-colors',
                        form.skill_type === 'function' ? 'bg-green-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                      )}
                    >
                      <Code2 className="w-3.5 h-3.5" />Function
                    </button>
                    <button
                      onClick={() => setForm(f => ({ ...f, skill_type: 'prompt' }))}
                      className={clsx(
                        'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 transition-colors',
                        form.skill_type === 'prompt' ? 'bg-purple-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                      )}
                    >
                      <MessageSquare className="w-3.5 h-3.5" />Prompt
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={form.tags}
                    onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                    placeholder="sdtm, cdisc, mapping"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>

              {/* AI Generate */}
              <div className="p-4 bg-gradient-to-br from-pink-50 to-purple-50 rounded-xl border border-pink-100">
                <div className="flex items-center gap-1.5 mb-2">
                  <Sparkles className="w-4 h-4 text-pink-500" />
                  <span className="text-sm font-semibold text-slate-800">Generate with AI</span>
                </div>
                <textarea
                  rows={2}
                  value={generateDesc}
                  onChange={e => setGenerateDesc(e.target.value)}
                  placeholder="Describe what this skill should do…"
                  className="w-full px-2.5 py-1.5 border border-pink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-pink-400 resize-none bg-white"
                />
                <button
                  onClick={handleGenerate}
                  disabled={generating || !generateDesc.trim()}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  <Sparkles className="w-3 h-3" />
                  {generating ? 'Generating…' : 'Generate'}
                </button>
              </div>

              {/* Body */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  {form.skill_type === 'function' ? 'Python Code *' : 'System Prompt *'}
                </label>
                {form.skill_type === 'function' && (
                  <p className="text-xs text-slate-400 mb-1">
                    Variables: <code className="text-pink-600">state_data</code>, <code className="text-pink-600">messages</code>, <code className="text-pink-600">params</code> — assign to <code className="text-pink-600">result</code>
                  </p>
                )}
                <textarea
                  rows={12}
                  value={form.body}
                  onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                  placeholder={form.skill_type === 'function'
                    ? '# Write your Python skill here\nresult = {}'
                    : 'You are a clinical expert…'}
                  className={clsx(
                    'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none',
                    form.skill_type === 'function' ? 'font-mono bg-slate-900 text-green-300' : ''
                  )}
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {editSkill ? 'Save Changes' : 'Create Skill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
