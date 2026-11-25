// Keyboard shortcut, one key per symbol. Uses the system font: it is the only one that draws ⌘ ⇧ ⌥ ⌃ well.
import { Children, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const SINGLE = /[⌘⇧⌥⌃↑↓←→↵⌫⇥]/

/** "⌘⇧N" becomes ⌘, ⇧, N; "⌘⌥1–4" becomes ⌘, ⌥, 1–4; "esc" stays whole. */
function keysOf(combo: string): string[] {
  const keys: string[] = []
  let rest = ''
  for (const char of combo) {
    if (SINGLE.test(char)) {
      if (rest) keys.push(rest)
      rest = ''
      keys.push(char)
    } else {
      rest += char
    }
  }
  if (rest) keys.push(rest)
  return keys
}

/** separator: what to put between one key and the next (e.g. "+" for "⇧ + Tab"); without it, the keys are just placed next to each other. */
export function Kbd({ children, className, separator }: { children: ReactNode; className?: string; separator?: ReactNode }) {
  const combo = Children.toArray(children).join('').trim()
  return (
    <span aria-label={combo} role="img" className={cn('inline-flex shrink-0 items-center align-middle', separator ? 'gap-1' : 'gap-0.5', className)}>
      {keysOf(combo).map((key, i) => [
        i > 0 && separator ? <span key={`s${i}`} aria-hidden>{separator}</span> : null,
        <kbd key={i} className={cn('kbd-key inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] bg-current/10 px-1 leading-none font-medium', SINGLE.test(key) ? 'text-sm' : 'text-xs')}>
          {key}
        </kbd>
      ])}
    </span>
  )
}
