// Visual state of sessions and projects, derived from the host's summaries.
import type { SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'

export type SessionState = 'idle' | 'running' | 'unread' | 'agents' | 'agents-failed' | 'agents-running' | 'waiting' | 'error'

/** Background sub-agents finished while the session is idle: the coordinator is about to reply (or already has). */
export function agentsNotice(session: SessionSummary): { finished: number; failed: number } | null {
  const notice = session.agentsNotice
  return notice && notice.finished + notice.failed > 0 ? notice : null
}

/** Sub-agents still at work with the coordinator idle: the session is waiting for them, not for you. */
export function agentsRunning(session: SessionSummary): number {
  return session.run === 'idle' ? (session.subagentCounts?.running ?? 0) : 0
}

/** States that say "there is something to read": an unread reply or a sub-agents notice. */
export const isUnreadState = (state: SessionState) => state === 'unread' || state === 'agents' || state === 'agents-failed'

/** The session is waiting for you: an agent request (run 'waiting') or a plan in review or paused (`planWaiting`, with `run` left as it really is). */
export const needsYou = (session: Pick<SessionSummary, 'run' | 'planWaiting'>): boolean => session.run === 'waiting' || session.planWaiting === true

export function sessionState(session: SessionSummary): SessionState {
  if (needsYou(session)) return 'waiting'
  if (session.run === 'error') return 'error'
  if (session.run === 'running' || session.run === 'starting') return 'running'
  // While sub-agents are working the session waits for them: that counts more than the notice about those already finished.
  if (agentsRunning(session) > 0) return 'agents-running'
  const notice = agentsNotice(session)
  if (notice) return notice.failed > 0 ? 'agents-failed' : 'agents'
  if (session.unread) return 'unread'
  return 'idle'
}

/** Last time something happened in the session: sorts "All sessions" and picks the recent ones. */
export function lastTouched(session: SessionSummary): number {
  return Math.max(session.activityAt, session.createdAt)
}

/** Idle sessions shown in the sidebar, besides the live ones. */
export const RECENT_SESSIONS = 5

/**
 * Sidebar rows: those waiting for you, at work, to read or with a draft, plus the latest idle ones.
 * The others are in "All sessions": so the list stays short even with 50 sessions. The order stays that of `all`.
 */
export function sidebarSessions(all: SessionSummary[], keep: (session: SessionSummary) => boolean): SessionSummary[] {
  const pinned = all.filter((s) => keep(s) || sessionState(s) !== 'idle')
  const recent = all
    .filter((s) => !pinned.includes(s))
    .sort((a, b) => lastTouched(b) - lastTouched(a))
    .slice(0, RECENT_SESSIONS)
  return all.filter((s) => pinned.includes(s) || recent.includes(s))
}

/** After 3 days without activity and with nothing to read a session drops to "Done". */
export const CONCLUDED_AFTER_MS = 3 * 24 * 60 * 60_000

/** A session to read, idle because of an error, waiting or with a draft is never collected. */
export function isConcluded(session: SessionSummary, hasDraft: boolean, now = Date.now()): boolean {
  return sessionState(session) === 'idle' && !hasDraft && now - Math.max(session.activityAt, session.createdAt) > CONCLUDED_AFTER_MS
}

export interface ProjectAttention {
  waiting: number
  unread: number
  running: boolean
  error: boolean
  /** Session to open with a click on the symbol: the oldest request, then the error, then the most recent reply. */
  target: SessionSummary | null
}

export function projectAttention(sessions: SessionSummary[]): ProjectAttention {
  const states = sessions.map(sessionState)
  const waiting = sessions.filter(needsYou).sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
  const errors = sessions.filter((s) => s.run === 'error')
  const unread = sessions.filter((s) => isUnreadState(sessionState(s))).sort((a, b) => b.activityAt - a.activityAt)
  return {
    waiting: waiting.reduce((n, s) => n + Math.max(1, s.openRequests), 0),
    unread: states.filter(isUnreadState).length,
    running: states.includes('running'),
    error: states.includes('error'),
    target: waiting[0] ?? errors[0] ?? unread[0] ?? null
  }
}

/** What the row's note says: the code is for the tone, the text is shown. */
export type PrNoteCode = 'merged' | 'pr-closed' | 'conflicts' | 'ci-failed'
export type SessionNoteCode = 'waiting' | 'error' | 'agents' | 'agents-failed' | 'agents-running' | 'draft' | 'age' | PrNoteCode

export interface Note<Code extends string> {
  code: Code
  text: string
}

/** Short text for the session row: request, queue, error, PR, draft or age. */
export function sessionNote(session: SessionSummary, hasDraft: boolean, now = Date.now()): Note<SessionNoteCode> {
  if (needsYou(session)) return { code: 'waiting', text: session.waitingLabel ?? t('Needs you') }
  if (session.run === 'error') return { code: 'error', text: t('Error') }
  const waiting = agentsRunning(session)
  if (waiting > 0) return { code: 'agents-running', text: plural(waiting, 'Waiting for 1 agent', 'Waiting for {n} agents') }
  const notice = agentsNotice(session)
  if (notice && session.run === 'idle') {
    return notice.failed > 0
      ? { code: 'agents-failed', text: plural(notice.failed, '1 subagent failed', '{n} subagents failed') }
      : { code: 'agents', text: t('Subagents finished') }
  }
  const pr = prNote(session)
  if (pr && session.run === 'idle') return pr
  if (hasDraft && session.run === 'idle') return { code: 'draft', text: t('draft') }
  return { code: 'age', text: relativeAge(session.updatedAt, now) }
}

/** PR state in a few letters, only when it asks for something or is finished: merged, failed CI, conflicts. */
export function prNote(session: SessionSummary): Note<PrNoteCode> | null {
  const pr = session.pr
  if (!pr) return null
  if (pr.state === 'merged') return { code: 'merged', text: t('merged') }
  if (pr.state === 'closed') return { code: 'pr-closed', text: t('PR closed') }
  if (pr.mergeable === 'conflicts') return { code: 'conflicts', text: t('conflicts') }
  if (pr.checks === 'failing') return { code: 'ci-failed', text: t('CI failed') }
  return null
}

/** Tone of the note in the row: amber for what asks for you, red for what went wrong, green for the merged PR. */
export function noteTone(code: SessionNoteCode): 'attention' | 'destructive' | 'success' | null {
  switch (code) {
    case 'waiting':
    case 'conflicts':
      return 'attention'
    case 'error':
    case 'agents-failed':
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
