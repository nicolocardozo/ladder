// Advice pieces shared by the header and the sidebar.
import { Handshake, MessagesSquare } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { usePeerSession } from '@/components/handoff-bits'

/**
 * "Advice for <title>" in the header of an advice child session, "Delegated by <title>" for a delegation:
 * clickable if the parent still exists.
 */
export function AdviceParentNote({ session }: { session: Pick<SessionSummary, 'parent'> }) {
  const parent = session.parent
  const { session: mother, open } = usePeerSession(parent?.sessionId)
  if (!parent) return null
  const delegate = parent.role === 'delegate'
  const title = mother?.title ?? t('another session')
  const label = delegate ? t('Delegated by {title}', { title }) : t('Advice for {title}', { title })
  const Icon = delegate ? Handshake : MessagesSquare
  const icon = <Icon aria-hidden className="size-3 shrink-0" strokeWidth={1.9} />
  if (!open) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      title={delegate ? t('Open the session that delegated this work') : t('Open the session this advice is for')}
      className="flex min-w-0 items-center gap-1 rounded-[4px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {icon}
      <span className="min-w-0 truncate underline decoration-border underline-offset-2">{label}</span>
    </button>
  )
}
