import { Bot, CircleAlert, CircleX, TriangleAlert } from 'lucide-react'
import { plural, t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import type { ProjectAttention, SessionState } from '@/lib/session-state'

/** Spinning ring: session in progress. With reduced motion it becomes dashed and still. */
export function RunningRing({ className }: { className?: string }) {
  return (
    <span
      aria-label={t('Running')}
      className={cn(
        'block size-[11px] rounded-full border-[1.6px] border-border border-t-running animate-spin',
        'motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-running',
        className
      )}
    />
  )
}

/** Filled dot: there is a reply to read. */
export function UnreadDot({ className, 'aria-label': label }: { className?: string; 'aria-label'?: string }) {
  return <span aria-label={label ?? t('Unread')} className={cn('block size-2 rounded-full bg-unread', className)} />
}

/** Status symbol for a session row. Each state has its own shape, not just a color. */
export function SessionGlyph({ state }: { state: SessionState }) {
  switch (state) {
    case 'running':
      return <RunningRing />
    case 'unread':
      return <UnreadDot />
    case 'agents':
      return <UnreadDot aria-label={t('Subagents finished')} />
    case 'agents-failed':
      return <TriangleAlert aria-label={t('Subagents failed')} className="size-3 text-destructive" strokeWidth={2.2} />
    case 'agents-running':
      return <Bot aria-label={t('Waiting for agents')} className="size-3 text-running" strokeWidth={2.2} />
    case 'waiting':
      return <CircleAlert aria-label={t('Needs you')} className="size-3 text-attention" strokeWidth={2.2} />
    case 'error':
      return <CircleX aria-label={t('Error')} className="size-3 text-destructive" strokeWidth={2.2} />
    default:
      return null
  }
}

/** How many requests are waiting for you: light amber pill with icon and number. */
export function WaitingCount({ count, label }: { count: number; label: string }) {
  return (
    <span aria-label={label} className="inline-flex h-[18px] items-center gap-1 rounded-full bg-attention/15 px-1.5 text-xs font-semibold text-attention tabular-nums">
      <CircleAlert aria-hidden className="size-3" strokeWidth={2.4} />
      {count}
    </span>
  )
}

/** How many replies are to be read: iris dot and number, no background. */
export function UnreadCount({ count, label }: { count: number; label: string }) {
  return (
    <span aria-label={label} className="inline-flex h-[18px] items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums">
      <span aria-hidden className="block size-2 rounded-full bg-unread" />
      {count}
    </span>
  )
}

/** Aggregated status next to the name of a closed project. */
export function ProjectBadges({ attention }: { attention: ProjectAttention }) {
  return (
    <span data-attention className="ml-auto flex items-center gap-1.5">
      {attention.waiting > 0 && <WaitingCount count={attention.waiting} label={plural(attention.waiting, '{n} blocking request', '{n} blocking requests')} />}
      {attention.unread > 0 && <UnreadCount count={attention.unread} label={plural(attention.unread, '{n} unread reply', '{n} unread replies')} />}
      {attention.running && <RunningRing />}
    </span>
  )
}
