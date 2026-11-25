// Small pieces shared by the chat.
import { File, Image as ImageIcon } from 'lucide-react'
import type { MouseEvent } from 'react'
import { plural, t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useChatActions } from './chat-context'
import { basename } from './format'

/** Spinning ring. With reduced motion it is dashed and still. */
export function Spinner({ className, label = t('Running') }: { className?: string; label?: string }) {
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

/** Chip for a cited file: opens the file at the line. Shows the name; the full path is in the native tooltip. */
export function FileChip({ path, line, label }: { path: string; line?: number; label?: string }) {
  const { openFile } = useChatActions()
  const full = line ? `${path}:${line}` : path
  const onClick = (event: MouseEvent) => {
    event.preventDefault()
    openFile(path, line, event.altKey)
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${full}\n${t('⌥-click to open in editor')}`}
      aria-label={t('Open {path}', { path: full })}
      className="chat-fref"
    >
      <File aria-hidden className="size-[0.85em] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="truncate">{label ?? basename(path)}</span>
      {line && !label ? <span className="text-faint">:{line}</span> : null}
    </button>
  )
}

/** Attachments of a user message: only name and type, the image is not kept. */
export function AttachmentChips({ attachments }: { attachments: { name: string; mediaType: string }[] }) {
  return (
    <ul aria-label={plural(attachments.length, '{n} attachment', '{n} attachments')} className="flex flex-wrap gap-1">
      {attachments.map((attachment, index) => (
        <li
          key={`${index}:${attachment.name}`}
          title={attachment.name}
          className="inline-flex h-[22px] max-w-[240px] min-w-0 items-center gap-1 rounded-[6px] border border-border bg-background/70 px-1.5 text-xs text-secondary-foreground dark:border-input/70 dark:bg-background/40"
        >
          <ImageIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="truncate">{attachment.name}</span>
        </li>
      ))}
    </ul>
  )
}

/** "New" divider before the first unread content. */
export function NewDivider() {
  return (
    <div role="separator" aria-label={t('New messages')} className="flex items-center gap-2.5 py-1 text-primary">
      <span className="h-px flex-1 bg-primary/45" />
      <span className="text-xs font-semibold">{t('New')}</span>
    </div>
  )
}

export { Kbd } from '@/components/ui/kbd'
