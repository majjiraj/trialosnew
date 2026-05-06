import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const token = request.cookies.get('trialo_token')?.value
  const path = request.nextUrl.pathname

  // Public paths — redirect to dashboard if already logged in
  if (path.startsWith('/login') || path.startsWith('/signup')) {
    if (token) return NextResponse.redirect(new URL('/', request.url))
    return NextResponse.next()
  }

  // Protected: all other routes require a token
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Admin routes: decode token claims (no signature verify in edge runtime)
  if (path.startsWith('/admin')) {
    try {
      const claims = JSON.parse(atob(token.split('.')[1]))
      if (!claims.is_platform_admin) {
        return NextResponse.redirect(new URL('/', request.url))
      }
    } catch {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.svg|.*\\.ico|.*\\.webp).*)'],
}
