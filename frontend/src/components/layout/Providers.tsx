'use client'
import { ApolloClient, InMemoryCache, ApolloProvider, HttpLink } from '@apollo/client'
import { ReactNode, useMemo } from 'react'
import { AuthProvider } from './AuthContext'

export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(() => new ApolloClient({
    link: new HttpLink({ uri: process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql' }),
    cache: new InMemoryCache(),
  }), [])
  return (
    <AuthProvider>
      <ApolloProvider client={client}>{children}</ApolloProvider>
    </AuthProvider>
  )
}
