'use client'
import { Bell, Search, LogOut } from 'lucide-react'
import { useNotificationStore } from '@/store/notifications'
import { useAuth } from './AuthContext'

export function TopBar() {
  const unreadCount = useNotificationStore(s => s.unreadCount)
  const { user, logout } = useAuth()

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6 flex-shrink-0">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Search className="w-4 h-4" />
        <span>Search studies, agents...</span>
        <kbd className="text-xs bg-slate-100 px-1.5 py-0.5 rounded ml-2">⌘K</kbd>
      </div>
      <div className="flex items-center gap-3">
        <button className="relative p-2 rounded-lg hover:bg-slate-100 transition-colors">
          <Bell className="w-4 h-4 text-slate-600" />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={logout}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          title="Logout"
        >
          <div className="w-8 h-8 rounded-full bg-brand-500 text-white text-sm font-medium flex items-center justify-center">
            {user?.name?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <span className="text-sm text-slate-600 hidden sm:block max-w-[120px] truncate">{user?.name}</span>
          <LogOut className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>
    </header>
  )
}
