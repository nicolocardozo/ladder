// Visual state of a session on the phone. Reduced rewrite of app/desktop/src/renderer/src/lib/session-state.ts:
// the desktop also distinguishes sub-agent notices, here they become "running" or "unread". If one changes, check the other.
import type { SessionSummary } from '@shared/protocol'

/** Urgency order: from most to least urgent. */
export type SessionState = 'waiting' | 'error' | 'running' | 'unread' | 'queued' | 'idle'

export const URGENCY: Record<SessionState, number> = { waiting: 0, error: 1, running: 2, unread: 3, queued: 4, idle: 5 }

export function sessionState(s: SessionSummary): SessionState {
  if (s.run === 'waiting') return 'waiting'
  if (s.run === 'error') return 'error'
  if (s.run === 'running' || s.run === 'starting') return 'running'
  if ((s.subagentCounts?.running ?? 0) > 0) return 'running'
  const notice = s.agentsNotice
  if (s.unread || (notice && notice.finished + notice.failed > 0)) return 'unread'
  if ((s.queue?.length ?? 0) > 0) return 'queued'
  return 'idle'
}

export const isLive = (state: SessionState) => state !== 'idle'

/** Sorts by urgency; at equal urgency the ones waiting longest first, the others most recent first. */
export function byUrgency(a: SessionSummary, b: SessionSummary): number {
  const sa = sessionState(a)
  const sb = sessionState(b)
  if (sa !== sb) return URGENCY[sa] - URGENCY[sb]
  if (sa === 'waiting') return (a.waitingSince ?? 0) - (b.waitingSince ?? 0)
  return b.activityAt - a.activityAt
}

export interface Signals {
  running: number
  waiting: number
  unread: number
  error: number
}

export function signalsOf(sessions: SessionSummary[]): Signals {
  const out: Signals = { running: 0, waiting: 0, unread: 0, error: 0 }
  for (const s of sessions) {
    const state = sessionState(s)
    if (state === 'running') out.running++
    else if (state === 'waiting') out.waiting += Math.max(1, s.openRequests)
    else if (state === 'unread') out.unread++
    else if (state === 'error') out.error++
  }
  return out
}

export const hasSignals = (s: Signals) => s.running + s.waiting + s.unread + s.error > 0
