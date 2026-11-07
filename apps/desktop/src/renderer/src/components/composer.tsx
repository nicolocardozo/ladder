import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, ChevronDown, Plus, ShieldCheck, Square, X } from 'lucide-react'
import type { Effort, PermissionLevel, QueuedMessage } from '@shared/protocol'
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
  onSubmit: (text: string) => void
  onStop?: () => void
  queue?: QueuedMessage[]
  onQueueChange?: (queue: QueuedMessage[]) => void
  context?: { used: number; window: number } | null
  disabledReason?: string | null
  autoFocus?: boolean
  className?: string
}

const chip =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-input/70 px-2 text-[12px] text-secondary-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-60'

export function Composer(props: ComposerProps) {
  const { draftKey, agentName, models, model, onModelChange, effort, onEffortChange, permission, onPermissionChange } = props
  const { running, onSubmit, onStop, queue = [], onQueueChange, context, disabledReason, autoFocus, className } = props
  const initial = useApp.getState().drafts[draftKey] ?? ''
  const setDraft = useApp((s) => s.setDraft)
  const [text, setText] = useState(initial)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<number | null>(null)
  const level = permissionLevels.find((p) => p.id === permission) ?? permissionLevels[2]
  const modelLabel = models.find((m) => m.id === model)?.label ?? model ?? 'Modello predefinito'
  const disabled = Boolean(disabledReason)

  useEffect(() => {
    if (autoFocus) textarea.current?.focus()
  }, [autoFocus])

  // La bozza si salva 500 ms dopo l'ultima battuta e sopravvive al riavvio.
  const updateText = (value: string) => {
    setText(value)
    setDraft(draftKey, value)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => send({ type: 'draft.set', key: draftKey, text: value }), 500)
  }

  const submit = () => {
    const value = text.trim()
    if (!value || disabled) return
    onSubmit(value)
    updateText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return // accenti e tasti morti: non intercettare durante la composizione
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
    if (event.key === 'Escape' && running && onStop && !text) {
      event.preventDefault()
      onStop()
    }
  }

  const contextRatio = context && context.window > 0 ? Math.min(1, context.used / context.window) : null

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      {queue.length > 0 && (
        <div className="flex flex-col gap-1">
          {queue.map((message, index) => (
            <div
              key={message.id}
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-input bg-muted/40 px-3 py-1.5 text-[12.5px] text-secondary-foreground"
            >
              <span className="font-mono text-[10px] tracking-wider whitespace-nowrap text-faint uppercase">{index === 0 ? 'In coda' : `+${index}`}</span>
              <span className="min-w-0 flex-1 truncate">{message.text}</span>
              <button
                type="button"
                aria-label="Togli dalla coda"
                onClick={() => onQueueChange?.(queue.filter((m) => m.id !== message.id))}
                className="grid size-5 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="w-full rounded-2xl border border-input bg-composer shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-ring/50">
        <label htmlFor={`composer-${draftKey}`} className="sr-only">
          Messaggio per {agentName}
        </label>
        <textarea
          ref={textarea}
          id={`composer-${draftKey}`}
          value={text}
          onChange={(e) => updateText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={disabledReason ?? (running ? 'Scrivi: il messaggio va in coda e parte a fine turno' : `Chiedi a ${agentName}. @ per citare un file, / per i comandi`)}
          className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed outline-none [field-sizing:content] placeholder:text-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <IconButton icon={Plus} label="Allega file o immagini" />
          <IconButton icon={AtSign} label="Cita un file" shortcut="@" />
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

          {running && !text.trim() && onStop ? (
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
              disabled={disabled || text.trim().length === 0}
              onClick={submit}
              className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-faint"
            >
              <ArrowUp className="size-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
