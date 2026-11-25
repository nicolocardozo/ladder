// Push rules: which events, quiet hours, generic text. Pure functions: tested with `node --test`.
// Relative imports and only `import type` from the protocol.
import type { PushKind, RemoteNotifyPrefs } from '../../shared/protocol.ts'
import { tIn, type Locale } from '../../shared/i18n.ts'

export const DEFAULT_NOTIFY_PREFS: RemoteNotifyPrefs = { events: { request: true, turn: true, error: true, agents: true }, quiet: null }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const KINDS: PushKind[] = ['request', 'turn', 'error', 'agents']
const MAX_TZ = 64

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An IANA time zone that Intl knows. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > MAX_TZ) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Checks the shape of RemoteNotifyPrefs and rebuilds it (extra fields dropped); null if invalid. */
export function cleanNotifyPrefs(value: unknown): RemoteNotifyPrefs | null {
  if (!isObject(value) || !isObject(value.events)) return null
  const events = {} as Record<PushKind, boolean>
  for (const kind of KINDS) {
    if (typeof value.events[kind] !== 'boolean') return null
    events[kind] = value.events[kind] as boolean
  }
  let quiet: RemoteNotifyPrefs['quiet'] = null
  if (value.quiet !== null && value.quiet !== undefined) {
    const q = value.quiet
    if (!isObject(q) || typeof q.from !== 'string' || typeof q.to !== 'string' || !HHMM.test(q.from) || !HHMM.test(q.to) || !validTimeZone(q.tz)) return null
    quiet = { from: q.from, to: q.to, tz: q.tz }
  }
  if (value.quietAllowsRequests !== undefined && typeof value.quietAllowsRequests !== 'boolean') return null
  return { events, quiet, ...(value.quietAllowsRequests !== undefined ? { quietAllowsRequests: value.quietAllowsRequests as boolean } : {}) }
}

/** Saved preferences (JSON in the database): invalid or missing ones fall back to the defaults. */
export function parseNotifyPrefs(raw: unknown): RemoteNotifyPrefs {
  if (typeof raw !== 'string') return DEFAULT_NOTIFY_PREFS
  try {
    return cleanNotifyPrefs(JSON.parse(raw)) ?? DEFAULT_NOTIFY_PREFS
  } catch {
    return DEFAULT_NOTIFY_PREFS
  }
}

/** Minutes since midnight in time zone `tz` at instant `at`; null if the zone cannot be read. */
function minutesIn(tz: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
  } catch {
    return null
  }
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** Are we in quiet hours? `from` inclusive, `to` exclusive; from > to crosses midnight; from === to is empty. Unreadable zone: no. */
export function inQuietHours(quiet: RemoteNotifyPrefs['quiet'], at: number): boolean {
  if (!quiet) return false
  const from = toMinutes(quiet.from)
  const to = toMinutes(quiet.to)
  if (from === to) return false
  const now = minutesIn(quiet.tz, at)
  if (now === null) return false
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** Does the device want this event now? Event off → no; quiet hours → no, except requests with `quietAllowsRequests`. */
export function wantsPush(prefs: RemoteNotifyPrefs, kind: PushKind, at: number): boolean {
  if (!prefs.events[kind]) return false
  if (inQuietHours(prefs.quiet, at)) return kind === 'request' && prefs.quietAllowsRequests === true
  return true
}

/** Generic push text in the phone's language: never project names or content. */
export function pushBody(kind: PushKind, locale: Locale): string {
  switch (kind) {
    case 'request':
      return tIn(locale, 'A session is waiting for you')
    case 'turn':
      return tIn(locale, 'A session finished')
    case 'error':
      return tIn(locale, 'A session hit an error')
    case 'agents':
      return tIn(locale, 'Background agents finished')
  }
}
