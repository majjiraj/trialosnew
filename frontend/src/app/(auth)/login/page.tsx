'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/components/layout/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await login(email, password)
    } catch (err: any) {
      toast.error(err.message || 'Login failed')
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
        Welcome back
      </h1>
      <p style={{ fontSize: '14px', color: '#6478A0', marginBottom: '32px', lineHeight: 1.6 }}>
        Sign in with your MaxisAI credentials to continue
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 500,
              color: '#2E4066',
              marginBottom: '6px',
            }}
          >
            Email address
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="you@maxisai.com"
            style={{
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
            }}
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

        <div>
          <label
            style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 500,
              color: '#2E4066',
              marginBottom: '6px',
            }}
          >
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            placeholder="••••••••"
            style={{
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
            }}
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

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#2E4066', cursor: 'pointer' }}>
            <input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9' }} />
            Remember me
          </label>
          <a href="#" style={{ fontSize: '13px', color: '#0284C7', fontWeight: 500, textDecoration: 'none' }}>
            Forgot password?
          </a>
        </div>

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
            padding: '0 24px',
            background: loading ? '#6B7A9A' : 'linear-gradient(135deg, #1A3680, #1D4ED8)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            letterSpacing: '-0.01em',
            boxShadow: loading ? 'none' : '0 1px 3px rgba(29,78,216,0.4)',
            transition: 'box-shadow 120ms, transform 120ms',
            fontFamily: 'inherit',
          }}
        >
          {loading && <Loader2 style={{ width: '16px', height: '16px', animation: 'spin 1s linear infinite' }} />}
          Sign in
        </button>
      </form>

      {/* Dev credentials hint */}
      <div style={{ margin: '20px 0 0', padding: '10px 14px', background: '#F0F7FF', borderRadius: '8px', border: '1px solid #BFDBFE' }}>
        <p style={{ fontSize: '11px', fontWeight: 600, color: '#1E40AF', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Dev credentials</p>
        {[
          { label: 'Platform Admin', email: 'admin@trialo.io', password: 'Admin@trialo1' },
          { label: 'Tenant Admin', email: 'admin@acme.example', password: 'Demo@tenant1' },
        ].map(({ label, email, password: pw }) => (
          <button
            key={email}
            type="button"
            onClick={() => { setEmail(email); setPassword(pw) }}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '4px 0',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '12px', color: '#1D4ED8', fontFamily: 'inherit',
            }}
          >
            <span style={{ fontWeight: 600 }}>{label}:</span> {email}
          </button>
        ))}
        <p style={{ fontSize: '11px', color: '#6478A0', marginTop: '4px' }}>Click a row to fill credentials, then Sign in</p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '16px 0', fontSize: '12px', color: '#6478A0' }}>
        <div style={{ flex: 1, height: '1px', background: '#DDE4F0' }} />
        or
        <div style={{ flex: 1, height: '1px', background: '#DDE4F0' }} />
      </div>

      <p style={{ textAlign: 'center', fontSize: '13px', color: '#6478A0' }}>
        New organization?{' '}
        <Link href="/signup" style={{ color: '#0284C7', fontWeight: 600, textDecoration: 'none' }}>
          Create account
        </Link>
      </p>

      <p style={{ textAlign: 'center', fontSize: '12px', color: '#6478A0', marginTop: '32px' }}>
        © 2026 MaxisAI ·{' '}
        <a href="#" style={{ color: '#0284C7', textDecoration: 'none' }}>Privacy</a>
        {' · '}
        <a href="#" style={{ color: '#0284C7', textDecoration: 'none' }}>Terms</a>
      </p>
    </div>
  )
}
