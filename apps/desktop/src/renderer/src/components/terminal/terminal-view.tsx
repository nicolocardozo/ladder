// Un terminale dell'host dentro un contenitore. Selezionando del testo compare "Aggiungi alla chat".
import { useEffect, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { clearTerminalSelection, focusTerminal, mountTerminal, onTerminalSelection } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

interface TerminalViewProps {
  id: string
  /** Bozza del composer in cui inserire la selezione. */
  composerKey: string | null
  autoFocus?: boolean
  className?: string
}

export function TerminalView({ id, composerKey, autoFocus, className }: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState('')
  const insert = useApp((s) => s.insertIntoComposer)
  const title = useApp((s) => s.terminals[id]?.title ?? 'terminale')

  useEffect(() => {
    if (!container.current) return
    const unmount = mountTerminal(id, container.current)
    if (autoFocus) requestAnimationFrame(() => focusTerminal(id))
    return unmount
  }, [id, autoFocus])

  useEffect(() => onTerminalSelection(id, (text) => setSelection(text.trim())), [id])

  const addToChat = () => {
    if (!composerKey || !selection) return
    insert(composerKey, `Output del terminale “${title}”:\n\n\`\`\`text\n${selection}\n\`\`\`\n`)
    clearTerminalSelection(id)
    setSelection('')
  }

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-col', className)}>
      {/* Il margine è del contenitore esterno: quello di xterm deve riempire tutto lo spazio rimasto. */}
      <div className="relative min-h-0 flex-1">
        <div ref={container} className="ladder-terminal absolute inset-0 overflow-hidden" />
      </div>
      {selection && composerKey && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={addToChat}
          className="absolute top-2 right-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-popover px-2 text-[12px] text-popover-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <MessageSquarePlus className="size-3.5" />
          Aggiungi alla chat
        </button>
      )}
    </div>
  )
}
