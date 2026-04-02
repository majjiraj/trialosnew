import { ReactNode } from 'react'
import { FlaskConical } from 'lucide-react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="mb-8 flex items-center gap-2">
        <div className="w-9 h-9 bg-brand-500 rounded-xl flex items-center justify-center">
          <FlaskConical className="w-5 h-5 text-white" />
        </div>
        <span className="text-xl font-bold text-slate-900">TrialOS</span>
      </div>
      <div className="w-full max-w-sm">
        {children}
      </div>
    </div>
  )
}
