import { useId } from 'react'
import { cn } from '@/lib/utils'
import { LOGO } from './logo-paths.generated'

interface LogoProps {
  className?: string
  /** Text for assistive technologies; without it, the logo is decorative. */
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
  * Ladder symbol: three angular bars. For compact spots (sidebar, tabs, notifications).
  * In the interface the logo takes the theme accent (green in Candor, lavender in Circuit, gray in the Mono ones):
  * it follows the theme like everything else. The app icon in the Dock stays Circuit.
 */
export function LadderMark({ className, title }: LogoProps) {
  return <Shape shape="mark" className={cn('text-primary', className)} title={title} />
}

/**
  * Symbol engraved in the surface, tone on tone, for the empty states of chats: decorative, does not take the accent.
  * The inner shadow at the top and the light thread below (globals.css) make it look carved out; colors derive from the theme background.
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

/** Horizontal lockup, symbol and wordmark: for wide spaces. Same color as the symbol. */
export function LadderLockup({ className, title }: LogoProps) {
  return <Shape shape="horizontal" className={cn('text-primary', className)} title={title} />
}
