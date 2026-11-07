// Stato visivo di sessioni e progetti, derivato dai riepiloghi dell'host.
import type { SessionSummary } from '@shared/protocol'

export type SessionState = 'idle' | 'running' | 'unread' | 'waiting' | 'error' | 'queued'

export function sessionState(session: SessionSummary): SessionState {
  if (session.run === 'waiting') return 'waiting'
  if (session.run === 'error') return 'error'
  if (session.run === 'queued') return 'queued'
  if (session.run === 'running' || session.run === 'starting') return 'running'
  if (session.unread) return 'unread'
  return 'idle'
}

/** Dopo 3 giorni senza attività e senza niente da leggere una sessione scende in "Concluse". */
export const CONCLUDED_AFTER_MS = 3 * 24 * 60 * 60_000

/** Una sessione da leggere, ferma per errore, in attesa o con una bozza non viene mai raccolta. */
export function isConcluded(session: SessionSummary, hasDraft: boolean, now = Date.now()): boolean {
  return sessionState(session) === 'idle' && !hasDraft && now - Math.max(session.activityAt, session.createdAt) > CONCLUDED_AFTER_MS
}

export interface ProjectAttention {
  waiting: number
  unread: number
  running: boolean
  error: boolean
  /** Sessione da aprire con un clic sul simbolo: la richiesta più vecchia, poi l'errore, poi la risposta più recente. */
  target: SessionSummary | null
}

export function projectAttention(sessions: SessionSummary[]): ProjectAttention {
  const states = sessions.map(sessionState)
  const waiting = sessions.filter((s) => s.run === 'waiting').sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
  const errors = sessions.filter((s) => s.run === 'error')
  const unread = sessions.filter((s) => sessionState(s) === 'unread').sort((a, b) => b.activityAt - a.activityAt)
  return {
    waiting: waiting.reduce((n, s) => n + Math.max(1, s.openRequests), 0),
    unread: states.filter((s) => s === 'unread').length,
    running: states.includes('running'),
    error: states.includes('error'),
    target: waiting[0] ?? errors[0] ?? unread[0] ?? null
  }
}

/** Testo breve per la riga della sessione: richiesta, coda, errore, PR, bozza o età. */
export function sessionNote(session: SessionSummary, hasDraft: boolean, now = Date.now()): string {
  if (session.run === 'waiting') return session.waitingLabel ?? 'Richiede te'
  if (session.run === 'error') return 'Errore'
  if (session.run === 'queued') return 'In coda'
  const pr = prNote(session)
  if (pr && session.run === 'idle') return pr
  if (hasDraft && session.run === 'idle') return 'bozza'
  return relativeAge(session.updatedAt, now)
}

/** Stato della PR in poche lettere, solo quando chiede qualcosa o è finita: unita, CI fallita, conflitti. */
export function prNote(session: SessionSummary): string | null {
  const pr = session.pr
  if (!pr) return null
  if (pr.state === 'merged') return 'unita'
  if (pr.state === 'closed') return 'PR chiusa'
  if (pr.mergeable === 'conflicts') return 'conflitti'
  if (pr.checks === 'failing') return 'CI fallita'
  return null
}

export function relativeAge(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 1) return 'ora'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  return days === 1 ? 'ieri' : `${days} g`
}
