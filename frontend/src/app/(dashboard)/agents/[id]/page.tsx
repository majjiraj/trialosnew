'use client'
import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

// The full agent detail + flow view lives at /agents/flow-view/[slug].
// This page exists only because vibe-save navigates to /agents/[slug] after saving.
export default function AgentDetailRedirect() {
  const { id } = useParams<{ id: string }>()
  const router  = useRouter()

  useEffect(() => {
    if (id) router.replace(`/agents/flow-view/${id}`)
  }, [id, router])

  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
    </div>
  )
}
