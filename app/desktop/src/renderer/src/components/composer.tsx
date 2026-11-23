import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { matchesCommand, shortcutLabel } from '@shared/shortcuts'
import { ArrowUp, AtSign, ChevronDown, Clock, ImagePlus, Plus, RotateCcw, ShieldCheck, Square } from 'lucide-react'
import type { AgentId, Attachment, Effort, PermissionLevel, QueuedMessage, SessionSummary, SlashCommand } from '@shared/protocol'
import { t } from '@shared/i18n'
import { formatTokens } from '@/components/subagent-bits'
import { IconButton } from '@/components/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { allowedLevels, EFFORTS, levelHint, levelLabel, levelNative, permissionLevels } from '@/lib/agents'
import { AgentMark, modelLabel as prettyModel } from '@/components/agent-mark'
import { AgentBadge } from '@/components/agent-map'
import { request, send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { altSendCombo, isAltSendKey, isSendKey, resolveBusy, sendKeyCombos, useSendKey, type BusyAction } from '@/lib/send-key'
import { Kbd } from '@/components/ui/kbd'
import { useApp } from '@/store/app-store'
import { acceptAttachments, acceptImages, AttachmentStrip, IMAGE_ACCEPT, imagePlaceholder, MAX_IMAGES, toAttachment, type PendingImage } from '@/components/composer/attachments'
import { caretCoordinates } from '@/components/composer/caret'
import { findMention, mentionToken, rankFiles, refreshProjectFiles, useProjectFiles } from '@/components/composer/file-index'
import { MentionPicker, optionId, type PickerOption } from '@/components/composer/mention-picker'
import { argsAfterToken, findSlash, isLadderCommand, mergeCommands, parseSlash, rankCommands, type CommandEntry } from '@/components/composer/slash-commands'
import { DefaultBadge } from '@/components/default-badge'
import { effectiveEffort, defaultsToken, effectiveModel, useAgentDefaults } from '@/lib/effective-defaults'
import { hostProfileId } from '@/lib/profiles'
import { EffortSlider } from '@/components/composer/effort-slider'
import { QueueList } from '@/components/composer/queue-list'
import { UsageButton } from '@/components/composer/usage-button'
import { UsageBanner } from '@/components/composer/usage-banner'


interface ComposerProps {
  /** Chiave della bozza: id della sessione o `new:<progetto>`. */
  draftKey: string
  /** Progetto da cui prendere i file per le citazioni con @. */
  projectId: string | null
  agentName: string
  models: { id: string; label: string; efforts?: Effort[]; isDefault?: boolean; defaultEffort?: Effort | null }[]
  /** Scelta esplicita: null = nessuna, parte il predefinito (di Ladder, poi dell'agente). */
  model: string | null
  onModelChange: (model: string) => void
  /** Torna al predefinito; senza, la voce "Reset to default" non compare. */
  onModelReset?: (defaultModel: string) => void
  effort: Effort | null
  onEffortChange: (effort: Effort) => void
  onEffortReset?: (defaultEffort: Effort) => void
  /** Effort davvero in uso quando la sessione non ne ha scelto uno (SessionSummary.effortEffective). */
  effortEffective?: Effort | null
  permission: PermissionLevel
  /** Livello chiesto che vale dal prossimo turno; il livello attuale resta quello di `permission`. */
  permissionNext?: PermissionLevel | null
  onPermissionChange: (permission: PermissionLevel) => void
  running?: boolean
  /** Il testo non è mai vuoto: con sole immagini arriva un segnaposto. */
  onSubmit: (text: string, attachments: Attachment[], busy?: BusyAction) => void
  onStop?: () => void
  queue?: QueuedMessage[]
  onQueueChange?: (queue: QueuedMessage[]) => void
  /** L'agente accetta messaggi dentro il turno (SessionSummary.canSteer). Senza, "inserisci nel turno" ricade sulla coda. */
  canSteer?: boolean
  /** Consegna un messaggio in coda adesso: dentro il turno o interrompendolo (session.queue.deliver). */
  onDeliver?: (id: string, how: 'steer' | 'now') => void
  /** Perché la coda aspetta ("3 agents working"), mostrato accanto a "Sends when the turn ends". */
  queueReason?: string | null
  /** La coda parte da sola a fine turno solo se la sessione lavora; da ferma aspetta un nuovo messaggio. Predefinito: running. */
  queueWorking?: boolean
  context?: { used: number; window: number; compactAt?: number | null } | null
  disabledReason?: string | null
  /** Vale solo all'apertura: il composer prende il focus e rimette il cursore dove l'avevi lasciato. */
  autoFocus?: boolean
  /** Agente della sessione: dice a cosa corrispondono i livelli di permesso. */
  agent?: AgentId
  /** Profilo (account) della sessione o scelto per la nuova chat: di lui sono i limiti d'uso. Assente = predefinito. */
  profileId?: string | null
  /** Falso per gli agenti che scelgono il ragionamento con le loro opzioni (ACP). */
  showEffort?: boolean
  /** Comandi / dichiarati dall'agente della sessione. Assenti nella nuova chat: restano solo quelli di Ladder. */
  commands?: SlashCommand[]
  /** Esegue un comando dell'agente (richiesta 'session.command'). Gli errori li mostra chi lo implementa. */
  /** Se restituisce una promessa, il testo si svuota solo quando si risolve; se si rifiuta resta dov'è. */
  onCommand?: (name: string, args: string) => Promise<unknown> | void
  /** /new: apre una nuova sessione nel progetto, con gli argomenti come testo di partenza. Senza, /new non compare. */
  onNewSession?: (args: string) => void
  /** Livello massimo ammesso dal progetto ([agents] permissions_max). */
  maxPermission?: PermissionLevel | null
  /** Colonna stretta: restano icona e modello, il livello di permessi è la sola icona e i pulsanti secondari spariscono. */
  compact?: boolean
  /** Sessione e sotto-agenti: se ce ne sono, nella barra in basso compare il badge degli agenti. */
  sessionId?: string
  subagentCounts?: SessionSummary['subagentCounts']
  className?: string
}

/** Cursore per bozza: tornando su una sessione (⌘[) riprendi a scrivere nel punto in cui eri. */
const carets = new Map<string, [number, number]>()

const NO_OPTIONS: PickerOption[] = []

/** Modello scelto con /model <testo>: id o nome esatti, poi un solo nome che inizia o contiene il testo. */
function findModel(models: { id: string; label: string }[], value: string) {
  const q = value.toLowerCase()
  const exact = models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q)
  if (exact) return exact
  for (const test of [(m: { id: string; label: string }) => m.id.toLowerCase().startsWith(q) || m.label.toLowerCase().startsWith(q), (m: { id: string; label: string }) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)]) {
    const hits = models.filter(test)
    if (hits.length === 1) return hits[0]
  }
  return null
}

/** Token di @terminal nel testo: il titolo senza spazi. */
const terminalToken = (title: string) => `@terminal:${title.trim().replace(/\s+/g, '-') || t('terminal')}`

const chip =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-input/70 px-2 text-xs text-secondary-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-60'

export function Composer(props: ComposerProps) {
  useShortcutsRevision()
  const { draftKey, projectId, agentName, models, model, onModelChange, onModelReset, effort, onEffortChange, onEffortReset, effortEffective, permission, permissionNext, onPermissionChange } = props
  const { running, onSubmit, onStop, queue = [], onQueueChange, canSteer = false, onDeliver, queueReason, queueWorking = running, context, disabledReason, autoFocus, className } = props
  const { agent = 'claude-code', showEffort = true, maxPermission = null, commands: agentCommands, onCommand, onNewSession, compact = false } = props
  const levels = allowedLevels(maxPermission)
  const initial = useApp.getState().drafts[draftKey] ?? ''
  const setDraft = useApp((s) => s.setDraft)
  const [text, setText] = useState(initial)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  // Comando dell'agente in attesa della risposta dell'host: finché dura, Invio non parte due volte.
  const commandPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [sendingCommand, setCommandPending] = useState(false)
  const level = permissionLevels.find((p) => p.id === permission) ?? permissionLevels[2]
  // Il modello scelto dice quali livelli di effort esistono; senza informazioni, tutti.
  // Senza scelta parte il predefinito. Alla creazione conta quello di Ladder (progetto, poi globale); poi quello dell'agente per il progetto.
  // Una sessione già creata ignora i predefiniti di Ladder: vale ciò che l'agente riporta.
  const isSession = Boolean(props.sessionId)
  const projectDefaults = useApp((s) => (projectId ? s.ui[projectId]?.defaults : undefined))
  const globalDefaults = useApp((s) => s.prefs?.defaults)
  const ladder = useMemo(() => (isSession ? null : { project: projectDefaults, global: globalDefaults }), [isSession, projectDefaults, globalDefaults])
  const agentDefaults = useAgentDefaults(agent, projectId, hostProfileId(props.profileId), defaultsToken({ agent, profileId: props.profileId ?? undefined, models }))
  const defaultModel = useMemo(() => effectiveModel(agent, models, ladder, agentDefaults), [agent, models, ladder, agentDefaults])
  const shownModel = model ?? defaultModel.value
  const defaultEffort = useMemo(() => effectiveEffort(agent, models, shownModel, ladder, effortEffective, agentDefaults), [agent, models, shownModel, ladder, effortEffective, agentDefaults])
  const shownEffort = effort ?? defaultEffort.value
  const effortLevels: Effort[] = (models.find((m) => m.id === shownModel)?.efforts ?? EFFORTS.map((e) => e.id)).filter((level) => EFFORTS.some((e) => e.id === level))
  const modelName = models.find((m) => m.id === shownModel)?.label ?? prettyModel(null, shownModel) ?? t('Default model')
  const disabled = Boolean(disabledReason)

  // Citazioni con @: posizione del cursore (null se c'è una selezione) e citazione chiusa con Esc.
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState<{ key: string | null; index: number }>({ key: null, index: 0 })
  const [pickerStyle, setPickerStyle] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const listId = useId()
  const files = useProjectFiles(projectId)
  const allTerminals = useApp((s) => s.terminals)
  const mention = useMemo(() => (caret === null ? null : findMention(text, caret)), [text, caret])
  // Comando / a inizio messaggio: stessa struttura della citazione, mai insieme (una comincia con @, l'altro con /).
  const slash = useMemo(() => (caret === null ? null : findSlash(text, caret)), [text, caret])
  const trigger = mention ?? slash
  const mode = mention ? 'mention' : 'command'
  const commandList = useMemo(
    () => mergeCommands(onCommand ? agentCommands : undefined, { model: true, effort: showEffort, new: Boolean(onNewSession) }),
    [agentCommands, onCommand, onNewSession, showEffort]
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const menuFromCommand = useRef(false)
  const pickerOpen = trigger !== null && focused && !disabled && trigger.start !== dismissed
  const query = pickerOpen ? trigger.query : null
  const pickerKey = query === null ? null : `${mode}:${query}`
  // Terminali citabili con @terminal: compaiono quando scrivi "te…" o parte del loro nome.
  const terminalRefs = useRef(new Map<string, string>())
  const results = useMemo<PickerOption[]>(() => {
    if (query === null) return NO_OPTIONS
    if (mode === 'command') {
      return rankCommands(commandList, query).map((entry) => ({
        kind: 'command',
        entry,
        disabled: running && !isLadderCommand(entry) ? t('Wait for the current turn to finish.') : null
      }))
    }
    const lower = query.toLowerCase()
    const explicit = lower.startsWith('terminal:')
    const name = explicit ? lower.slice('terminal:'.length) : lower
    const allOfThem = explicit ? !name : lower.length >= 2 && 'terminal'.startsWith(lower)
    const terminals: PickerOption[] = Object.values(allTerminals)
      .filter((t) => t.projectId === projectId)
      .filter((t) => allOfThem || (name.length >= 2 && t.title.toLowerCase().includes(name)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 4)
      .map((t) => ({ kind: 'terminal', id: t.id, title: t.title, detail: t.command ?? t.cwd }))
    const fileResults: PickerOption[] = explicit ? [] : rankFiles(files, query).map((entry) => ({ kind: 'file', entry }))
    return [...terminals, ...fileResults]
  }, [files, query, mode, commandList, running, allTerminals, projectId])
  const activeIndex = active.key === pickerKey ? Math.min(active.index, Math.max(0, results.length - 1)) : 0

  // Immagini allegate.
  const [images, setImages] = useState<PendingImage[]>([])
  const imageCount = useRef(0)
  imageCount.current = images.length
  const [notice, setNotice] = useState<string | null>(null)
  // Screenshot dal browser integrato: finiscono qui come le immagini incollate, anche se arrivano a composer smontato.
  const queuedImages = useApp((s) => s.composerAttachments[draftKey])
  useEffect(() => {
    if (!queuedImages?.length) return
    const { images: added, error } = acceptAttachments(useApp.getState().takeComposerAttachments(draftKey), imageCount.current)
    if (added.length) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES))
    setNotice(error)
  }, [queuedImages, draftKey])
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
    if (pickerOpen && mode === 'mention' && projectId) refreshProjectFiles(projectId)
  }, [pickerOpen, mode, projectId])

  // Una @ (o una /) cancellata e riscritta nello stesso punto riapre il selettore.
  useEffect(() => {
    if (!trigger && dismissed !== null) setDismissed(null)
  }, [trigger, dismissed])

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
  const anchor = pickerOpen ? trigger.start : null
  useLayoutEffect(() => {
    const el = textarea.current
    const container = box.current
    if (anchor === null || !el || !container) {
      setPickerStyle(null)
      return
    }
    const point = caretCoordinates(el, anchor)
    const width = Math.min(mode === 'command' ? 560 : 460, container.clientWidth - 12)
    const top = el.offsetTop + Math.min(Math.max(point.top, 0), el.clientHeight - point.height)
    const left = Math.min(Math.max(el.offsetLeft + point.left - 12, 6), container.clientWidth - width - 6)
    setPickerStyle({ left, width, bottom: container.clientHeight - top + 6 })
  }, [anchor, mode, text, images.length])

  // La bozza si salva 500 ms dopo l'ultima battuta e sopravvive al riavvio.
  const updateText = (value: string) => {
    setText(value)
    setDraft(draftKey, value)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => send({ type: 'draft.set', key: draftKey, text: latestText.current }), 500)
  }

  const syncCaret = () => {
    const el = textarea.current
    if (!el) return
    carets.set(draftKey, [el.selectionStart, el.selectionEnd])
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const insertMention = (option: PickerOption) => {
    if (option.kind === 'command') return
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

  /** Azzera testo e bozza subito: se il comando cambia sessione, lo smontaggio non deve risalvare "/comando". */
  const clearDraft = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    latestText.current = ''
    setText('')
    setDraft(draftKey, '')
    send({ type: 'draft.set', key: draftKey, text: '' })
  }

  const openModelMenu = () => {
    menuFromCommand.current = true
    setMenuOpen(true)
  }

  /** Tab: scrive "/nome " al posto del primo token e lascia gli argomenti dove sono. */
  const completeCommand = (entry: CommandEntry) => {
    if (!slash) return
    const token = `/${entry.name}`
    const after = text.slice(slash.end)
    pendingCaret.current = token.length + 1
    updateText(token + (/^\s/.test(after) ? '' : ' ') + after)
  }

  /** Esegue un comando: quelli di Ladder qui, quelli dell'agente con onCommand. Il testo si svuota solo se è partito (per l'agente, se la richiesta all'host riesce). */
  const runCommand = (entry: CommandEntry, args: string) => {
    if (!isLadderCommand(entry)) {
      if (running) {
        setNotice(t('/{name} can run once the current turn finishes.', { name: entry.name }))
        return
      }
      if (commandPending.current) return // un secondo Invio mentre la richiesta è in attesa non fa niente
      setNotice(null)
      const sent = latestText.current
      commandPending.current = true
      setCommandPending(true)
      void Promise.resolve(onCommand?.(entry.name, args))
        .then(
          () => {
            if (mounted.current) {
              // Se nel frattempo l'utente ha scritto altro, non si cancella il suo testo.
              if (latestText.current === sent) clearDraft()
            } else if (useApp.getState().drafts[draftKey] === sent) {
              // Composer smontato (altra sessione): niente setText, e si svuota la bozza salvata solo se è ancora quella del comando.
              setDraft(draftKey, '')
              send({ type: 'draft.set', key: draftKey, text: '' })
            }
          },
          () => undefined // l'errore lo mostra chi ha passato onCommand; il testo resta
        )
        .finally(() => {
          commandPending.current = false
          setCommandPending(false)
        })
      return
    }
    if (entry.name === 'new') {
      setNotice(null)
      clearDraft()
      onNewSession?.(args)
      return
    }
    if (entry.name === 'model') {
      if (args) {
        const found = findModel(models, args)
        if (!found) {
          setNotice(models.length ? t('No model matches “{name}”. Available: {models}.', { name: args, models: models.map((m) => m.label).join(', ') }) : t('The model list is not available yet.'))
          return
        }
        onModelChange(found.id)
      } else openModelMenu()
    } else if (args) {
      const q = args.toLowerCase()
      const found = effortLevels.find((id) => id === q || t(EFFORTS.find((e) => e.id === id)?.label ?? '').toLowerCase() === q || (EFFORTS.find((e) => e.id === id)?.label ?? '').toLowerCase() === q)
      if (!found) {
        setNotice(t('No effort level matches “{name}”. Available: {levels}.', { name: args, levels: effortLevels.map((id) => t(EFFORTS.find((e) => e.id === id)?.label ?? id)).join(', ') }))
        return
      }
      onEffortChange(found)
    } else openModelMenu()
    setNotice(null)
    clearDraft()
  }

  /** Clic o Invio su una riga: i comandi dell'agente con hint e senza argomenti già scritti si completano, gli altri partono. */
  const chooseOption = (option: PickerOption) => {
    if (option.kind !== 'command') return insertMention(option)
    const args = slash ? argsAfterToken(text, slash) : ''
    if (option.entry.hint && !args && !isLadderCommand(option.entry) && !option.disabled) completeCommand(option.entry)
    else runCommand(option.entry, args)
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

  const canSend = !disabled && !sendingCommand && (text.trim().length > 0 || images.length > 0)
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
      body = body.split(token).join(t('the terminal “{title}” (output below)', { title }))
      blocks.push(`${t('Output of the terminal “{title}” (last lines):', { title })}\n\n\`\`\`text\n${output}\n\`\`\``)
    }
    return blocks.length ? `${body}\n\n${blocks.join('\n\n')}` : body
  }

  const sendKey = useSendKey()
  const sendCombo = sendKeyCombos(sendKey).send
  const altCombo = altSendCombo(sendKey)
  // Durante un turno il tasto di invio fa ciò che dice AppPrefs.busySend; con ⌥ l'altra azione.
  const prefBusy = useApp((s) => s.prefs?.busySend ?? 'steer')
  const otherBusy: BusyAction = prefBusy === 'steer' ? 'queue' : 'steer'
  const mainBusy = resolveBusy(prefBusy, canSteer)
  // Se "inserisci" non è possibile le due azioni coincidono: il suggerimento mostra solo la coda.
  const altBusy = resolveBusy(otherBusy, canSteer)
  const busyLabel = (action: BusyAction) => (action === 'steer' ? t('Send into turn') : t('Queue'))
  const sendLabel = running ? busyLabel(mainBusy) : t('Send')
  const submit = (alt = false) => {
    if (!canSend || commandPending.current) return
    // Un testo che inizia con "/nome" noto è un comando; un "/" sconosciuto parte come messaggio normale.
    const parsed = images.length === 0 ? parseSlash(text, commandList) : null
    if (parsed) {
      runCommand(parsed.entry, parsed.args)
      return
    }
    const value = text.trim() || imagePlaceholder(images.length)
    const attachments = images.map(toAttachment)
    updateText('')
    setImages([])
    setNotice(null)
    const busy = running ? resolveBusy(alt ? otherBusy : prefBusy, canSteer) : undefined
    void expandTerminals(value).then((expanded) => onSubmit(expanded, attachments, busy))
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

  // Bozza sostituita da fuori (profilo di sessione, ⌘⇧N): chi chiede ha già scritto store e host. Il testo entra qui senza rimontare, così allegati e cursore restano.
  const replaceRequest = useApp((s) => (s.composerReplace?.key === draftKey ? s.composerReplace : null))
  const handledReplace = useRef(replaceRequest?.nonce ?? 0)
  useEffect(() => {
    if (!replaceRequest || replaceRequest.nonce === handledReplace.current) return
    handledReplace.current = replaceRequest.nonce
    // Stesso testo: React non ridisegna e il cursore in attesa resterebbe addosso alla prossima modifica.
    if (replaceRequest.text === latestText.current) return
    // Un salvataggio in sospeso porterebbe all'host il testo vecchio.
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    latestText.current = replaceRequest.text
    pendingCaret.current = replaceRequest.text.length
    setText(replaceRequest.text)
  }, [replaceRequest])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return // accenti e tasti morti: non intercettare durante la composizione
    if (pickerOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(trigger.start)
        return
      }
      if (results.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive({ key: pickerKey, index: (activeIndex + step + results.length) % results.length })
          return
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          event.preventDefault()
          const option = results[activeIndex]
          if (option.kind === 'command' && event.key === 'Tab') completeCommand(option.entry)
          else chooseOption(option)
          return
        }
      }
    }
    // ⇧Tab cicla i livelli di permesso, come nel CLI di Claude Code.
    if (matchesCommand(event, 'composer.cyclePermission')) {
      event.preventDefault()
      const index = levels.indexOf(permissionNext ?? permission)
      onPermissionChange(levels[(index + 1) % levels.length])
      return
    }
    if (running && isAltSendKey(event, sendKey)) {
      event.preventDefault()
      submit(true)
      return
    }
    if (isSendKey(event, sendKey)) {
      event.preventDefault()
      submit()
      return
    }
    if (matchesCommand(event, 'composer.stop') && running && onStop && idle) {
      event.preventDefault()
      onStop()
    }
  }

  const contextRatio = context && context.window > 0 ? Math.min(1, context.used / context.window) : null
  // Con la soglia di compattazione nota il colore la segue (attenzione da 90% della soglia); senza, resta 80% della finestra.
  const compactAt = context?.compactAt && context.compactAt > 0 ? context.compactAt : null
  const contextWarn = contextRatio !== null && context && (compactAt ? context.used >= compactAt * 0.9 : contextRatio > 0.8)

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      <UsageBanner agent={agent} profileId={props.profileId} />
      {queue.length > 0 && <QueueList queue={queue} onQueueChange={onQueueChange} canSteer={canSteer} onDeliver={onDeliver} reason={queueReason} working={queueWorking} onEditEnd={() => textarea.current?.focus()} />}

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
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/70 bg-composer/90 text-sm font-medium text-primary">
            <ImagePlus aria-hidden className="size-4" strokeWidth={1.8} />
            {t('Drop to attach images')}
          </div>
        )}
        {images.length > 0 && <AttachmentStrip images={images} onRemove={(id) => setImages((current) => current.filter((i) => i.id !== id))} />}
        {notice && (
          <p role="alert" className="px-4 pt-2 text-xs text-destructive">
            {notice}
          </p>
        )}
        <label htmlFor={`composer-${draftKey}`} className="sr-only">
          {t('Message to {agent}', { agent: agentName })}
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
          placeholder={
            disabledReason ??
            (running
              ? mainBusy === 'steer'
                ? t('Type to send a message into the turn in progress')
                : t('Type to queue a message for the end of the turn')
              : sendKey === 'mod-enter'
                ? t('Ask {agent}. @ to mention a file, / for commands, {key} to send', { agent: agentName, key: sendCombo })
                : t('Ask {agent}. @ to mention a file, / for commands', { agent: agentName }))
          }
          className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <IconButton icon={Plus} label={t('Attach images')} onClick={() => !disabled && fileInput.current?.click()} />
          <IconButton icon={AtSign} label={t('Mention a file')} shortcut="@" onClick={startMention} />
          {!compact && <UsageButton agent={agent} profileId={props.profileId} />}
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

          {props.sessionId && props.subagentCounts && props.subagentCounts.total > 0 && (
            <AgentBadge sessionId={props.sessionId} counts={props.subagentCounts} agent={agent} model={model} compact={compact} />
          )}

          {contextRatio !== null && (
            <Tooltip>
              <TooltipTrigger
                aria-label={t('Context used: {percent}%', { percent: Math.round(contextRatio * 100) })}
                className="no-drag mr-1 inline-flex items-center gap-1.5 rounded px-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span
                  className="block size-3 rounded-full"
                  style={{
                    background: `conic-gradient(var(${contextWarn ? '--attention' : '--muted-foreground'}) 0 ${contextRatio * 100}%, var(--input) ${contextRatio * 100}% 100%)`
                  }}
                />
                <span className={cn(contextWarn && 'text-attention')}>{Math.round(contextRatio * 100)}%</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('{used} of {window} tokens', { used: formatTokens(context!.used), window: formatTokens(context!.window) })}
                {compactAt || context!.compactAt === null ? ' · ' : ''}
                {compactAt ? t('compacts automatically at {at}', { at: formatTokens(compactAt) }) : context!.compactAt === null ? t('auto-compact off') : null}
              </TooltipContent>
            </Tooltip>
          )}

          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open)
              // Aperto con /model o /effort: chiudendo si torna a scrivere.
              if (!open && menuFromCommand.current) {
                menuFromCommand.current = false
                window.requestAnimationFrame(() => textarea.current?.focus())
              }
            }}
          >
            <DropdownMenuTrigger className={chip} disabled={disabled}>
              <AgentMark agent={agent} size={13} className="text-foreground" />
              {compact ? <span className="sr-only">{agentName}</span> : <span className="font-semibold text-foreground">{agentName}</span>}
              <span className={cn('min-w-0 truncate text-muted-foreground', compact && 'max-w-24')}>{compact ? modelName : `· ${modelName}`}</span>
              {!compact && shownEffort && showEffort && <span className="text-muted-foreground">· {t(EFFORTS.find((e) => e.id === shownEffort)?.label ?? '').toLowerCase()}</span>}
              <ChevronDown className="size-3 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="max-h-[60vh] w-80">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('Model')}</DropdownMenuLabel>
                {models.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('The list appears after {agent} starts for the first time.', { agent: agentName })}</p>}
                <DropdownMenuRadioGroup value={shownModel ?? ''} onValueChange={(value) => onModelChange(String(value))}>
                  {models.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      <span className="min-w-0 truncate">{m.label}</span>
                      {m.id === defaultModel.value && <DefaultBadge source={defaultModel.source} agentName={agentName} />}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {model && defaultModel.value && model !== defaultModel.value && onModelReset && (
                  <DropdownMenuItem onClick={() => onModelReset(defaultModel.value!)} className="text-muted-foreground">
                    <RotateCcw aria-hidden className="size-3.5" />
                    {t('Reset to default')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              {showEffort && effortLevels.length > 0 && <DropdownMenuSeparator />}
              {showEffort && effortLevels.length > 0 && <EffortSlider levels={effortLevels} value={shownEffort} chosen={Boolean(effort)} defaultLevel={defaultEffort.value} defaultSource={defaultEffort.source} agentName={agentName} onChange={onEffortChange} onReset={effort && defaultEffort.value && effort !== defaultEffort.value && onEffortReset ? () => onEffortReset(defaultEffort.value!) : undefined} />}
              {running && <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t('Changes apply from the next message.')}</p>}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              className={chip}
              aria-label={
                permissionNext
                  ? `${t('Permissions: {level}', { level: levelLabel(level.id) })}. ${t('{level} from next turn', { level: levelLabel(permissionNext) })}`
                  : t('Permissions: {level}', { level: levelLabel(level.id) })
              }
              disabled={disabled}
            >
              <ShieldCheck className="size-3.5 text-muted-foreground" />
              {compact ? null : levelLabel(level.id)}
              {permissionNext ? (
                compact ? (
                  <Clock aria-hidden className="size-3 text-attention" />
                ) : (
                  <span className="text-muted-foreground">→ {levelLabel(permissionNext)}</span>
                )
              ) : null}
              <ChevronDown className="size-3 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="w-80">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('Permissions · ⇧Tab to switch')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={permission} onValueChange={(value) => onPermissionChange(value as PermissionLevel)}>
                  {permissionLevels.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!levels.includes(p.id)} className="items-start py-1.5">
                      <span className="flex flex-col">
                        <span className="font-medium">{levelLabel(p.id)}</span>
                        <span className="text-xs text-muted-foreground">{levels.includes(p.id) ? levelHint(p.id) : t('Not allowed by .ladder/settings.toml')}</span>
                        <span className="font-mono text-xs text-faint">{agentName}: {levelNative(p.id, agent)}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              {permissionNext && <p className="px-2 pt-1 pb-1.5 text-xs text-attention">{t('{level} from next turn', { level: levelLabel(permissionNext) })}</p>}
            </DropdownMenuContent>
          </DropdownMenu>

          {running && idle && onStop ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={t('Stop')}
                onClick={onStop}
                className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-secondary text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Square className="size-3 fill-current" />
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('Stop')} <span className="ml-1 font-mono text-xs opacity-70">{shortcutLabel('session.interrupt')}</span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                aria-label={sendLabel}
                disabled={!canSend}
                onClick={() => submit()}
                className="no-drag ml-1 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-faint"
              >
                <ArrowUp className="size-4" strokeWidth={2.2} />
              </TooltipTrigger>
              <TooltipContent side="top">
                {sendLabel} <Kbd className="ml-1 opacity-70">{sendCombo}</Kbd>
                {running && altBusy !== mainBusy ? (
                  <span className="mt-0.5 block opacity-80">
                    {busyLabel(altBusy)} <Kbd className="ml-1 opacity-70">{altCombo}</Kbd>
                  </span>
                ) : null}
              </TooltipContent>
            </Tooltip>
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
            mode={mode}
            query={trigger.query}
            style={pickerStyle}
            onHover={(index) => setActive({ key: pickerKey, index })}
            onChoose={chooseOption}
          />
        )}
      </div>
    </div>
  )
}
