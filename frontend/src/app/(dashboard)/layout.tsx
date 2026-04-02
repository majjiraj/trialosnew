'use client'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  useNotificationSocket()
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6 bg-surface">{children}</main>
      </div>
    </div>
  )
}
