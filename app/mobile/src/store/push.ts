// In-memory state of push notifications on this phone (not persisted): system permission, Expo token and the request
// to open after a tap on a notification. Preferences (which events, quiet hours) live in prefs.ts.
import { create } from 'zustand'

export type PushPermission = 'unknown' | 'undetermined' | 'granted' | 'denied'

interface PushState {
  permission: PushPermission
  /** The system can still show the permission prompt (otherwise go through settings). */
  canAsk: boolean
  /** This phone's Expo token (never shown or logged). */
  token: string | null
  /** Permission granted but the token could not be obtained: build without push credentials (APNs / FCM). */
  tokenFailed: boolean
  /** Request to open once the session has been re-read from the Mac after a tap on a notification; `at` = time of the tap (expires). */
  openRequest: { sessionId: string; requestId: string; at: number } | null
  set: (patch: Partial<Omit<PushState, 'set'>>) => void
}

export const usePush = create<PushState>((set) => ({
  permission: 'unknown',
  canAsk: true,
  token: null,
  tokenFailed: false,
  openRequest: null,
  set: (patch) => set(patch)
}))
