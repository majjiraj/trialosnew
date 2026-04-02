'use client'
import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { useRouter } from 'next/navigation'

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:8001'

interface User {
  id: string
  email: string
  name: string
  roles: string[]
  org_id: string
  org_name: string
  org_slug: string
  is_platform_admin: boolean
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (data: { email: string; password: string; name: string; org_name: string }) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue>(null!)

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function setCookie(name: string, value: string, maxAge: number) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; path=/; max-age=0`
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const token = getCookie('trialo_token')
    if (!token) { setLoading(false); return }
    fetch(`${AUTH_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        if (r.status === 401) { deleteCookie('trialo_token'); router.push('/login'); return null }
        return r.ok ? r.json() : null
      })
      .then(u => { setUser(u); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const login = async (email: string, password: string) => {
    const r = await fetch(`${AUTH_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!r.ok) {
      const data = await r.json().catch(() => ({}))
      throw new Error(data.detail || 'Login failed')
    }
    const { token, user } = await r.json()
    setCookie('trialo_token', token, 8 * 3600)
    setUser(user)
    router.push('/')
  }

  const signup = async (data: { email: string; password: string; name: string; org_name: string }) => {
    const r = await fetch(`${AUTH_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      throw new Error(d.detail || 'Signup failed')
    }
    const { token } = await r.json()
    setCookie('trialo_token', token, 8 * 3600)
    // Fetch full user profile
    const me = await fetch(`${AUTH_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    if (me.ok) setUser(await me.json())
    router.push('/')
  }

  const logout = () => {
    deleteCookie('trialo_token')
    setUser(null)
    router.push('/login')
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

/** Convenience hook — returns the current user's org_id (falls back to demo org) */
export function useOrgId(): string {
  const { user } = useAuth()
  return user?.org_id ?? '00000000-0000-0000-0000-000000000001'
}
