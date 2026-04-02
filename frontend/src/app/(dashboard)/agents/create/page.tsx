'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function CreateAgentRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/agents/build') }, [router])
  return null
}
