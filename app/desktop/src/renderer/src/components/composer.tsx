import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { matchesCommand, shortcutLabel } from '@shared/shortcuts'
import { ArrowUp, AtSign, Clock, ImagePlus, Plus, ShieldCheck, Square } from 'lucide-react'
import type { AgentId, Attachment, Effort, PermissionLevel, QueuedMessage, SessionSummary, SlashCommand } from '@shared/protocol'
import { t } from '@shared/i18n'
import { formatTokens } from '@/components/subagent-bits'
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
  /** Draft key: session id or `new:<project>`. */
  draftKey: string
  /** Project to take files from for @ citations. */
  projectId: string | null
  agentName: string
  models: { id: string; label: string; efforts?: Effort[]; isDefault?: boolean; defaultEffort?: Effort | null }[]
  /** Explicit choice: null = none, the default applies (Ladder's, then the agent's). */
  model: string | null
  onModelChange: (model: string) => void
  effort: Effort | null
  onEffortChange: (effort: Effort) => void
  /** Effort actually in use when the session hasn't chosen one (SessionSummary.effortEffective). */
  effortEffective?: Effort | null
  permission: PermissionLevel
  /** Requested level that applies from the next turn; the current level stays that of `permission`. */
  permissionNext?: PermissionLevel | null
  onPermissionChange: (permission: PermissionLevel) => void
  /** Advice, review or read-only delegation: the level is fixed to Plan, shown without a selector and without ⇧Tab. */
  permissionLocked?: boolean
  /** A delegate that writes files: it can move between Ask, Edit and Full, not to Plan. */
  noPlan?: boolean
  running?: boolean
  /** The text is never empty: with images only, a placeholder arrives. */
  onSubmit: (text: string, attachments: Attachment[], busy?: BusyAction) => void
  onStop?: () => void
  queue?: QueuedMessage[]
  onQueueChange?: (queue: QueuedMessage[]) => void
  /** The agent accepts messages inside the turn (SessionSummary.canSteer). Without it, "insert into turn" falls back to the queue. */
  canSteer?: boolean
  /** Delivers a queued message now: inside the turn or interrupting it (session.queue.deliver). */
  onDeliver?: (id: string, how: 'steer' | 'now') => void
  /** Why the queue is waiting ("3 agents working"), shown next to "Sends when the turn ends". */
  queueReason?: string | null
  /** The queue starts by itself at the end of a turn only if the session is working; when idle it waits for a new message. Default: running. */
  queueWorking?: boolean
  context?: { used: number; window: number; compactAt?: number | null } | null
  disabledReason?: string | null
  /** Only on open: the composer takes focus and puts the cursor back where you left it. */
  autoFocus?: boolean
  /** The session's agent: says what the permission levels correspond to. */
  agent?: AgentId
  /** The session's profile (account) or the one chosen for the new chat: the usage limits are its own. Absent = default. */
  profileId?: string | null
  /** False for agents that choose reasoning with their own options (ACP). */
  showEffort?: boolean
  /** Commands / declared by the session's agent. Absent in the new chat: only Ladder's remain. */
  commands?: SlashCommand[]
  /** Runs an agent command ('session.command' request). Errors are shown by whoever implements it. */
  /** If it returns a promise, the text is cleared only when it resolves; if it rejects it stays where it is. */
  onCommand?: (name: string, args: string) => Promise<unknown> | void
  /** /new: opens a new session in the project, with the arguments as starting text. Without it, /new doesn't appear. */
  onNewSession?: (args: string) => void
  /** /handoff [agent] [note]: opens "Hand off to…" or, with a recognized agent, starts the handoff. */
  onHandoff?: (args: string) => void
  /** /plan <goal>: asks the agent for an executable plan (propose_plan). */
  onPlan?: (goal: string) => Promise<void> | void
  /** /advisor <agent> [question] and /committee [question]: ask for advice even while the session works. Without it, the commands do not appear. */
  onAdvice?: (mode: 'advisor' | 'committee', args: string) => void
  /** Livello massimo ammesso dal progetto ([agents] permissions_max). */
  maxPermission?: PermissionLevel | null
  /** Session and sub-agents: if there are any, the agents badge appears in the bottom bar. */
  sessionId?: string
  subagentCounts?: SessionSummary['subagentCounts']
  className?: string
}

/** Cursor per draft: going back to a session (⌘[) you resume typing where you were. */
const carets = new Map<string, [number, number]>()

const NO_OPTIONS: PickerOption[] = []

/** Model chosen with /model <text>: exact id or name, then a single name that starts with or contains the text. */
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

/** @terminal token in the text: the title without spaces. */
const terminalToken = (title: string) => `@terminal:${title.trim().replace(/\s+/g, '-') || t('terminal')}`

/*
 * Bar under the text field: the steps follow the column width (container query on the `bar` container),
 * not the window's. Single source of the steps, the bar never wraps and send always stays on the right:
 *   wide   (>= 540 px of content): agent logo, model and effort; permissions in full;
 *   medium (400 to 540 px):          logo and model, permissions with icon and short name;
 *   narrow (< 400 px):               icons only (the abbreviated model stays while it fits, then disappears: it is in the tooltip and aria-label).
 * What disappears from the bar stays in the aria-label and in the picker menu. The thresholds are on the bar content
 * (composer width minus 20 px of padding), i.e. 560 and 420 px of composer.
 */
/** Visible only in the wide step, only from medium up, only in medium; the model (without "Claude") disappears below 320 px of content, where not even a short name fits. Whole strings: Tailwind reads them at build time. */
const showWide = 'hidden @min-[540px]/bar:inline'
const showModel = 'hidden @min-[320px]/bar:inline'
const showFromMedium = 'hidden @min-[400px]/bar:inline'
const showMedium = 'hidden @min-[400px]/bar:inline @min-[540px]/bar:hidden'

/** Short name of the permission level: "Full access" becomes "Full", the others are already short. */
const shortLevelName = (id: PermissionLevel) => (id === 'full' ? t('Full access (short)') : levelLabel(id))
/** Abbreviated model for the narrow steps: without the "Claude" prefix. */
const shortModelName = (name: string) => name.replace(/^claude\s+/i, '')

/** Agent and model picker: a full, compact pill (logo, model, lighter effort). */
const modelPill =
  'no-drag inline-flex h-6 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full bg-secondary px-2 text-xs text-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-60'
/** Permissions picker: ghost, it only gets color on hover or when the menu is open. */
const ghost =
  'no-drag inline-flex h-6 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md px-1.5 text-xs text-muted-foreground outline-none ' +
  'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground disabled:opacity-60'

export function Composer(props: ComposerProps) {
  useShortcutsRevision()
  const { draftKey, projectId, agentName, models, model, onModelChange, effort, onEffortChange, effortEffective, permission, permissionNext, onPermissionChange } = props
  const { running, onSubmit, onStop, queue = [], onQueueChange, canSteer = false, onDeliver, queueReason, queueWorking = running, context, disabledReason, autoFocus, className } = props
  const { agent = 'claude-code', showEffort = true, maxPermission = null, commands: agentCommands, onCommand, onNewSession, onHandoff, onAdvice, onPlan } = props
  const levels = allowedLevels(maxPermission).filter((id) => !(props.noPlan && id === 'plan'))
  const initial = useApp.getState().drafts[draftKey] ?? ''
  const setDraft = useApp((s) => s.setDraft)
  const [text, setText] = useState(initial)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  // Agent command waiting for the host's reply: while it lasts, Enter doesn't fire twice.
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
  // The chosen model says which effort levels exist; without information, all of them.
  // Without a choice the default applies. At creation Ladder's counts (project, then global); then the agent's for the project.
  // An already created session ignores Ladder's defaults: what the agent reports applies.
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
  const effortName = shownEffort && showEffort ? t(EFFORTS.find((e) => e.id === shownEffort)?.label ?? '') : ''
  const agentSummary = t('Agent and model: {summary}', { summary: [agentName, modelName, effortName].filter(Boolean).join(' · ') })
  const permissionSummary = permissionNext
    ? `${t('Permissions: {level}', { level: levelLabel(level.id) })}. ${t('{level} from next turn', { level: levelLabel(permissionNext) })}`
    : t('Permissions: {level}', { level: levelLabel(level.id) })
  const disabled = Boolean(disabledReason)

  // @ citations: cursor position (null if there is a selection) and citation closed with Esc.
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState<{ key: string | null; index: number }>({ key: null, index: 0 })
  const [pickerStyle, setPickerStyle] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const listId = useId()
  const files = useProjectFiles(projectId)
  const allTerminals = useApp((s) => s.terminals)
  const mention = useMemo(() => (caret === null ? null : findMention(text, caret)), [text, caret])
  // Command / at the start of the message: same structure as the citation, never both (one starts with @, the other with /).
  const slash = useMemo(() => (caret === null ? null : findSlash(text, caret)), [text, caret])
  const trigger = mention ?? slash
  const mode = mention ? 'mention' : 'command'
  const commandList = useMemo(
    () => mergeCommands(onCommand ? agentCommands : undefined, { model: true, effort: showEffort, new: Boolean(onNewSession), restart: Boolean(props.sessionId) && (agent === 'claude-code' || agent === 'codex'), handoff: Boolean(onHandoff), advisor: Boolean(onAdvice), committee: Boolean(onAdvice), plan: Boolean(onPlan) }),
    [agentCommands, onCommand, onNewSession, onHandoff, onAdvice, onPlan, showEffort, props.sessionId, agent]
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const menuFromCommand = useRef(false)
  const pickerOpen = trigger !== null && focused && !disabled && trigger.start !== dismissed
  const query = pickerOpen ? trigger.query : null
  const pickerKey = query === null ? null : `${mode}:${query}`
  // Terminals citable with @terminal: they appear when you type "te…" or part of their name.
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
  // Screenshots from the built-in browser: they end up here like pasted images, even if they arrive when the composer is unmounted.
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
      // The saved cursor is read first: focus fires onFocus, which would overwrite it.
      const saved = carets.get(draftKey)
      el.focus()
      if (saved) el.setSelectionRange(Math.min(saved[0], el.value.length), Math.min(saved[1], el.value.length))
      else el.setSelectionRange(el.value.length, el.value.length)
    }
    // Only on open: afterwards, focus is up to the user (or a request's card).
  }, [])

  // When leaving the session the draft is saved immediately, without waiting for the 500 ms.
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

  // An @ (or /) deleted and retyped in the same place reopens the picker.
  useEffect(() => {
    if (!trigger && dismissed !== null) setDismissed(null)
  }, [trigger, dismissed])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // After an insertion the cursor goes right after the inserted text.
  useLayoutEffect(() => {
    const el = textarea.current
    const next = pendingCaret.current
    if (!el || next === null) return
    pendingCaret.current = null
    el.setSelectionRange(next, next)
    setCaret(next)
  }, [text])

  // The picker opens above the @ line, aligned to the character.
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

  // The draft is saved 500 ms after the last keystroke and survives a restart.
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

  /** Clears text and draft immediately: if the command changes session, the unmount must not re-save "/command". */
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

  /** Tab: writes "/name " in place of the first token and leaves the arguments where they are. */
  const completeCommand = (entry: CommandEntry) => {
    if (!slash) return
    const token = `/${entry.name}`
    const after = text.slice(slash.end)
    pendingCaret.current = token.length + 1
    updateText(token + (/^\s/.test(after) ? '' : ' ') + after)
  }

  /** Runs a command: Ladder's here, the agent's with onCommand. The text is cleared only if it started (for the agent, if the request to the host succeeds). */
  const runCommand = (entry: CommandEntry, args: string) => {
    if (!isLadderCommand(entry)) {
      if (running) {
        setNotice(t('/{name} can run once the current turn finishes.', { name: entry.name }))
        return
      }
      if (commandPending.current) return // a second Enter while the request is pending does nothing
      setNotice(null)
      const sent = latestText.current
      commandPending.current = true
      setCommandPending(true)
      void Promise.resolve(onCommand?.(entry.name, args))
        .then(
          () => {
            if (mounted.current) {
              // If the user has typed something else in the meantime, their text is not erased.
              if (latestText.current === sent) clearDraft()
            } else if (useApp.getState().drafts[draftKey] === sent) {
              // Composer unmounted (another session): no setText, and the saved draft is cleared only if it is still the command's.
              setDraft(draftKey, '')
              send({ type: 'draft.set', key: draftKey, text: '' })
            }
          },
          () => undefined // the error is shown by whoever passed onCommand; the text stays
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
    if (entry.name === 'handoff') {
      setNotice(null)
      clearDraft()
      onHandoff?.(args)
      return
    }
    if (entry.name === 'advisor' || entry.name === 'committee') {
      setNotice(null)
      clearDraft()
      onAdvice?.(entry.name, args)
      return
    }
    if (entry.name === 'plan') {
      if (!args.trim()) {
        setNotice(t('Write the goal after the command: /plan <goal>'))
        return
      }
      setNotice(null)
      const typed = latestText.current
      clearDraft()
      // If sending fails the goal comes back, unless something else has been typed in the meantime.
      void Promise.resolve(onPlan?.(args.trim())).catch(() => {
        if (mounted.current && !latestText.current) updateText(typed)
      })
      return
    }
    if (entry.name === 'restart') {
      setNotice(null)
      clearDraft()
      if (props.sessionId) void request({ type: 'session.restartAgent', sessionId: props.sessionId }).catch((e: Error) => setNotice(e.message))
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

  /** Click or Enter on a row: agent commands with a hint and no arguments already typed are completed (and /plan), the others run. */
  const chooseOption = (option: PickerOption) => {
    if (option.kind !== 'command') return insertMention(option)
    const args = slash ? argsAfterToken(text, slash) : ''
    // /plan needs its goal like an agent command needs its arguments: complete it instead of running it empty.
    if (option.entry.hint && !args && (!isLadderCommand(option.entry) || option.entry.name === 'plan') && !option.disabled) completeCommand(option.entry)
    else runCommand(option.entry, args)
  }

  /** @ button: writes an @ at the cursor (with a space before if needed) and opens the picker. */
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
    // Spreadsheet cells arrive as text plus image: the text wins.
    // A file copied from Finder carries its own name as text: the image wins.
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

  /** @terminal:name becomes a reference in the text, and the terminal output goes at the end of the message. */
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
  // During a turn the send key does what AppPrefs.busySend says; with ⌥ the other action.
  const prefBusy = useApp((s) => s.prefs?.busySend ?? 'steer')
  const otherBusy: BusyAction = prefBusy === 'steer' ? 'queue' : 'steer'
  const mainBusy = resolveBusy(prefBusy, canSteer)
  // If "insert" isn't possible the two actions coincide: the hint shows only the queue.
  const altBusy = resolveBusy(otherBusy, canSteer)
  const busyLabel = (action: BusyAction) => (action === 'steer' ? t('Send into turn') : t('Queue'))
  const sendLabel = running ? busyLabel(mainBusy) : t('Send')
  const submit = (alt = false) => {
    if (!canSend || commandPending.current) return
    // A text starting with a known "/name" is a command; an unknown "/" is sent as a normal message.
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

  // Text from "Add to chat" (viewer, terminal): goes at the cursor, or at the end, and focus returns here.
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

  // Draft replaced from outside (session profile, ⌘⇧N): whoever asks has already written store and host. The text enters here without remounting, so attachments and cursor stay.
  const replaceRequest = useApp((s) => (s.composerReplace?.key === draftKey ? s.composerReplace : null))
  const handledReplace = useRef(replaceRequest?.nonce ?? 0)
  useEffect(() => {
    if (!replaceRequest || replaceRequest.nonce === handledReplace.current) return
    handledReplace.current = replaceRequest.nonce
    // Same text: React doesn't redraw and the pending cursor would stick to the next edit.
    if (replaceRequest.text === latestText.current) return
    // A pending save would bring the old text to the host.
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    latestText.current = replaceRequest.text
    pendingCaret.current = replaceRequest.text.length
    setText(replaceRequest.text)
  }, [replaceRequest])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return // accents and dead keys: don't intercept during composition
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
    // ⇧Tab cycles the permission levels, as in the Claude Code CLI.
    if (!props.permissionLocked && matchesCommand(event, 'composer.cyclePermission')) {
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
  // With the compaction threshold known the color follows it (attention from 90% of the threshold); without it, it stays at 80% of the window.
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
        <div className="@container/bar px-2.5 pt-1 pb-2.5">
        <div className="flex h-7 items-center gap-1">
          <IconButton icon={Plus} label={t('Attach images')} className="shrink-0" onClick={() => !disabled && fileInput.current?.click()} />
          <IconButton icon={AtSign} label={t('Mention a file')} shortcut="@" className="shrink-0" onClick={startMention} />
          <UsageButton agent={agent} profileId={props.profileId} />
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
          {/* The right group shrinks (the pickers shorten with ellipses) and the send button, outside the group, always stays visible. What the group clips stays in the tab order (focus brings it into view) and in the picker menu. */}
          <div className="-mx-0.5 -my-1 flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden px-0.5 py-1">
          {props.sessionId && props.subagentCounts && props.subagentCounts.total > 0 && (
            <AgentBadge sessionId={props.sessionId} counts={props.subagentCounts} agent={agent} model={model} />
          )}

          {contextRatio !== null && (
            <Tooltip>
              <TooltipTrigger
                aria-label={t('Context used: {percent}%', { percent: Math.round(contextRatio * 100) })}
                className="no-drag mr-1 inline-flex shrink-0 items-center gap-1.5 rounded px-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span
                  className="block size-3 rounded-full"
                  style={{
                    background: `conic-gradient(var(${contextWarn ? '--attention' : '--muted-foreground'}) 0 ${contextRatio * 100}%, var(--input) ${contextRatio * 100}% 100%)`
                  }}
                />
                <span className={cn(showFromMedium, contextWarn && 'text-attention')}>{Math.round(contextRatio * 100)}%</span>
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
              // Opened with /model or /effort: closing returns to typing.
              if (!open && menuFromCommand.current) {
                menuFromCommand.current = false
                window.requestAnimationFrame(() => textarea.current?.focus())
              }
            }}
          >
            <DropdownMenuTrigger className={modelPill} disabled={disabled} aria-label={agentSummary} title={agentSummary}>
              <AgentMark agent={agent} size={12} className="shrink-0" />
              <span className={cn(showModel, 'min-w-0 truncate font-medium')}>{shortModelName(modelName)}</span>
              {effortName && <span className={cn(showWide, 'text-muted-foreground')}>{effortName}</span>}
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
              </DropdownMenuGroup>
              {showEffort && effortLevels.length > 0 && <DropdownMenuSeparator />}
              {showEffort && effortLevels.length > 0 && <EffortSlider levels={effortLevels} value={shownEffort} chosen={Boolean(effort)} defaultLevel={defaultEffort.value} defaultSource={defaultEffort.source} agentName={agentName} onChange={onEffortChange} />}
              {running && <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t('Changes apply from the next message.')}</p>}
            </DropdownMenuContent>
          </DropdownMenu>

          {props.permissionLocked && (
            <span className={cn(ghost, 'pointer-events-none')} title={t('Fixed by whoever started this session: it works read-only.')}>
              <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
              <span className={showWide}>{levelLabel(permission)}</span>
              <span className={showMedium}>{shortLevelName(permission)}</span>
              <span className="sr-only">{t('Fixed by whoever started this session: it works read-only.')}</span>
            </span>
          )}
          {!props.permissionLocked && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={ghost}
              aria-label={permissionSummary}
              title={permissionSummary}
              disabled={disabled}
            >
              <ShieldCheck className="size-3.5 shrink-0" />
              <span className={showWide}>{levelLabel(level.id)}</span>
              <span className={showMedium}>{shortLevelName(level.id)}</span>
              {permissionNext ? (
                <>
                  <Clock aria-hidden className="size-3 shrink-0 text-attention @min-[540px]/bar:hidden" />
                  <span className={cn(showWide, 'text-muted-foreground')}>→ {levelLabel(permissionNext)}</span>
                </>
              ) : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="w-80">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-2">
                  {t('Permissions')}
                  <span className="ml-auto flex items-center gap-1 font-normal">
                    <Kbd separator="+">{shortcutLabel('composer.cyclePermission').replace('⇥', 'tab')}</Kbd>
                    {t('to switch')}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup value={permission} onValueChange={(value) => onPermissionChange(value as PermissionLevel)}>
                  {permissionLevels.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!levels.includes(p.id)} className="items-start py-1.5">
                      <span className="flex flex-col">
                        <span className="font-medium">{levelLabel(p.id)}</span>
                        <span className="text-xs text-muted-foreground">{levels.includes(p.id) ? levelHint(p.id) : props.noPlan && p.id === 'plan' ? t('Not for a delegate that writes files') : t('Not allowed by .ladder/settings.toml')}</span>
                        <span className="font-mono text-xs text-faint">{agentName}: {levelNative(p.id, agent)}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              {permissionNext && <p className="px-2 pt-1 pb-1.5 text-xs text-attention">{t('{level} from next turn', { level: levelLabel(permissionNext) })}</p>}
            </DropdownMenuContent>
          </DropdownMenu>
          )}
          </div>

          {running && idle && onStop ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={t('Stop')}
                onClick={onStop}
                className="no-drag ml-1 grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
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
                className="no-drag ml-1 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-faint"
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
