import { CircleAlert, CircleX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProjectAttention, SessionState } from '@/lib/session-state'

/** Anello che gira: sessione in corso. Con movimento ridotto diventa tratteggiato e fermo. */
export function RunningRing({ className }: { className?: string }) {
  return (
    <span
      aria-label="In corso"
      className={cn(
        'block size-[11px] rounded-full border-[1.6px] border-sidebar-accent border-t-muted-foreground animate-spin',
        'motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-muted-foreground',
        className
      )}
    />
  )
}

/** Punto pieno: c'è una risposta da leggere. */
export function UnreadDot({ className }: { className?: string }) {
  return <span aria-label="Da leggere" className={cn('block size-2 rounded-full bg-primary', className)} />
}

/** Simbolo di stato per una riga di sessione. Ogni stato ha una forma propria, non solo un colore. */
export function SessionGlyph({ state }: { state: SessionState }) {
  switch (state) {
    case 'running':
      return <RunningRing />
    case 'unread':
      return <UnreadDot />
    case 'waiting':
      return <CircleAlert aria-label="Richiede te" className="size-3 text-attention" strokeWidth={2.2} />
    case 'error':
      return <CircleX aria-label="Errore" className="size-3 text-destructive" strokeWidth={2.2} />
    default:
      return null
  }
}

/** Stato aggregato accanto al nome di un progetto chiuso. */
export function ProjectBadges({ attention }: { attention: ProjectAttention }) {
  return (
    <span className="ml-auto flex items-center gap-1.5">
      {attention.waiting > 0 && (
        <span
          aria-label={`${attention.waiting} richieste bloccanti`}
          className="h-4 min-w-4 rounded-[4px] bg-attention px-1 text-center text-[10px] leading-4 font-semibold text-attention-foreground"
        >
          !{attention.waiting}
        </span>
      )}
      {attention.unread > 0 && (
        <span
          aria-label={`${attention.unread} risposte da leggere`}
          className="h-4 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground"
        >
          {attention.unread}
        </span>
      )}
      {attention.running && <RunningRing />}
    </span>
  )
}
