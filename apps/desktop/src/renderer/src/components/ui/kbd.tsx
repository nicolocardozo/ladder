// Scorciatoia da tastiera, un tasto per ogni simbolo. Usa il carattere di sistema: è l'unico che disegna bene ⌘ ⇧ ⌥ ⌃.
import { Children, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const SINGLE = /[⌘⇧⌥⌃↑↓←→↵⌫⇥]/

/** "⌘⇧N" diventa ⌘, ⇧, N; "⌘⌥1–4" diventa ⌘, ⌥, 1–4; "esc" resta intero. */
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

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  const combo = Children.toArray(children).join('').trim()
  return (
    <span aria-label={combo} role="img" className={cn('inline-flex shrink-0 items-center gap-0.5 align-middle', className)}>
      {keysOf(combo).map((key, i) => (
        <kbd key={i} className={cn('kbd-key inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] bg-current/10 px-1 leading-none font-medium', SINGLE.test(key) ? 'text-sm' : 'text-xs')}>
          {key}
        </kbd>
      ))}
    </span>
  )
}
