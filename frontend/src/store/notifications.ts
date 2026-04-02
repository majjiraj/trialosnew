import { create } from 'zustand'

interface Notification {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  study_id?: string
  notification_type: string
  created_at: string
}

interface NotificationStore {
  notifications: Notification[]
  unreadCount: number
  addNotification: (n: Notification) => void
  markRead: (id: string) => void
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  unreadCount: 0,
  addNotification: (n) => set(state => ({
    notifications: [n, ...state.notifications].slice(0, 100),
    unreadCount: state.unreadCount + 1,
  })),
  markRead: (id) => set(state => ({
    notifications: state.notifications.filter(n => n.id !== id),
    unreadCount: Math.max(0, state.unreadCount - 1),
  })),
}))
