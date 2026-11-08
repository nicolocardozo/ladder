import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, ChevronDown, Clock, ImagePlus, Plus, ShieldCheck, Square } from 'lucide-react'
import type { AgentId, Attachment, Effort, PermissionLevel, QueuedMessage } from '@shared/protocol'
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
import { allowedLevels, nativeKey, permissionLevels } from '@/lib/agents'
import { request, send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { acceptImages, AttachmentStrip, IMAGE_ACCEPT, imagePlaceholder, MAX_IMAGES, toAttachment, type PendingImage } from '@/components/composer/attachments'
import { caretCoordinates } from '@/components/composer/caret'
import { findMention, mentionToken, rankFiles, refreshProjectFiles, useProjectFiles } from '@/components/composer/file-index'
import { MentionPicker, optionId, type MentionOption } from '@/components/composer/mention-picker'
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
  /** Vale solo all'apertura: il composer prende il focus e rimette il cursore dove l'avevi lasciato. */
  autoFocus?: boolean
  /** Riga sopra il composer: "In coda: 3 sessioni Claude Code attive". */
  status?: string | null
  /** Agente della sessione: dice a cosa corrispondono i livelli di permesso. */
  agent?: AgentId
  /** Falso per gli agenti che scelgono il ragionamento con le loro opzioni (ACP). */
  showEffort?: boolean
  /** Livello massimo ammesso dal progetto ([agents] permissions_max). */
  maxPermission?: PermissionLevel | null
  className?: string
}

/** Cursore per bozza: tornando su una sessione (⌘[) riprendi a scrivere nel punto in cui eri. */
const carets = new Map<string, [number, number]>()

const NO_OPTIONS: MentionOption[] = []

/** Token di @terminal nel testo: il titolo senza spazi. */
const terminalToken = (title: string) => `@terminal:${title.trim().replace(/\s+/g, '-') || 'terminale'}`

const chip =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-input/70 px-2 text-[12px] text-secondary-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-60'

export function Composer(props: ComposerProps) {
  const { draftKey, projectId, agentName, models, model, onModelChange, effort, onEffortChange, permission, onPermissionChange } = props
  const { running, onSubmit, onStop, queue = [], onQueueChange, context, disabledReason, autoFocus, status, className } = props
  const { agent = 'claude-code', showEffort = true, maxPermission = null } = props
  const levels = allowedLevels(maxPermission)
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
  const allTerminals = useApp((s) => s.terminals)
  const mention = useMemo(() => (caret === null ? null : findMention(text, caret)), [text, caret])
  const pickerOpen = mention !== null && focused && !disabled && mention.start !== dismissed
  const query = pickerOpen ? mention.query : null
  // Terminali citabili con @terminal: compaiono quando scrivi "te…" o parte del loro nome.
  const terminalRefs = useRef(new Map<string, string>())
  const results = useMemo<MentionOption[]>(() => {
    if (query === null) return NO_OPTIONS
    const lower = query.toLowerCase()
    const explicit = lower.startsWith('terminal:')
    const name = explicit ? lower.slice('terminal:'.length) : lower
    const allOfThem = explicit ? !name : lower.length >= 2 && 'terminal'.startsWith(lower)
    const terminals: MentionOption[] = Object.values(allTerminals)
      .filter((t) => t.projectId === projectId)
      .filter((t) => allOfThem || (name.length >= 2 && t.title.toLowerCase().includes(name)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 4)
      .map((t) => ({ kind: 'terminal', id: t.id, title: t.title, detail: t.command ?? t.cwd }))
    const fileResults: MentionOption[] = explicit ? [] : rankFiles(files, query).map((entry) => ({ kind: 'file', entry }))
    return [...terminals, ...fileResults]
  }, [files, query, allTerminals, projectId])
  const activeIndex = active.query === query ? Math.min(active.index, Math.max(0, results.length - 1)) : 0

  // Immagini allegate.
  const [images, setImages] = useState<PendingImage[]>([])
  const imageCount = useRef(0)
  imageCount.current = images.length
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    const el = textarea.current
    if (autoFocus && el) {
      // Prima si legge il cursore salvato: il focus fa scattare onFocus, che lo riscriverebbe.
      const saved = carets.get(draftKey)
      el.focus()
      if (saved) el.setSelectionRange(Math.min(saved[0], el.value.length), Math.min(saved[1], el.value.length))
      else el.setSelectionRange(el.value.length, el.value.length)
    }
    // Solo all'apertura: dopo, il focus lo decide l'utente (o la card di una richiesta).
  }, [])

  // Uscendo dalla sessione la bozza si salva subito, senza aspettare i 500 ms.
  const latestText = useRef(text)
  latestText.current = text
  useEffect(
    () => () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        send({ type: 'draft.set', key: draftKey, text: latestText.current })
      }
    },
    [draftKey]
  )

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
    carets.set(draftKey, [el.selectionStart, el.selectionEnd])
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const insertMention = (option: MentionOption) => {
    if (!mention || caret === null) return
    let token: string
    if (option.kind === 'terminal') {
      token = terminalToken(option.title)
      terminalRefs.current.set(token, option.id)
    } else token = mentionToken(option.entry.path)
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

  /** @terminal:nome diventa un riferimento nel testo, e l'output del terminale va in fondo al messaggio. */
  const expandTerminals = async (value: string): Promise<string> => {
    const tokens = [...new Set(value.match(/@terminal:[^\s]+/g) ?? [])]
    if (tokens.length === 0) return value
    const blocks: string[] = []
    let body = value
    for (const token of tokens) {
      const title = token.slice('@terminal:'.length)
      const id =
        terminalRefs.current.get(token) ??
        Object.values(useApp.getState().terminals).find((t) => t.projectId === projectId && terminalToken(t.title) === token)?.id
      if (!id) continue
      const output = await request<string>({ type: 'terminal.output', id, lines: 200 }).catch(() => null)
      if (output === null) continue
      body = body.split(token).join(`il terminale “${title}” (output in fondo)`)
      blocks.push(`Output del terminale “${title}” (ultime righe):\n\n\`\`\`text\n${output}\n\`\`\``)
    }
    return blocks.length ? `${body}\n\n${blocks.join('\n\n')}` : body
  }

  const submit = () => {
    if (!canSend) return
    const value = text.trim() || imagePlaceholder(images.length)
    const attachments = images.map(toAttachment)
    updateText('')
    setImages([])
    setNotice(null)
    void expandTerminals(value).then((expanded) => onSubmit(expanded, attachments))
  }

  // Testo da "Aggiungi alla chat" (viewer, terminale): va al cursore, o in fondo, e il focus torna qui.
  const insertRequest = useApp((s) => (s.composerInsert?.key === draftKey ? s.composerInsert : null))
  const handledInsert = useRef(insertRequest?.nonce ?? 0)
  useEffect(() => {
    if (!insertRequest || insertRequest.nonce === handledInsert.current) return
    handledInsert.current = insertRequest.nonce
    const el = textarea.current
    const at = el && document.activeElement === el ? el.selectionStart : text.length
    const before = text.slice(0, at)
    const glue = before && !before.endsWith('\n') ? '\n' : ''
    const value = before + glue + insertRequest.text + text.slice(at)
    pendingCaret.current = (before + glue + insertRequest.text).length
    updateText(value)
    el?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertRequest])

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
      const index = levels.indexOf(permission)
      onPermissionChange(levels[(index + 1) % levels.length])
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
      {status ? (
        <p role="status" className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
          <Clock aria-hidden className="size-3.5" strokeWidth={2} />
          {status}
        </p>
      ) : null}
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
              {effort && showEffort && <span className="text-muted-foreground">· {EFFORTS.find((e) => e.id === effort)?.label.toLowerCase()}</span>}
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
              {showEffort && <DropdownMenuSeparator />}
              {showEffort && <DropdownMenuGroup>
                <DropdownMenuLabel>{onEffortChange ? 'Effort' : 'Effort · si sceglie all’apertura della sessione'}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={effort ?? ''} onValueChange={(value) => onEffortChange?.(value as Effort)}>
                  {EFFORTS.map((e) => (
                    <DropdownMenuRadioItem key={e.id} value={e.id} disabled={!onEffortChange}>
                      {e.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>}
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
                    <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!levels.includes(p.id)} className="items-start py-1.5">
                      <span className="flex flex-col">
                        <span className="font-medium">{p.label}</span>
                        <span className="text-[11.5px] text-muted-foreground">{levels.includes(p.id) ? p.hint : 'Non ammesso da .ladder/settings.toml'}</span>
                        <span className="font-mono text-[10.5px] text-faint">{agentName}: {p.native[nativeKey(agent)]}</span>
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
