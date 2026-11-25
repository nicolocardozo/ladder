import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Single-line text with an ellipsis. When `active` and the text does not fit, it scrolls to the end and back. */
export function MarqueeText({ children, active, className }: { children: ReactNode; active: boolean; className?: string }) {
  const outer = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const element = outer.current
    setShift(active && element ? Math.max(0, element.scrollWidth - element.clientWidth) : 0)
  }, [active, children])
  const moving = active && shift > 0
  const style = moving ? ({ '--marquee-shift': `-${shift + 4}px`, '--marquee-time': `${Math.max(2.5, shift / 35 + 1.5)}s` } as CSSProperties) : undefined
  return (
    <span ref={outer} className={cn('block min-w-0 overflow-hidden whitespace-nowrap', !moving && 'text-ellipsis', className)}>
      <span className={moving ? 'marquee-run inline-block' : undefined} style={style}>
        {children}
      </span>
    </span>
  )
}
