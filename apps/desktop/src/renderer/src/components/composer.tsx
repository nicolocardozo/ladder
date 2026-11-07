import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, ChevronDown, ImagePlus, Plus, ShieldCheck, Square } from 'lucide-react'
import type { Attachment, Effort, PermissionLevel, QueuedMessage } from '@shared/protocol'
import { IconButton } from '@/components/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { permissionLevels } from '@/lib/agents'
import { send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { acceptImages, AttachmentStrip, IMAGE_ACCEPT, imagePlaceholder, MAX_IMAGES, toAttachment, type PendingImage } from '@/components/composer/attachments'
import { caretCoordinates } from '@/components/composer/caret'
import { findMention, mentionToken, rankFiles, refreshProjectFiles, useProjectFiles, type FileEntry } from '@/components/composer/file-index'
import { MentionPicker, optionId } from '@/components/composer/mention-picker'
import { QueueList } from '@/components/composer/queue-list'

const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Basso' },
  { id: 'medium', label: 'Medio' },
  { id: 'high', label: 'Alto' },
  { id: 'xhigh', label: 'Molto alto' },
  { id: 'max', label: 'Massimo' }
]

interface ComposerProps {
  /** Chiave della bozza: id della sessione o `new:<progetto>`. */
  draftKey: string
  /** Progetto da cui prendere i file per le citazioni con @. */
  projectId: string | null
  agentName: string
  models: { id: string; label: string }[]
  model: string | null
  onModelChange: (model: string) => void
  effort: Effort | null
  /** Presente solo prima di avviare la sessione: l'effort si sceglie all'apertura. */
  onEffortChange?: (effort: Effort) => void
  permission: PermissionLevel
  onPermissionChange: (permission: PermissionLevel) => void
  running?: boolean
  /** Il testo non è mai vuoto: con sole immagini arriva un segnaposto. */
  onSubmit: (text: string, attachments: Attachment[]) => void
  onStop?: () => void
  queue?: QueuedMessage[]
  onQueueChange?: (queue: QueuedMessage[]) => void
  context?: { used: number; window: number } | null
  disabledReason?: string | null
  autoFocus?: boolean
  className?: string
}

const NO_FILES: FileEntry[] = []

const chip =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-input/70 px-2 text-[12px] text-secondary-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-60'

export function Composer(props: ComposerProps) {
  const { draftKey, projectId, agentName, models, model, onModelChange, effort, onEffortChange, permission, onPermissionChange } = props
  const { running, onSubmit, onStop, queue = [], onQueueChange, context, disabledReason, autoFocus, className } = props
  const initial = useApp.getState().drafts[draftKey] ?? ''
  const setDraft = useApp((s) => s.setDraft)
  const [text, setText] = useState(initial)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const level = permissionLevels.find((p) => p.id === permission) ?? permissionLevels[2]
  const modelLabel = models.find((m) => m.id === model)?.label ?? model ?? 'Modello predefinito'
  const disabled = Boolean(disabledReason)

  // Citazioni con @: posizione del cursore (null se c'è una selezione) e citazione chiusa con Esc.
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState<{ query: string; index: number }>({ query: '', index: 0 })
  const [pickerStyle, setPickerStyle] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const listId = useId()
  const files = useProjectFiles(projectId)
  const mention = useMemo(() => (caret === null ? null : findMention(text, caret)), [text, caret])
  const pickerOpen = mention !== null && focused && !disabled && mention.start !== dismissed
  const query = pickerOpen ? mention.query : null
  const results = useMemo(() => (query === null ? NO_FILES : rankFiles(files, query)), [files, query])
  const activeIndex = active.query === query ? Math.min(active.index, Math.max(0, results.length - 1)) : 0

  // Immagini allegate.
  const [images, setImages] = useState<PendingImage[]>([])
  const imageCount = useRef(0)
  imageCount.current = images.length
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    if (autoFocus) textarea.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (pickerOpen && projectId) refreshProjectFiles(projectId)
  }, [pickerOpen, projectId])

  // Una @ cancellata e riscritta nello stesso punto riapre il selettore.
  useEffect(() => {
    if (!mention && dismissed !== null) setDismissed(null)
  }, [mention, dismissed])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // Dopo un inserimento il cursore va subito dopo il testo inserito.
  useLayoutEffect(() => {
    const el = textarea.current
    const next = pendingCaret.current
    if (!el || next === null) return
    pendingCaret.current = null
    el.setSelectionRange(next, next)
    setCaret(next)
  }, [text])

  // Il selettore si apre sopra la riga della @, allineato al carattere.
  const anchor = pickerOpen ? mention.start : null
  useLayoutEffect(() => {
    const el = textarea.current
    const container = box.current
    if (anchor === null || !el || !container) {
      setPickerStyle(null)
      return
    }
    const point = caretCoordinates(el, anchor)
    const width = Math.min(460, container.clientWidth - 12)
    const top = el.offsetTop + Math.min(Math.max(point.top, 0), el.clientHeight - point.height)
    const left = Math.min(Math.max(el.offsetLeft + point.left - 12, 6), container.clientWidth - width - 6)
    setPickerStyle({ left, width, bottom: container.clientHeight - top + 6 })
  }, [anchor, text, images.length])

  // La bozza si salva 500 ms dopo l'ultima battuta e sopravvive al riavvio.
  const updateText = (value: string) => {
    setText(value)
    setDraft(draftKey, value)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => send({ type: 'draft.set', key: draftKey, text: value }), 500)
  }

  const syncCaret = () => {
    const el = textarea.current
    if (!el) return
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const insertMention = (entry: FileEntry) => {
    if (!mention || caret === null) return
    const token = mentionToken(entry.path)
    const after = text.slice(caret)
    const spaced = /^\s/.test(after)
    pendingCaret.current = mention.start + token.length + 1
    updateText(text.slice(0, mention.start) + token + (spaced ? '' : ' ') + after)
  }

  /** Pulsante @: scrive una @ al cursore (con uno spazio davanti se serve) e apre il selettore. */
  const startMention = () => {
    const el = textarea.current
    if (!el || disabled) return
    const before = text.slice(0, el.selectionStart)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    pendingCaret.current = before.length + prefix.length + 1
    updateText(before + prefix + '@' + text.slice(el.selectionEnd))
    setDismissed(null)
    el.focus()
  }

  const addImages = async (list: File[], pasted = false) => {
    if (disabled || list.length === 0) return
    const { images: added, error } = await acceptImages(list, imageCount.current, pasted)
    if (added.length) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES))
    setNotice(error)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    const pasted: File[] = []
    for (const item of data.items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file) pasted.push(file)
    }
    if (pasted.length === 0) return
    // Celle di un foglio di calcolo arrivano come testo più immagine: vince il testo.
    // Un file copiato dal Finder porta come testo il proprio nome: vince l'immagine.
    const plain = data.getData('text/plain').trim()
    if (plain && !pasted.some((file) => file.name === plain)) return
    event.preventDefault()
    void addImages(pasted, true)
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event) || disabled) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event) || disabled) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void addImages([...event.dataTransfer.files])
  }

  const canSend = !disabled && (text.trim().length > 0 || images.length > 0)
  const idle = !text.trim() && images.length === 0

  const submit = () => {
    if (!canSend) return
    onSubmit(text.trim() || imagePlaceholder(images.length), images.map(toAttachment))
    updateText('')
    setImages([])
    setNotice(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return // accenti e tasti morti: non intercettare durante la composizione
    if (pickerOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(mention.start)
        return
      }
      if (results.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive({ query: mention.query, index: (activeIndex + step + results.length) % results.length })
          return
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          event.preventDefault()
          insertMention(results[activeIndex])
          return
        }
      }
    }
    // ⇧Tab cicla i livelli di permesso, come nel CLI di Claude Code.
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      const index = permissionLevels.findIndex((p) => p.id === permission)
      onPermissionChange(permissionLevels[(index + 1) % permissionLevels.length].id)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Escape' && running && onStop && idle) {
      event.preventDefault()
      onStop()
    }
  }

  const contextRatio = context && context.window > 0 ? Math.min(1, context.used / context.window) : null

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      {queue.length > 0 && <QueueList queue={queue} onQueueChange={onQueueChange} onEditEnd={() => textarea.current?.focus()} />}

      <div
        ref={box}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'relative w-full rounded-2xl border border-input bg-composer shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-ring/50',
          dragging && 'border-primary focus-within:border-primary'
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/70 bg-composer/90 text-[12.5px] font-medium text-primary">
            <ImagePlus aria-hidden className="size-4" strokeWidth={1.8} />
            Rilascia per allegare le immagini
          </div>
        )}
        {images.length > 0 && <AttachmentStrip images={images} onRemove={(id) => setImages((current) => current.filter((i) => i.id !== id))} />}
        {notice && (
          <p role="alert" className="px-4 pt-2 text-[12px] text-destructive">
            {notice}
          </p>
        )}
        <label htmlFor={`composer-${draftKey}`} className="sr-only">
          Messaggio per {agentName}
        </label>
        <textarea
          ref={textarea}
          id={`composer-${draftKey}`}
          value={text}
          onChange={(e) => {
            updateText(e.target.value)
            syncCaret()
          }}
          onSelect={syncCaret}
          onFocus={() => {
            setFocused(true)
            syncCaret()
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-autocomplete="list"
          aria-controls={pickerOpen && results.length > 0 ? listId : undefined}
          aria-activedescendant={pickerOpen && results.length > 0 ? optionId(listId, activeIndex) : undefined}
          rows={1}
          disabled={disabled}
          placeholder={disabledReason ?? (running ? 'Scrivi: il messaggio va in coda e parte a fine turno' : `Chiedi a ${agentName}. @ per citare un file, / per i comandi`)}
          className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none [field-sizing:content] placeholder:text-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <IconButton icon={Plus} label="Allega immagini" onClick={() => !disabled && fileInput.current?.click()} />
          <IconButton icon={AtSign} label="Cita un file" shortcut="@" onClick={startMention} />
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              void addImages([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <span className="flex-1" />

          {contextRatio !== null && (
            <Tooltip>
              <TooltipTrigger
                aria-label={`Contesto usato: ${Math.round(contextRatio * 100)}%`}
                className="no-drag mr-1 inline-flex items-center gap-1.5 rounded px-1 font-mono text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span
                  className="block size-3 rounded-full"
                  style={{
                    background: `conic-gradient(var(${contextRatio > 0.8 ? '--attention' : '--muted-foreground'}) 0 ${contextRatio * 100}%, var(--input) ${contextRatio * 100}% 100%)`
                  }}
                />
                <span className={cn(contextRatio > 0.8 && 'text-attention')}>{Math.round(contextRatio * 100)}%</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Contesto usato: {Math.round(context!.used / 1000)}k di {Math.round(context!.window / 1000)}k token
              </TooltipContent>
            </Tooltip>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger className={chip} disabled={disabled}>
              <span className="font-semibold text-foreground">{agentName}</span>
              <span className="text-muted-foreground">· {modelLabel}</span>
              {effort && <span className="text-muted-foreground">· {EFFORTS.find((e) => e.id === effort)?.label.toLowerCase()}</span>}
              <ChevronDown className="size-3 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="max-h-[60vh] w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Modello</DropdownMenuLabel>
                {models.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted-foreground">L’elenco arriva dopo il primo avvio di {agentName}.</p>}
                <DropdownMenuRadioGroup value={model ?? ''} onValueChange={(value) => onModelChange(String(value))}>
                  {models.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {m.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{onEffortChange ? 'Effort' : 'Effort · si sceglie all’apertura della sessione'}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={effort ?? ''} onValueChange={(value) => onEffortChange?.(value as Effort)}>
                  {EFFORTS.map((e) => (
                    <DropdownMenuRadioItem key={e.id} value={e.id} disabled={!onEffortChange}>
                      {e.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={chip} aria-label={`Permessi: ${level.label}`} disabled={disabled}>
              <ShieldCheck className="size-3.5 text-muted-foreground" />
              {level.label}
              <ChevronDown className="size-3 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="w-80">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Permessi · ⇧Tab per cambiare</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={permission} onValueChange={(value) => onPermissionChange(value as PermissionLevel)}>
                  {permissionLevels.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id} className="items-start py-1.5">
                      <span className="flex flex-col">
                        <span className="font-medium">{p.label}</span>
                        <span className="text-[11.5px] text-muted-foreground">{p.hint}</span>
                        {p.native['claude-code'] && <span className="font-mono text-[10.5px] text-faint">Claude Code: {p.native['claude-code']}</span>}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {running && idle && onStop ? (
            <Tooltip>
              <TooltipTrigger
                aria-label="Ferma"
                onClick={onStop}
                className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-secondary text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Square className="size-3 fill-current" />
              </TooltipTrigger>
              <TooltipContent side="top">
                Ferma <span className="ml-1 font-mono text-[11px] opacity-70">⌘.</span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              aria-label={running ? 'Metti in coda' : 'Invia'}
              disabled={!canSend}
              onClick={submit}
              className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-faint"
            >
              <ArrowUp className="size-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
        {pickerOpen && pickerStyle && (
          <MentionPicker
            id={listId}
            results={results}
            active={activeIndex}
            loading={files.loading || (files.entries === null && !files.error)}
            error={files.error}
            hasProject={projectId !== null}
            query={mention.query}
            style={pickerStyle}
            onHover={(index) => setActive({ query: mention.query, index })}
            onChoose={insertMention}
          />
        )}
      </div>
    </div>
  )
}
