// Tap on a Ladder notification: opens the session (and the request, if there is one and it is still open). Works with the app closed
// (the last response is read at launch), in the background and in the foreground (listener). The layout mounts it only once boot is done: by then
// the pairing is loaded and `pushMacKey()` says which Mac is ours. Notifications from another Mac or without the right `data` are ignored.
import * as Notifications from 'expo-notifications'
import { usePathname, useRootNavigationState, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { openSession } from '@/lib/nav'
import { tapTarget } from '@/lib/push-data'
import { follow } from '@/host/controller'
import { pushMacKey } from '@/host/push'
import { useApp } from '@/store/app'
import { usePush } from '@/store/push'

/** Development only: opens a session like a tap on a notification (scripts/dev-driver). */
let devTap: ((target: { sessionId: string; requestId?: string | null }) => void) | null = null
export const devNotificationTap = (target: { sessionId: string; requestId?: string | null }): void => devTap?.(target)

export function useNotificationTaps(): void {
  const router = useRouter()
  const pathname = usePathname()
  const navReady = !!useRootNavigationState()?.key
  // Responses already handled: the same one can arrive from the listener and from the "last response" read at launch.
  const seen = useRef(new Set<string>())
  // The "real" path: an open native sheet (/sheet/…) does not count, underneath is the screen being seen and the one to decide on.
  const pathRef = useRef(pathname)
  if (!pathname.startsWith('/sheet/')) pathRef.current = pathname
  const sheetOpen = useRef(false)
  sheetOpen.current = pathname.startsWith('/sheet/')

  useEffect(() => {
    if (!navReady) return
    const open = (target: { sessionId: string; requestId?: string | null }) => {
      if (target.requestId) {
        // The chat in memory may be stale: it is marked "to re-read" and re-read, and the request opens only afterwards (session/[id].tsx).
        useApp.setState((s) => ({ loaded: { ...s.loaded, [target.sessionId]: false } }))
        usePush.getState().set({ openRequest: { sessionId: target.sessionId, requestId: target.requestId, at: Date.now() } })
        void follow(target.sessionId).catch(() => {})
      }
      const href = `/session/${target.sessionId}`
      // Already on that session: only the request. On another session it replaces (taps do not stack chats); elsewhere it is added.
      if (pathRef.current === href) return
      // An open native sheet (route /sheet/…) closes by itself, and only it: underneath is the chat or tab being seen, which must not be touched
      // (a dismissAll would also take the chat and, replacing, the tabs themselves).
      if (sheetOpen.current) router.dismiss()
      openSession(router, target.sessionId, pathRef.current.startsWith('/session/'))
    }
    const run = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
      const key = `${response.notification.request.identifier}|${response.notification.date}`
      if (seen.current.has(key)) return
      seen.current.add(key)
      const target = tapTarget(response.notification.request.content.data, pushMacKey())
      if (!target) return
      // Revoked link or changed key: the app is already showing the screen that explains it.
      const conn = useApp.getState().conn.kind
      if (conn === 'revoked' || conn === 'key-changed') return
      open(target)
    }
    // App closed: the tap that opened it. Then taps are listened to with the app in the background or foreground.
    const last = Notifications.getLastNotificationResponse()
    if (last) run(last)
    const sub = Notifications.addNotificationResponseReceivedListener(run)
    // Development only: the driver simulates the tap (same opening) without going through the Notification Center.
    if (__DEV__) devTap = open
    return () => {
      sub.remove()
      devTap = null
    }
  }, [navReady, router])
}
