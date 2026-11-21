// Stato visivo di sessioni e progetti, derivato dai riepiloghi dell'host.
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'

export type SessionState = 'idle' | 'running' | 'unread' | 'waiting' | 'error' | 'queued'

export function sessionState(session: SessionSummary): SessionState {
  if (session.run === 'waiting') return 'waiting'
  if (session.run === 'error') return 'error'
  if (session.run === 'queued') return 'queued'
  if (session.run === 'running' || session.run === 'starting') return 'running'
  if (session.unread) return 'unread'
  return 'idle'
}

/** Ultima volta che è successo qualcosa nella sessione: ordina "All sessions" e sceglie le recenti. */
export function lastTouched(session: SessionSummary): number {
  return Math.max(session.activityAt, session.createdAt)
}

/** Sessioni ferme mostrate nella sidebar, oltre a quelle vive. */
export const RECENT_SESSIONS = 5

/**
 * Righe della sidebar: quelle che ti aspettano, al lavoro, da leggere o con una bozza, più le ultime ferme.
 * Le altre stanno in "All sessions": così la lista resta corta anche con 50 sessioni. L'ordine resta quello di `all`.
 */
export function sidebarSessions(all: SessionSummary[], keep: (session: SessionSummary) => boolean): SessionSummary[] {
  const pinned = all.filter((s) => keep(s) || sessionState(s) !== 'idle')
  const recent = all
    .filter((s) => !pinned.includes(s))
    .sort((a, b) => lastTouched(b) - lastTouched(a))
    .slice(0, RECENT_SESSIONS)
  return all.filter((s) => pinned.includes(s) || recent.includes(s))
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

/** Che cosa dice la nota della riga: il codice serve per il tono, il testo si mostra. */
export type PrNoteCode = 'merged' | 'pr-closed' | 'conflicts' | 'ci-failed'
export type SessionNoteCode = 'waiting' | 'error' | 'queued' | 'draft' | 'age' | PrNoteCode

export interface Note<Code extends string> {
  code: Code
  text: string
}

/** Testo breve per la riga della sessione: richiesta, coda, errore, PR, bozza o età. */
export function sessionNote(session: SessionSummary, hasDraft: boolean, now = Date.now()): Note<SessionNoteCode> {
  if (session.run === 'waiting') return { code: 'waiting', text: session.waitingLabel ?? t('Needs you') }
  if (session.run === 'error') return { code: 'error', text: t('Error') }
  if (session.run === 'queued') return { code: 'queued', text: t('Queued') }
  const pr = prNote(session)
  if (pr && session.run === 'idle') return pr
  if (hasDraft && session.run === 'idle') return { code: 'draft', text: t('draft') }
  return { code: 'age', text: relativeAge(session.updatedAt, now) }
}

/** Stato della PR in poche lettere, solo quando chiede qualcosa o è finita: unita, CI fallita, conflitti. */
export function prNote(session: SessionSummary): Note<PrNoteCode> | null {
  const pr = session.pr
  if (!pr) return null
  if (pr.state === 'merged') return { code: 'merged', text: t('merged') }
  if (pr.state === 'closed') return { code: 'pr-closed', text: t('PR closed') }
  if (pr.mergeable === 'conflicts') return { code: 'conflicts', text: t('conflicts') }
  if (pr.checks === 'failing') return { code: 'ci-failed', text: t('CI failed') }
  return null
}

/** Tono della nota nella riga: ambra per ciò che chiede te, rosso per ciò che è andato storto, verde per la PR unita. */
export function noteTone(code: SessionNoteCode): 'attention' | 'destructive' | 'success' | null {
  switch (code) {
    case 'waiting':
    case 'conflicts':
      return 'attention'
    case 'error':
    case 'ci-failed':
    case 'pr-closed':
      return 'destructive'
    case 'merged':
      return 'success'
    default:
      return null
  }
}

export function relativeAge(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 1) return t('now')
  if (minutes < 60) return t('{n} min', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('{n} h', { n: hours })
  const days = Math.round(hours / 24)
  return days === 1 ? t('yesterday') : t('{n} d', { n: days })
}
