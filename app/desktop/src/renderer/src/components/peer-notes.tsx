// Notes in the session header: commands the agent left in the background, the session another one is waiting for
// (ladder_wait) and the active sessions that changed the same files. The session notes open the other session.
import { Files, Hourglass, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { usePeerSession } from './handoff-bits'

function PeerLink({ sessionId, label, title, icon }: { sessionId: string; label: string; title: string; icon: ReactNode }) {
  const { open } = usePeerSession(sessionId)
  if (!open) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={title}>
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      title={title}
      className="flex min-w-0 items-center gap-1 rounded-[4px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {icon}
      <span className="min-w-0 truncate underline decoration-border underline-offset-2">{label}</span>
    </button>
  )
}

/** The wait counts only while the turn runs: a stopped turn may leave the call open for a moment. */
const waitingOf = (session: Pick<SessionSummary, 'waitingOn' | 'run'>) => (session.run === 'running' ? (session.waitingOn ?? null) : null)

/** Commands the agent left running after its turn: only worth a note while the session looks idle. */
const backgroundOf = (session: Pick<SessionSummary, 'backgroundCommands' | 'run'>) => (session.run === 'idle' ? (session.backgroundCommands ?? 0) : 0)

export function hasPeerNotes(session: Pick<SessionSummary, 'waitingOn' | 'overlaps' | 'run' | 'backgroundCommands'>): boolean {
  return Boolean(waitingOf(session) || session.overlaps?.length || backgroundOf(session))
}

/** "Waiting for …" and "Same files as …", separated like the other header notes. */
export function PeerNotes({ session, lead }: { session: Pick<SessionSummary, 'waitingOn' | 'overlaps' | 'run' | 'backgroundCommands'>; lead: boolean }) {
  const notes: ReactNode[] = []
  const commands = backgroundOf(session)
  if (commands) {
    notes.push(
      <span key="background" className="flex min-w-0 items-center gap-1" title={t('Started by the agent, still running after its turn.')}>
        <SquareTerminal aria-hidden className="size-3 shrink-0 text-running" strokeWidth={1.9} />
        <span className="min-w-0 truncate">{plural(commands, '1 command in the background', '{n} commands in the background')}</span>
      </span>
    )
  }
  const waiting = waitingOf(session)
  if (waiting) {
    const { sessionId, title } = waiting
    notes.push(
      <PeerLink
        key={`wait:${sessionId}`}
        sessionId={sessionId}
        label={t('Waiting for “{title}”', { title })}
        title={t('The agent is waiting for “{title}” to finish before going on. Open that session.', { title })}
        icon={<Hourglass aria-hidden className="size-3 shrink-0 text-running" strokeWidth={1.9} />}
      />
    )
  }
  for (const overlap of session.overlaps ?? []) {
    const files = overlap.files.slice(0, 8).join('\n')
    const more = overlap.files.length > 8 ? `\n${t('and {n} more', { n: overlap.files.length - 8 })}` : ''
    notes.push(
      <PeerLink
        key={`overlap:${overlap.sessionId}`}
        sessionId={overlap.sessionId}
        label={t('Same files as “{title}”', { title: overlap.title })}
        title={`${t('Both sessions changed:')}\n${files}${more}`}
        icon={<Files aria-hidden className="size-3 shrink-0 text-attention" strokeWidth={1.9} />}
      />
    )
  }
  return notes.map((note, i) => (
    <span key={i} className="flex min-w-0 items-center gap-1.5">
      {(lead || i > 0) && <span aria-hidden className="text-faint">·</span>}
      {note}
    </span>
  ))
}
