// A session's conversation: virtualized list of turns, follows the bottom while the agent writes,
// remembers the reading position and shows "Jump to bottom" when you are further up.
import './chat.css'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, RequestResponse, RunState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { Spinner } from './bits'
import { ChatContext, createToggleStore, prefersReducedMotion, type ChatActions } from './chat-context'
import { WaitingAgentsLine } from './agents-lines'
import { TurnRow } from './turn-row'
import { useApp } from '@/store/app-store'
import { CHAT_LAYOUT_WILL_CHANGE, DEFAULT_CHAT_FONT, DEFAULT_CHAT_WIDTH, DEFAULT_TEXT_SIZE } from '@/hooks/use-chat-font'
import { chatColumn, createTurnCache, estimateTurnHeight, groupTurns, isAdviceTurn, turnKey, type Turn } from './turns'

/** Reading position: the element at the top of the view and how many pixels of it are already above the edge. */
export interface ChatAnchor {
  itemId: string
  offset: number
}

export interface ChatViewProps {
  sessionId: string
  /** Sorted by seq. The agent's last message can change about 30 times per second. */
  items: ChatItem[]
  run: RunState
  /** Current activity while working: "Running pnpm test". */
  activity: string | null
  /** The "New" divider goes before the first element with seq >= this. */
  firstUnreadSeq: number | null
  /** null: parte dal fondo. */
  initialAnchor: ChatAnchor | null
  /**
   * Debounced by 300 ms with a final send on unmount. If you were at the bottom the anchor is the element at the top
   * of the view: on reopening you find the same spot and, if nothing else arrived in the meantime, the bottom.
   */
  onAnchorChange: (anchor: ChatAnchor) => void
  onRespond: (requestId: string, response: RequestResponse) => void
  onOpenFile: (path: string, line?: number, external?: boolean) => void
  onOpenDiff?: (turnId: string, path?: string) => void
  /** Element to reach (⌘⇧A, notification, search): the view scrolls to it and puts focus on its first action. */
  focusRequest?: { itemId: string | null; nonce: number } | null
  onFocusDone?: (nonce: number) => void
  /** Narrow column: reduced margins and tool cards closed (they can still be opened with a click). */
  compact?: boolean
  /** Background sub-agents still working with the coordinator idle: "Waiting for N background agents" appears below the last turn. */
  waitingAgents?: number
  /** "Continue" on the finished sub-agents row: sends session.continue. Rejects with the host's error message. */
  onContinue?: (itemId: string) => Promise<unknown>
  /** Puts text in the composer without sending it. */
  onPrefill?: (text: string) => void
  /** Active column (default: yes). An inactive column doesn't steal focus from whoever is typing elsewhere. */
  active?: boolean
}

const PADDING_START = 20
const PADDING_END = 28
/** Space below the last turn for the "waiting for N agents" row (22 px). */
const WAITING_ROW = 22
const AT_END_PX = 8
const JUMP_PX = 240
const ANCHOR_DEBOUNCE_MS = 300

/** Internal state (open sections, measurements, anchor) restarts from zero on every session change. */
export function ChatView(props: ChatViewProps) {
  return <ChatViewInner key={props.sessionId} {...props} />
}

/** Element at the top of the view and how many pixels of it are already above the edge. */
function readAnchor(el: HTMLElement | null): ChatAnchor | null {
  if (!el || !el.isConnected) return null
  const top = el.getBoundingClientRect().top
  for (const node of el.querySelectorAll<HTMLElement>('[data-item-id]')) {
    const rect = node.getBoundingClientRect()
    if (rect.height === 0 || rect.bottom <= top + 1) continue
    return { itemId: node.dataset.itemId!, offset: Math.round(top - rect.top) }
  }
  return null
}

function turnIndexOfItem(turns: Turn[], items: ChatItem[], itemId: string) {
  const item = items.find((i) => i.id === itemId)
  if (!item) return -1
  return turns.findIndex((t) => t.id === turnKey(item))
}

function ChatViewInner({
  sessionId,
  items,
  run,
  activity,
  firstUnreadSeq,
  initialAnchor,
  onAnchorChange,
  onRespond,
  onOpenFile,
  onOpenDiff,
  focusRequest,
  onFocusDone,
  compact = false,
  waitingAgents = 0,
  onContinue,
  onPrefill,
  active = true
}: ChatViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const scrollRef = useRef<HTMLDivElement>(null)
  const cacheRef = useRef(createTurnCache())
  const turns = useMemo(() => groupTurns(items, cacheRef.current), [items])
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  const callbacks = useRef({ onAnchorChange, onRespond, onOpenFile, onOpenDiff, onFocusDone, onContinue, onPrefill })
  useLayoutEffect(() => {
    callbacks.current = { onAnchorChange, onRespond, onOpenFile, onOpenDiff, onFocusDone, onContinue, onPrefill }
  })
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Open sections don't depend on `compact`: the archive stays the same when the column changes width.
  const [toggles] = useState(createToggleStore)
  const hasContinue = Boolean(onContinue)
  const hasPrefill = Boolean(onPrefill)
  const actions = useMemo<ChatActions>(
    () => ({
      openFile: (path, line, external) => callbacks.current.onOpenFile(path, line, external),
      openDiff: (turnId, path) => callbacks.current.onOpenDiff?.(turnId, path),
      respond: (requestId, response) => callbacks.current.onRespond(requestId, response),
      canTakeFocus: () => {
        if (!activeRef.current) return false
        const active = document.activeElement
        return !active || active === document.body || Boolean(rootRef.current?.contains(active))
      },
      continueSession: hasContinue ? (itemId) => callbacks.current.onContinue!(itemId) : undefined,
      prefill: hasPrefill ? (text) => callbacks.current.onPrefill!(text) : undefined,
      toggles,
      compact,
      sessionId
    }),
    [toggles, compact, sessionId, hasContinue, hasPrefill]
  )
  // Switching to the compact view closes the tool cards.
  useEffect(() => {
    if (compact) toggles.closeAll(['tool:', 'out:'])
  }, [compact, toggles])

  const chatFont = useApp((s) => s.prefs?.chatFont) ?? DEFAULT_CHAT_FONT
  const chatWidth = useApp((s) => s.prefs?.chatWidth) ?? DEFAULT_CHAT_WIDTH
  const chatSize = useApp((s) => s.prefs?.chatTextSize) ?? DEFAULT_TEXT_SIZE
  // Effective text column (characters per line): measured synchronously at first layout and then on every resize,
  // but the state changes only if chars, userChars or line change, not on every pixel of a window wider than the limit.
  const [column, setColumn] = useState(() => chatColumn(chatFont, chatWidth, 0, compact, chatSize))
  const [measured, setMeasured] = useState(false)
  // Last reading position seen BEFORE any layout change: updated on every scroll, every resize and every
  // restore step. On a width or font change the DOM is not re-read (it is already the new one by then).
  const liveAnchorRef = useRef<ChatAnchor | null>(null)
  const captureAnchor = () => {
    liveAnchorRef.current = readAnchor(scrollRef.current) ?? liveAnchorRef.current
  }
  const columnRef = useRef(column)
  columnRef.current = column
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      captureAnchor()
      const next = chatColumn(chatFont, chatWidth, el.clientWidth, compact, chatSize)
      setColumn((prev) => (prev.chars === next.chars && prev.userChars === next.userChars && prev.line === next.line ? prev : next))
      setMeasured(true)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [chatFont, chatWidth, compact, chatSize])

  // Keys and estimates change only when the sequence of turns changes (not on every streaming chunk) or the column does.
  // `column` is also among the dependencies of getItemKey: virtual-core recomputes measurements only when its options change
  // (estimateSize doesn't count), so unmeasured items get the new estimate without losing the measured ones.
  const idsKey = useMemo(() => turns.map((t) => t.id).join('\u0001'), [turns])
  const getItemKey = useCallback((index: number) => turnsRef.current[index]?.id ?? index, [idsKey, column])
  const estimateSize = useCallback(
    (index: number) => (turnsRef.current[index] ? estimateTurnHeight(turnsRef.current[index], column) : 120),
    [idsKey, column]
  )

  // The "waiting" row appears with agents working and disappears by itself when they finish or a turn starts (run no longer idle).
  const showWaiting = waitingAgents > 0 && run === 'idle' && turns.length > 0
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 3,
    paddingStart: PADDING_START,
    paddingEnd: PADDING_END + (showWaiting ? WAITING_ROW : 0),
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_END_PX,
    initialOffset: () => {
      const list = turnsRef.current
      const index = initialAnchor ? turnIndexOfItem(list, items, initialAnchor.itemId) : -1
      const until = index >= 0 ? index : list.length
      let offset = PADDING_START
      for (let i = 0; i < until; i++) offset += estimateTurnHeight(list[i], columnRef.current)
      return index >= 0 ? offset : offset + PADDING_END
    }
  })

  const atEndRef = useRef(initialAnchor === null)
  const userMovedRef = useRef(false)
  const [showJump, setShowJump] = useState(false)

  // Reading anchor, debounced with a final send on unmount.
  const lastAnchorRef = useRef<string | undefined>(undefined)
  const anchorTimerRef = useRef<number | undefined>(undefined)
  const computeAnchor = useCallback(() => {
    anchorTimerRef.current = undefined
    const anchor = readAnchor(scrollRef.current)
    if (!anchor) return
    const key = `${anchor.itemId}:${anchor.offset}`
    if (key === lastAnchorRef.current) return
    lastAnchorRef.current = key
    callbacks.current.onAnchorChange(anchor)
  }, [])
  const scheduleAnchor = useCallback(() => {
    window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(computeAnchor, ANCHOR_DEBOUNCE_MS)
  }, [computeAnchor])
  useLayoutEffect(
    () => () => {
      if (anchorTimerRef.current !== undefined) {
        window.clearTimeout(anchorTimerRef.current)
        computeAnchor()
      }
    },
    [computeAnchor]
  )

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    atEndRef.current = distance <= AT_END_PX
    setShowJump(distance > JUMP_PX)
    captureAnchor()
    scheduleAnchor()
  }

  const inputSeqRef = useRef(0)
  const markUserMoved = () => {
    userMovedRef.current = true
    inputSeqRef.current++
  }

  // Width or font change mid-reading: heights change, the reading position doesn't. The anchor is taken
  // before the DOM changes (during render, where the old layout is still there) and found again afterwards, refined on the real measurements.
  const layoutKey = `${chatFont}|${chatWidth}|${chatSize}`
  const layoutKeyRef = useRef(layoutKey)
  const pendingRef = useRef<{ anchor: ChatAnchor | null; end: boolean } | null>(null)
  // Normally the anchor was already taken from the event (useChatFont sends it before changing the layout); this is the fallback.
  useLayoutEffect(() => {
    const onWillChange = () => {
      pendingRef.current = { anchor: atEndRef.current ? null : readAnchor(scrollRef.current), end: atEndRef.current }
    }
    window.addEventListener(CHAT_LAYOUT_WILL_CHANGE, onWillChange)
    return () => window.removeEventListener(CHAT_LAYOUT_WILL_CHANGE, onWillChange)
  }, [])
  if (layoutKeyRef.current !== layoutKey) {
    layoutKeyRef.current = layoutKey
    pendingRef.current ??= { anchor: atEndRef.current ? null : liveAnchorRef.current, end: atEndRef.current }
  }
  useLayoutEffect(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    const seq = inputSeqRef.current
    if (pending.end || !pending.anchor) {
      // At the bottom you stay at the bottom, until row measurements stop changing the total height.
      let last = -1
      let calm = 0
      let n = 0
      let id = 0
      const follow = () => {
        const el = scrollRef.current
        if (!el || inputSeqRef.current !== seq) return
        virtualizer.scrollToEnd()
        calm = el.scrollHeight === last ? calm + 1 : 0
        last = el.scrollHeight
        if (++n < 40 && calm < 4) id = requestAnimationFrame(follow)
        else captureAnchor()
      }
      follow()
      return () => cancelAnimationFrame(id)
    }
    const anchor = pending.anchor
    const index = turnIndexOfItem(turnsRef.current, itemsRef.current, anchor.itemId)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' })
    const selector = `[data-item-id="${CSS.escape(anchor.itemId)}"]`
    let frame = 0
    let stable = 0
    let raf = 0
    const tick = () => {
      const el = scrollRef.current
      if (!el || inputSeqRef.current !== seq) return
      const target = el.querySelector<HTMLElement>(selector)
      if (target) {
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top + anchor.offset
        if (Math.abs(delta) > 1) {
          stable = 0
          virtualizer.scrollBy(delta)
        } else stable++
      }
      if (++frame < 40 && stable < 4) raf = requestAnimationFrame(tick)
      else captureAnchor()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [layoutKey, virtualizer])

  // Initial position: the bottom, or the saved anchor (refined on the real elements for a few frames).
  const positionedRef = useRef(false)
  useLayoutEffect(() => {
    // It starts at measured width: estimates and initial position use the real column.
    if (positionedRef.current || turns.length === 0 || !measured) return
    positionedRef.current = true
    const anchor = initialAnchor
    const index = anchor ? turnIndexOfItem(turns, items, anchor.itemId) : -1
    if (!anchor || index < 0) {
      atEndRef.current = true
      virtualizer.scrollToEnd()
      return
    }
    atEndRef.current = false
    virtualizer.scrollToIndex(index, { align: 'start' })
    let frame = 0
    let stable = 0
    let raf = 0
    const selector = `[data-item-id="${CSS.escape(anchor.itemId)}"]`
    const tick = () => {
      const el = scrollRef.current
      if (!el || userMovedRef.current) return
      const target = el.querySelector<HTMLElement>(selector) ?? el.querySelector<HTMLElement>(`[data-index="${index}"]`)
      if (target) {
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top + anchor.offset
        if (Math.abs(delta) > 1) {
          stable = 0
          virtualizer.scrollBy(delta)
        } else stable++
      }
      if (++frame < 40 && stable < 4) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // In StrictMode the effect restarts immediately: the restore must be able to start over.
      positionedRef.current = false
    }
    // Only the first time the elements appear.
  }, [turns.length > 0 && measured])

  // When the user sends a message the view goes back to the bottom, even if they were reading further up.
  const lastUserIdRef = useRef<string | null>(null)
  const lastUserId = useMemo(() => {
    // A message inserted into the turn (steered) counts too: the very last 'user' one, in the steps or at the top.
    for (let i = turns.length - 1; i >= 0; i--) {
      const steps = turns[i].steps
      for (let j = steps.length - 1; j >= 0; j--) if (steps[j].kind === 'user') return steps[j].id
      if (turns[i].user) return turns[i].user!.id
    }
    return null
  }, [turns])
  useEffect(() => {
    const previous = lastUserIdRef.current
    lastUserIdRef.current = lastUserId
    if (previous !== null && lastUserId !== null && previous !== lastUserId && positionedRef.current) {
      atEndRef.current = true
      virtualizer.scrollToEnd()
    }
  }, [lastUserId, virtualizer])

  // If the view changes height (window, growing composer) and you were at the bottom, you stay at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let height = el.clientHeight
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === height) return
      height = el.clientHeight
      if (atEndRef.current) virtualizer.scrollToEnd()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [virtualizer])

  // Element requested from outside: scroll to its turn, then to the element, and focus goes to the first action.
  const hasTurns = turns.length > 0
  useEffect(() => {
    const target = focusRequest
    if (!target || !hasTurns) return
    const list = turnsRef.current
    const lastOpen = list[list.length - 1]?.open.at(-1)?.id ?? null
    const itemId = target.itemId ?? lastOpen
    const index = itemId ? turnIndexOfItem(list, itemsRef.current, itemId) : -1
    // Stops the reading position restore: now the element counts.
    userMovedRef.current = true
    atEndRef.current = index < 0 || index === list.length - 1
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
    else virtualizer.scrollToEnd()
    let frame = 0
    let raf = 0
    const tick = () => {
      const root = scrollRef.current
      const el = itemId && root ? root.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`) : null
      if (el) {
        el.scrollIntoView({ block: 'center' })
        const action = el.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? el.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')
        ;(action ?? el).focus({ preventScroll: true })
        callbacks.current.onFocusDone?.(target.nonce)
        return
      }
      if (++frame < 60) raf = requestAnimationFrame(tick)
      else callbacks.current.onFocusDone?.(target.nonce)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [focusRequest?.nonce, hasTurns, virtualizer])

  const jumpToEnd = () => {
    atEndRef.current = true
    virtualizer.scrollToEnd({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  // Turn in progress and "New" divider.
  // Advice cards also arrive while the session is working: the running turn is the last one that is not a card.
  let lastIndex = turns.length - 1
  while (lastIndex >= 0 && isAdviceTurn(turns[lastIndex])) lastIndex--
  const lastTurn = turns[lastIndex]
  const liveIndex = lastTurn && !lastTurn.end && (run === 'running' || run === 'starting' || run === 'waiting') ? lastIndex : -1
  const unread = useMemo(() => {
    if (firstUnreadSeq === null) return null
    const item = items.find((i) => i.seq >= firstUnreadSeq)
    return item ? { itemId: item.id, turnId: turnKey(item) } : null
  }, [items, firstUnreadSeq])

  const openRequest = lastTurn?.open[lastTurn.open.length - 1] ?? null
  const announcement = openRequest
    ? openRequest.requestType === 'question'
      ? t('Question from the agent: {question}', { question: openRequest.questions?.[0]?.question ?? openRequest.title })
      : t('Approval requested: {target}', { target: openRequest.command ?? openRequest.path ?? openRequest.title })
    : ''

  // Seq of the last start row "after the agents finished": the "picked up" rows before it would be a duplicate.
  const bgStartSeq = useMemo(() => {
    let seq = -1
    for (const item of items) if (item.kind === 'agent-start' && item.reason === 'background-agents' && item.seq > seq) seq = item.seq
    return seq
  }, [items])

  const wasWaitingRef = useRef(false)
  useLayoutEffect(() => {
    if (showWaiting && !wasWaitingRef.current && atEndRef.current) virtualizer.scrollToEnd()
    wasWaitingRef.current = showWaiting
  }, [showWaiting, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <ChatContext.Provider value={actions}>
      <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label={t('Conversation')}
          onScroll={onScroll}
          onWheel={markUserMoved}
          onTouchStart={markUserMoved}
          onKeyDown={markUserMoved}
          onPointerDown={markUserMoved}
          className="chat-scroll relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--ring)_45%,transparent)]"
        >
          {turns.length === 0 && (run === 'starting' || run === 'running') ? (
            <div className="chat-col" data-compact={compact ? '' : undefined}>
              <div className="chat-text">
                <div className="chat-reset flex items-center gap-2 pt-6 text-sm text-muted-foreground">
                  <Spinner />
                  {t('Starting session')}
                </div>
              </div>
            </div>
          ) : null}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((row) => {
              const turn = turns[row.index]
              if (!turn) return null
              const live = row.index === liveIndex
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <TurnRow
                    turn={turn}
                    live={live}
                    run={live ? run : 'idle'}
                    activity={live ? activity : null}
                    dividerBefore={unread && unread.turnId === turn.id ? unread.itemId : null}
                    bgStartSeq={bgStartSeq}
                    last={row.index === lastIndex}
                  />
                </div>
              )
            })}
            {showWaiting ? (
              <div className="chat-col absolute inset-x-0" style={{ bottom: PADDING_END }} data-compact={compact ? '' : undefined}>
                <div className="chat-text">
                  <div className="chat-reset">
                    <WaitingAgentsLine count={waitingAgents} />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Text fades under the header instead of running into it: a veil in the background color, not a line.
            Un velo sopra costa meno di una maschera sul contenitore che scorre. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-background to-transparent" />

        {showJump ? (
          <button
            type="button"
            onClick={jumpToEnd}
            className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_6px_18px_rgb(0_0_0/0.14)] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 dark:shadow-[0_1px_2px_rgb(0_0_0/0.5),0_8px_22px_rgb(0_0_0/0.4)]"
          >
            <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
            {t('Jump to bottom')}
          </button>
        ) : null}

        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    </ChatContext.Provider>
  )
}
