// Pezzi piccoli condivisi dalla chat.
import { File } from 'lucide-react'
import type { MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import { useChatActions } from './chat-context'
import { basename } from './format'

/** Anello che gira. Con movimento ridotto è tratteggiato e fermo. */
export function Spinner({ className, label = 'In corso' }: { className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'inline-block size-[11px] shrink-0 rounded-full border-[1.6px] border-input border-t-muted-foreground animate-spin',
        'motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-muted-foreground',
        className
      )}
    />
  )
}

/** Chip di un file citato: apre il file alla riga. Mostra il nome, il percorso completo è nel tooltip nativo. */
export function FileChip({ path, line, label }: { path: string; line?: number; label?: string }) {
  const { openFile } = useChatActions()
  const full = line ? `${path}:${line}` : path
  const onClick = (event: MouseEvent) => {
    event.preventDefault()
    openFile(path, line)
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={full}
      aria-label={`Apri ${full}`}
      className="chat-fref"
    >
      <File aria-hidden className="size-[0.85em] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="truncate">{label ?? basename(path)}</span>
      {line && !label ? <span className="text-faint">:{line}</span> : null}
    </button>
  )
}

/** Divisore "Nuovo" prima del primo contenuto non letto. */
export function NewDivider() {
  return (
    <div role="separator" aria-label="Nuovi messaggi" className="flex items-center gap-2.5 py-1 text-primary">
      <span className="h-px flex-1 bg-primary/45" />
      <span className="text-[11px] font-semibold tracking-[0.04em]">Nuovo</span>
    </div>
  )
}

export function Kbd({ children, className }: { children: string; className?: string }) {
  return <kbd className={cn('font-mono text-[10.5px] font-medium opacity-65', className)}>{children}</kbd>
}
