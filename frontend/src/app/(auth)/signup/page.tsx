'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

export default function SignupPage() {
  const { signup } = useAuth()
  const [form, setForm] = useState({ name: '', org_name: '', email: '', password: '' })
  const [loading, setLoading] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (form.password.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    try {
      await signup(form)
    } catch (err: any) {
      toast.error(err.message || 'Signup failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <h1 className="text-xl font-bold text-slate-900 mb-1">Create your account</h1>
      <p className="text-sm text-slate-500 mb-6">Get your organization started on TrialOS</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Full Name</label>
          <input
            type="text"
            value={form.name}
            onChange={set('name')}
            required
            autoFocus
            placeholder="Jane Smith"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Organization Name</label>
          <input
            type="text"
            value={form.org_name}
            onChange={set('org_name')}
            required
            placeholder="Acme Pharma"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Work Email</label>
          <input
            type="email"
            value={form.email}
            onChange={set('email')}
            required
            placeholder="jane@acme.com"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Password</label>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
            placeholder="Min. 8 characters"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Create account
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-600 font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
