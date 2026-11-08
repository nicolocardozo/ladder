import { CircleAlert, CircleX, Clock } from 'lucide-react'
import { plural, t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import type { ProjectAttention, SessionState } from '@/lib/session-state'

/** Anello che gira: sessione in corso. Con movimento ridotto diventa tratteggiato e fermo. */
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

/** Punto pieno: c'è una risposta da leggere. */
export function UnreadDot({ className }: { className?: string }) {
  return <span aria-label={t('Unread')} className={cn('block size-2 rounded-full bg-unread', className)} />
}

/** Simbolo di stato per una riga di sessione. Ogni stato ha una forma propria, non solo un colore. */
export function SessionGlyph({ state }: { state: SessionState }) {
  switch (state) {
    case 'running':
      return <RunningRing />
    case 'unread':
      return <UnreadDot />
    case 'waiting':
      return <CircleAlert aria-label={t('Needs you')} className="size-3 text-attention" strokeWidth={2.2} />
    case 'error':
      return <CircleX aria-label={t('Error')} className="size-3 text-destructive" strokeWidth={2.2} />
    case 'queued':
      return <Clock aria-label={t('Queued')} className="size-3 text-muted-foreground" strokeWidth={2.2} />
    default:
      return null
  }
}

/** Stato aggregato accanto al nome di un progetto chiuso. */
export function ProjectBadges({ attention }: { attention: ProjectAttention }) {
  return (
    <span data-attention className="ml-auto flex items-center gap-1.5">
      {attention.waiting > 0 && (
        <span
          aria-label={plural(attention.waiting, '{n} blocking request', '{n} blocking requests')}
          className="h-4 min-w-4 rounded-[4px] bg-attention px-1 text-center text-xs leading-4 font-semibold text-attention-foreground"
        >
          !{attention.waiting}
        </span>
      )}
      {attention.unread > 0 && (
        <span
          aria-label={plural(attention.unread, '{n} unread reply', '{n} unread replies')}
          className="h-4 min-w-4 rounded-full bg-unread px-1 text-center text-xs leading-4 font-semibold text-primary-foreground"
        >
          {attention.unread}
        </span>
      )}
      {attention.running && <RunningRing />}
    </span>
  )
}
