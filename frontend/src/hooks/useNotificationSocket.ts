'use client'
import { useEffect } from 'react'
import { useNotificationStore } from '@/store/notifications'
import { toast } from 'sonner'

export function useNotificationSocket(userId = 'current-user') {
  const addNotification = useNotificationStore(s => s.addNotification)

  useEffect(() => {
    const wsBase = (process.env.NEXT_PUBLIC_NOTIFICATION_WS_URL || 'ws://localhost:8006')
    const connect = () => {
      try {
        const ws = new WebSocket(`${wsBase}/ws/${userId}`)
        ws.onmessage = (e) => {
          const n = JSON.parse(e.data)
          addNotification(n)
          if (n.severity === 'critical') toast.error(n.title, { description: n.body })
          else if (n.severity === 'warning') toast.warning(n.title, { description: n.body })
          else toast.info(n.title, { description: n.body })
        }
        ws.onclose = () => setTimeout(connect, 5000)
      } catch { setTimeout(connect, 5000) }
    }
    connect()
  }, [userId, addNotification])
}
