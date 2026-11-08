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
 * Nell'interfaccia il logo prende l'accento del tema (verde in Candor, lavanda in Circuit, grigio nei Mono):
 * segue il tema come il resto. L'icona dell'app nel Dock resta Circuit.
 */
export function LadderMark({ className, title }: LogoProps) {
  return <Shape shape="mark" className={cn('text-primary', className)} title={title} />
}

/** Lockup orizzontale, simbolo e wordmark: per gli spazi larghi. Stesso colore del simbolo. */
export function LadderLockup({ className, title }: LogoProps) {
  return <Shape shape="horizontal" className={cn('text-primary', className)} title={title} />
}
