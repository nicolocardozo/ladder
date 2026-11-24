// Regole dei push (LAD-53): quali eventi, fascia silenziosa, testo generico. Funzioni pure: si provano con `node --test`.
// Import relativi e solo `import type` dal protocollo.
import type { PushKind, RemoteNotifyPrefs } from '../../shared/protocol.ts'
import { tIn, type Locale } from '../../shared/i18n.ts'

export const DEFAULT_NOTIFY_PREFS: RemoteNotifyPrefs = { events: { request: true, turn: true, error: true, agents: true }, quiet: null }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const KINDS: PushKind[] = ['request', 'turn', 'error', 'agents']
const MAX_TZ = 64

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Un fuso IANA che Intl conosce. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > MAX_TZ) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Controlla la forma di RemoteNotifyPrefs e la ricostruisce (campi in più scartati); null se non va. */
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

/** Preferenze salvate (JSON nel database): quelle non valide o assenti tornano ai predefiniti. */
export function parseNotifyPrefs(raw: unknown): RemoteNotifyPrefs {
  if (typeof raw !== 'string') return DEFAULT_NOTIFY_PREFS
  try {
    return cleanNotifyPrefs(JSON.parse(raw)) ?? DEFAULT_NOTIFY_PREFS
  } catch {
    return DEFAULT_NOTIFY_PREFS
  }
}

/** Minuti dalla mezzanotte nel fuso `tz` all'istante `at`; null se il fuso non si legge. */
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

/** Siamo nella fascia silenziosa? `from` incluso, `to` escluso; from > to attraversa la mezzanotte; from === to è vuota. Fuso illeggibile: no. */
export function inQuietHours(quiet: RemoteNotifyPrefs['quiet'], at: number): boolean {
  if (!quiet) return false
  const from = toMinutes(quiet.from)
  const to = toMinutes(quiet.to)
  if (from === to) return false
  const now = minutesIn(quiet.tz, at)
  if (now === null) return false
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** Il dispositivo vuole questo evento adesso? Evento spento → no; fascia silenziosa → no, salvo richieste con `quietAllowsRequests`. */
export function wantsPush(prefs: RemoteNotifyPrefs, kind: PushKind, at: number): boolean {
  if (!prefs.events[kind]) return false
  if (inQuietHours(prefs.quiet, at)) return kind === 'request' && prefs.quietAllowsRequests === true
  return true
}

/** Testo generico del push nella lingua del telefono: mai nomi di progetti o contenuti. */
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
