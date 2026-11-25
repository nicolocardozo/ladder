// Agent handoff pieces shared by chat, header and sidebar.
import { ArrowRightLeft } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { useAgentLine } from '@/components/agent-mark'
import { isLiveSession, useApp } from '@/store/app-store'

/** Session on the other side, if it still exists and is not archived, and the action to open it. */
export function usePeerSession(sessionId: string | null | undefined): { session: SessionSummary | null; open: (() => void) | null } {
  const session = useApp((s) => (sessionId ? (s.sessions[sessionId] ?? null) : null))
  const live = useApp((s) => (sessionId ? isLiveSession(s, s.sessions[sessionId]) : false))
  const select = useApp((s) => s.select)
  return {
    session,
    open: live && session ? () => select({ kind: 'session', projectId: session.projectId, sessionId: session.id }) : null
  }
}

/** "from <title>" in the header of a session created by a handoff: clickable if the source session still exists. */
export function HandoffFromNote({ session }: { session: Pick<SessionSummary, 'handoffFrom'> }) {
  const from = session.handoffFrom
  const { session: peer, open } = usePeerSession(from?.sessionId)
  const { name } = useAgentLine(from?.agent ?? 'claude-code', null)
  if (!from) return null
  const label = t('from {title}', { title: peer?.title ?? name })
  const icon = <ArrowRightLeft aria-hidden className="size-3 shrink-0" strokeWidth={1.9} />
  if (!open) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={t('Handed off from {agent}', { agent: name })}>
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      title={t('Handed off from {agent}. Open that session.', { agent: name })}
      className="flex min-w-0 items-center gap-1 rounded-[4px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {icon}
      <span className="min-w-0 truncate underline decoration-border underline-offset-2">{label}</span>
    </button>
  )
}
