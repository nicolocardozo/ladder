// Links between sessions of a project in the session header: the session another one is waiting for (ladder_wait) and the
// active sessions that changed the same files. Each note opens the other session.
import { Files, Hourglass } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
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

export function hasPeerNotes(session: Pick<SessionSummary, 'waitingOn' | 'overlaps' | 'run'>): boolean {
  return Boolean(waitingOf(session) || session.overlaps?.length)
}

/** "Waiting for …" and "Same files as …", separated like the other header notes. */
export function PeerNotes({ session, lead }: { session: Pick<SessionSummary, 'waitingOn' | 'overlaps' | 'run'>; lead: boolean }) {
  const notes: ReactNode[] = []
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
