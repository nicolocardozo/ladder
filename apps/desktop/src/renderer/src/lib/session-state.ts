// Stato visivo di sessioni e progetti, derivato dai riepiloghi dell'host.
import type { SessionSummary } from '@shared/protocol'

export type SessionState = 'idle' | 'running' | 'unread' | 'waiting' | 'error'

export function sessionState(session: SessionSummary): SessionState {
  if (session.run === 'waiting') return 'waiting'
  if (session.run === 'error') return 'error'
  if (session.run === 'running' || session.run === 'starting') return 'running'
  if (session.unread) return 'unread'
  return 'idle'
}

export interface ProjectAttention {
  waiting: number
  unread: number
  running: boolean
  error: boolean
}

export function projectAttention(sessions: SessionSummary[]): ProjectAttention {
  const states = sessions.map(sessionState)
  return {
    waiting: states.filter((s) => s === 'waiting').length,
    unread: states.filter((s) => s === 'unread').length,
    running: states.includes('running'),
    error: states.includes('error')
  }
}

/** Testo breve per la riga della sessione: etichetta della richiesta, attività o età. */
export function sessionNote(session: SessionSummary, hasDraft: boolean, now = Date.now()): string {
  if (session.run === 'waiting') return session.waitingLabel ?? 'Richiede te'
  if (session.run === 'error') return 'Errore'
  if (hasDraft && session.run === 'idle') return 'bozza'
  return relativeAge(session.updatedAt, now)
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
