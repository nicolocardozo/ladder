import { Bot, CircleAlert, CircleX, TriangleAlert } from 'lucide-react'
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
export function UnreadDot({ className, 'aria-label': label }: { className?: string; 'aria-label'?: string }) {
  return <span aria-label={label ?? t('Unread')} className={cn('block size-2 rounded-full bg-unread', className)} />
}

/** Simbolo di stato per una riga di sessione. Ogni stato ha una forma propria, non solo un colore. */
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

/** Quante richieste ti aspettano: pillola ambra chiara con icona e numero. */
export function WaitingCount({ count, label }: { count: number; label: string }) {
  return (
    <span aria-label={label} className="inline-flex h-[18px] items-center gap-1 rounded-full bg-attention/15 px-1.5 text-xs font-semibold text-attention tabular-nums">
      <CircleAlert aria-hidden className="size-3" strokeWidth={2.4} />
      {count}
    </span>
  )
}

/** Quante risposte sono da leggere: punto iris e numero, senza fondo. */
export function UnreadCount({ count, label }: { count: number; label: string }) {
  return (
    <span aria-label={label} className="inline-flex h-[18px] items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums">
      <span aria-hidden className="block size-2 rounded-full bg-unread" />
      {count}
    </span>
  )
}

/** Stato aggregato accanto al nome di un progetto chiuso. */
export function ProjectBadges({ attention }: { attention: ProjectAttention }) {
  return (
    <span data-attention className="ml-auto flex items-center gap-1.5">
      {attention.waiting > 0 && <WaitingCount count={attention.waiting} label={plural(attention.waiting, '{n} blocking request', '{n} blocking requests')} />}
      {attention.unread > 0 && <UnreadCount count={attention.unread} label={plural(attention.unread, '{n} unread reply', '{n} unread replies')} />}
      {attention.running && <RunningRing />}
    </span>
  )
}
