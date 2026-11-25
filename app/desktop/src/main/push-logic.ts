// When an event becomes a phone push: pure decisions, no Electron, so they can be tested with node --test.
// Main decides because only it knows whether you are using the Mac; the host then filters per device (preferences, quiet hours, app open).
import type { AttentionEvent, PushEvent, WindowView } from '../shared/protocol.ts'

/**
 * On a Mac active in the last 3 minutes (keyboard, mouse) no push: the Mac's notifications are enough.
 * With the screen locked it is sent anyway: you are there but cannot see anything, and the 3 minutes do not say you are looking
 * (the lock may kick in right after the last activity, and for the screen lock the idle time does not reset until you unlock).
 */
export const PUSH_IDLE_SECONDS = 180
/** Turns shorter than a minute do not notify (neither on the Mac nor on the phone). */
export const TURN_MIN_MS = 60_000

export interface PushContext {
  /** View of the foreground window; null if Ladder is not the active app. */
  view: WindowView | null
  /** Seconds since the user's last input on the Mac (powerMonitor.getSystemIdleTime). */
  idleSeconds: number
  /** Screen locked (powerMonitor lock-screen / unlock-screen). */
  locked: boolean
  /** Ladder's "Do Not Disturb" (AppPrefs.dndUntil): applies to phones too. */
  dndUntil: number | null
  now: number
}

/** Are you looking at it now on the Mac: active window and visible session (in any column). */
export function isWatching(view: WindowView | null, sessionId: string): boolean {
  if (!view) return false
  return view.visibleSessionIds?.includes(sessionId) ?? view.sessionId === sessionId
}

/** Does the event go to the phones? Returns the event without texts, or null. `resolved` never sends anything. */
export function pushFor(event: AttentionEvent, ctx: PushContext): PushEvent | null {
  if (event.kind === 'resolved') return null
  if (event.kind === 'turn' && event.durationMs < TURN_MIN_MS) return null
  if (ctx.dndUntil && ctx.dndUntil > ctx.now) return null
  // Screen locked: the window may stay "in the foreground" on the session, but you are not looking at it.
  if (ctx.locked) return { kind: event.kind, sessionId: event.sessionId, itemId: event.itemId }
  if (isWatching(ctx.view, event.sessionId)) return null
  if (ctx.idleSeconds < PUSH_IDLE_SECONDS) return null
  return { kind: event.kind, sessionId: event.sessionId, itemId: event.itemId }
}
