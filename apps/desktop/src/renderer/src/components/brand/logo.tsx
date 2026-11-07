import { cn } from '@/lib/utils'
import { LOGO } from './logo-paths.generated'

interface LogoProps {
  className?: string
  /** Testo per le tecnologie assistive; senza, il logo è decorativo. */
  title?: string
}

function Shape({ shape, className, title }: LogoProps & { shape: keyof typeof LOGO }) {
  const { viewBox, paths } = LOGO[shape]
  return (
    <svg
      viewBox={viewBox}
      className={cn('block fill-current', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {paths.map((path, i) => (
        <path key={i} d={path.d} transform={path.transform ?? undefined} fillRule="evenodd" />
      ))}
    </svg>
  )
}

/**
 * Simbolo di Ladder: tre barre angolari. Per i punti compatti (sidebar, tab, notifiche).
 * Il colore è quello del marchio per il tema corrente (bianco sui temi scuri, iris sui chiari, nero su Mono Light).
 */
export function LadderMark({ className, title }: LogoProps) {
  return <Shape shape="mark" className={cn('text-[var(--ladder-brand-ink)]', className)} title={title} />
}

/** Lockup orizzontale, simbolo e wordmark: per gli spazi larghi. */
export function LadderLockup({ className, title }: LogoProps) {
  return <Shape shape="horizontal" className={cn('text-[var(--ladder-brand-ink)]', className)} title={title} />
}
