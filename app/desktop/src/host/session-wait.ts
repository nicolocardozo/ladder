// Outcome of `session.wait`: a pure function of a session's state, with no path aliases (scripts/cli.test.mts tests it).
import type { ChatItem, SessionWaitResult } from '../shared/protocol'

export interface WaitInput {
  sessionId: string
  /** State of the session row (idle, running, waiting, error). */
  runState: string
  /** Wait label ("Approval", "Question") when the session is waiting for your reply. */
  waitingLabel: string | null
  /** Label of a plan to review or paused, if the session is stopped because of it. */
  planLabel: string | null
  /** The process is working, a turn is closing, or a setup is starting. */
  busy: boolean
  /** Background sub-agents still working, or a wait armed for their resumption: the current answer is not the final one. */
  background: boolean
  /** The chat offers "Continue" (sub-agents finished, the coordinator has not resumed): an action from you is needed. */
  continueLabel: string | null
  /** Messages still queued. */
  queued: number
  /** The chat lines, read only when needed (a session still working does not ask for them). */
  items: ChatItem[] | (() => ChatItem[])
  /** Seq of the last chat item. */
  seq: number
}

/** What session.wait answers right now; null if the session is still working (keep waiting). */
export function decideWait(input: WaitInput): SessionWaitResult | null {
  let cached: ChatItem[] | null = null
  const items = (): ChatItem[] => (cached ??= typeof input.items === 'function' ? input.items() : input.items)
  const result = (status: SessionWaitResult['status'], waitingLabel: string | null = null): SessionWaitResult => {
    const all = items()
    const end = [...all].reverse().find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
    const last = end ? [...all].reverse().find((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.turnId === end.turnId && i.text.trim() !== '') : null
    return {
      sessionId: input.sessionId,
      status,
      text: last?.text.trim() || null,
      error: end?.status === 'error' ? (end.error ?? 'The turn stopped because of an error.') : null,
      waitingLabel,
      seq: input.seq
    }
  }
  if (input.runState === 'waiting') return result('needs-user', input.waitingLabel)
  if (input.runState === 'idle' && input.planLabel) return result('needs-user', input.planLabel)
  // Still working: do not read the chat.
  if (input.busy || input.background || input.queued > 0) return null
  if (input.continueLabel) return result('needs-user', input.continueLabel)
  const end = [...items()].reverse().find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
  if (!end) return result(input.runState === 'error' ? 'error' : 'idle')
  return result(end.status)
}
