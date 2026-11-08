// Messaggi in coda sopra il composer: un clic li rende modificabili, × li toglie.
import { useLayoutEffect, useRef, useState } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import type { QueuedMessage } from '@shared/protocol'
import { plural, t } from '@shared/i18n'

interface QueueListProps {
  queue: QueuedMessage[]
  onQueueChange?: (queue: QueuedMessage[]) => void
  /** Dopo ↵ o Esc il focus torna al composer. */
  onEditEnd?: () => void
}

const rowButton =
  'grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'

export function QueueList({ queue, onQueueChange, onEditEnd }: QueueListProps) {
  const [editing, setEditing] = useState<string | null>(null)
  // Il messaggio può partire mentre lo si modifica: si salva solo se è ancora in coda.
  const latest = useRef(queue)
  latest.current = queue

  const save = (id: string, value: string) => {
    setEditing(null)
    const current = latest.current
    const message = current.find((m) => m.id === id)
    if (!message) return
    const text = value.trim()
    if (text === message.text) return
    onQueueChange?.(text ? current.map((m) => (m.id === id ? { ...m, text } : m)) : current.filter((m) => m.id !== id))
  }

  return (
    <div className="flex flex-col gap-1">
      {queue.map((message, index) => {
        const images = message.attachments?.length ?? 0
        return (
          <div
            key={message.id}
            className="flex items-start gap-2.5 rounded-lg border border-dashed border-input bg-muted/40 px-3 py-1.5 text-sm text-secondary-foreground has-[textarea:focus]:border-solid has-[textarea:focus]:border-ring/50"
          >
            <span className="mt-[3px] font-mono text-xs leading-4 whitespace-nowrap text-faint">
              {index === 0 ? t('Queued') : `+${index}`}
            </span>
            {editing === message.id ? (
              <QueueEditor
                initial={message.text}
                onSave={(value, keyboard) => {
                  save(message.id, value)
                  if (keyboard) onEditEnd?.()
                }}
                onCancel={() => {
                  setEditing(null)
                  onEditEnd?.()
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => onQueueChange && setEditing(message.id)}
                title={t('Click to edit')}
                aria-label={t('Edit queued message: {text}', { text: message.text })}
                className="min-w-0 flex-1 cursor-text truncate rounded-[4px] text-left leading-5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {message.text}
              </button>
            )}
            {images > 0 && (
              <span
                aria-label={plural(images, '{n} image', '{n} images')}
                className="mt-px inline-flex h-[18px] shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground"
              >
                <ImageIcon aria-hidden className="size-3" strokeWidth={1.9} />
                {images}
              </span>
            )}
            <button
              type="button"
              aria-label={t('Remove from queue')}
              onClick={() => onQueueChange?.(queue.filter((m) => m.id !== message.id))}
              className={rowButton}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function QueueEditor({ initial, onSave, onCancel }: { initial: string; onSave: (value: string, keyboard: boolean) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const finish = (action: () => void) => {
    if (finished.current) return
    finished.current = true
    action()
  }

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      aria-label={t('Edit queued message. Return saves, Esc cancels, empty removes it')}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          finish(() => onSave(value, true))
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(onCancel)
        }
      }}
      onBlur={() => finish(() => onSave(value, false))}
      className="block max-h-40 min-w-0 flex-1 resize-none bg-transparent leading-5 text-foreground outline-none [field-sizing:content]"
    />
  )
}
