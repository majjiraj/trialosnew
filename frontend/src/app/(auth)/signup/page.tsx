'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  height: '40px',
  padding: '0 12px',
  border: '1.5px solid #C2CEDF',
  borderRadius: '8px',
  fontSize: '14px',
  color: '#0C1B3A',
  background: '#FFFFFF',
  outline: 'none',
  transition: 'border-color 120ms, box-shadow 120ms',
  fontFamily: 'inherit',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 500,
  color: '#2E4066',
  marginBottom: '6px',
}

function Field({
  label, type = 'text', value, onChange, placeholder, required, autoFocus, minLength,
}: {
  label: string
  type?: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  required?: boolean
  autoFocus?: boolean
  minLength?: number
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        minLength={minLength}
        style={inputStyle}
        onFocus={e => {
          e.target.style.borderColor = '#0EA5E9'
          e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.18)'
        }}
        onBlur={e => {
          e.target.style.borderColor = '#C2CEDF'
          e.target.style.boxShadow = 'none'
        }}
      />
    </div>
  )
}

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
    <div>
      <h1
        style={{
          fontSize: '26px',
          fontWeight: 700,
          color: '#0C1B3A',
          marginBottom: '6px',
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
        }}
      >
        Create your account
      </h1>
      <p style={{ fontSize: '14px', color: '#6478A0', marginBottom: '32px', lineHeight: 1.6 }}>
        Get your organization started on TrialOS
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <Field label="Full Name" value={form.name} onChange={set('name')} placeholder="Jane Smith" required autoFocus />
        <Field label="Organization Name" value={form.org_name} onChange={set('org_name')} placeholder="Acme Pharma" required />
        <Field label="Work Email" type="email" value={form.email} onChange={set('email')} placeholder="jane@acme.com" required />
        <Field label="Password" type="password" value={form.password} onChange={set('password')} placeholder="Min. 8 characters" required minLength={8} />

        <button
          type="submit"
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            width: '100%',
            height: '46px',
            background: loading ? '#6B7A9A' : 'linear-gradient(135deg, #1A3680, #1D4ED8)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            letterSpacing: '-0.01em',
            boxShadow: loading ? 'none' : '0 1px 3px rgba(29,78,216,0.4)',
            fontFamily: 'inherit',
          }}
        >
          {loading && <Loader2 style={{ width: '16px', height: '16px' }} />}
          Create account
        </button>
      </form>

      <p style={{ textAlign: 'center', fontSize: '13px', color: '#6478A0', marginTop: '24px' }}>
        Already have an account?{' '}
        <Link href="/login" style={{ color: '#0284C7', fontWeight: 600, textDecoration: 'none' }}>
          Sign in
        </Link>
      </p>
    </div>
  )
}
