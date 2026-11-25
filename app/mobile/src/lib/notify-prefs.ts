// Phone notification preferences: saved shape, validation, conversion to the Mac (`device.notify.set`) and
// to/from the picker times. Pure logic only (no React Native), so it can be tested.
import type { PushKind, RemoteNotifyPrefs } from '../../../desktop/src/shared/protocol.ts'

export const PUSH_KINDS: readonly PushKind[] = ['request', 'turn', 'error', 'agents']

export interface NotifyPrefs {
  events: Record<PushKind, boolean>
  /** Quiet hours: `enabled` turns them on, `from`/`to` are remembered even when off. Phone "HH:MM" times. */
  quiet: { enabled: boolean; from: string; to: string }
  /** Requests and questions come through even during quiet hours. */
  quietAllowsRequests: boolean
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  events: { request: true, turn: true, error: true, agents: true },
  quiet: { enabled: false, from: '22:00', to: '07:00' },
  quietAllowsRequests: false
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value)

/** Valid IANA time zone for this JS engine (as the Mac validates it). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** The phone's time zone; if the engine does not know it, UTC (the Mac only accepts valid time zones). */
export function phoneTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isTimeZone(tz) ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Re-reads what was saved: each invalid field goes back to the default, the rest is kept. */
export function normalizeNotifyPrefs(raw: unknown): NotifyPrefs {
  const d = DEFAULT_NOTIFY_PREFS
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const events = (r.events && typeof r.events === 'object' ? r.events : {}) as Record<string, unknown>
  const quiet = (r.quiet && typeof r.quiet === 'object' ? r.quiet : {}) as Record<string, unknown>
  return {
    events: {
      request: typeof events.request === 'boolean' ? events.request : d.events.request,
      turn: typeof events.turn === 'boolean' ? events.turn : d.events.turn,
      error: typeof events.error === 'boolean' ? events.error : d.events.error,
      agents: typeof events.agents === 'boolean' ? events.agents : d.events.agents
    },
    quiet: {
      enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : d.quiet.enabled,
      from: isTime(quiet.from) ? quiet.from : d.quiet.from,
      to: isTime(quiet.to) ? quiet.to : d.quiet.to
    },
    quietAllowsRequests: typeof r.quietAllowsRequests === 'boolean' ? r.quietAllowsRequests : d.quietAllowsRequests
  }
}

/** What is sent to the Mac: quiet hours are present only if on, in the phone's time zone. */
export function toWirePrefs(prefs: NotifyPrefs, tz: string = phoneTimeZone()): RemoteNotifyPrefs {
  const p = normalizeNotifyPrefs(prefs)
  return {
    events: { ...p.events },
    quiet: p.quiet.enabled && isTimeZone(tz) ? { from: p.quiet.from, to: p.quiet.to, tz } : null,
    quietAllowsRequests: p.quietAllowsRequests
  }
}

// ── Picker times ──

export function timeToMinutes(time: string): number {
  const m = TIME.exec(time)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "HH:MM" → today's date at that local time (the picker's value). */
export function timeToDate(time: string, base: Date = new Date()): Date {
  const minutes = timeToMinutes(time)
  const d = new Date(base)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/** Picker date → local "HH:MM". */
export function dateToTime(date: Date): string {
  return minutesToTime(date.getHours() * 60 + date.getMinutes())
}

/** Time to show, in the phone's format (12 or 24 hours). */
export function displayTime(time: string): string {
  try {
    return timeToDate(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return time
  }
}

/** The range crosses midnight (22:00 to 07:00). */
export const crossesMidnight = (from: string, to: string): boolean => timeToMinutes(from) > timeToMinutes(to)
