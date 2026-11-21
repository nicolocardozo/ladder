import { useId } from 'react'
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

/**
 * Simbolo inciso nella superficie, tono su tono, per gli stati vuoti delle chat: decorativo, non prende l'accento.
 * L'ombra interna in alto e il filo chiaro sotto (globals.css) lo fanno sembrare scavato; i colori derivano dal fondo del tema.
 */
export function LadderEngraved({ className }: { className?: string }) {
  const filter = useId().replace(/[^a-zA-Z0-9]/g, '')
  const { viewBox, paths } = LOGO.mark
  return (
    <svg viewBox={viewBox} aria-hidden="true" className={cn('ladder-engraved block overflow-visible', className)}>
      <defs>
        <filter id={filter} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.7" result="blur" />
          <feOffset in="blur" dy="2.4" result="moved" />
          <feComposite in="SourceAlpha" in2="moved" operator="out" result="edge" />
          <feFlood className="ladder-engraved-shade" result="shade" />
          <feComposite in="shade" in2="edge" operator="in" result="inner" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="inner" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#${filter})`}>
        {paths.map((path, i) => (
          <path key={i} d={path.d} transform={path.transform ?? undefined} fillRule="evenodd" />
        ))}
      </g>
    </svg>
  )
}

/** Lockup orizzontale, simbolo e wordmark: per gli spazi larghi. Stesso colore del simbolo. */
export function LadderLockup({ className, title }: LogoProps) {
  return <Shape shape="horizontal" className={cn('text-primary', className)} title={title} />
}
