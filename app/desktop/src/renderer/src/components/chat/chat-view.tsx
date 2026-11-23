// Conversazione di una sessione: lista virtualizzata di turni, segue il fondo mentre l'agente scrive,
// ricorda la posizione di lettura e mostra "In fondo" quando sei più su.
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
import { chatColumn, createTurnCache, estimateTurnHeight, groupTurns, type Turn } from './turns'

/** Posizione di lettura: elemento in cima alla vista e quanti pixel ne sono già passati sopra il bordo. */
export interface ChatAnchor {
  itemId: string
  offset: number
}

export interface ChatViewProps {
  sessionId: string
  /** Ordinati per seq. L'ultimo messaggio dell'agente può cambiare circa 30 volte al secondo. */
  items: ChatItem[]
  run: RunState
  /** Attività corrente mentre lavora: "Esegue pnpm test". */
  activity: string | null
  /** Il divisore "Nuovo" va prima del primo elemento con seq >= di questo. */
  firstUnreadSeq: number | null
  /** null: parte dal fondo. */
  initialAnchor: ChatAnchor | null
  /**
   * Con debounce di 300 ms e un ultimo invio allo smontaggio. Se eri in fondo l'ancora è l'elemento in cima
   * alla vista: alla riapertura ritrovi lo stesso punto e, se nel frattempo non è arrivato altro, il fondo.
   */
  onAnchorChange: (anchor: ChatAnchor) => void
  onRespond: (requestId: string, response: RequestResponse) => void
  onOpenFile: (path: string, line?: number, external?: boolean) => void
  onOpenDiff?: (turnId: string, path?: string) => void
  /** Elemento da raggiungere (⌘⇧A, notifica, ricerca): la vista ci scorre e mette il focus sulla sua prima azione. */
  focusRequest?: { itemId: string | null; nonce: number } | null
  onFocusDone?: (nonce: number) => void
  /** Colonna stretta: margini ridotti e card degli strumenti chiuse (restano apribili con un clic). */
  compact?: boolean
  /** Sotto-agenti in background ancora al lavoro con il coordinatore fermo: sotto l'ultimo turno compare "Waiting for N background agents". */
  waitingAgents?: number
  /** "Continue" sulla riga dei sotto-agenti finiti: invia session.continue. Rifiuta con il messaggio d'errore dell'host. */
  onContinue?: (itemId: string) => Promise<unknown>
  /** Mette del testo nel composer senza inviarlo. */
  onPrefill?: (text: string) => void
  /** Colonna attiva (default: sì). Una colonna non attiva non porta via il focus a chi sta scrivendo altrove. */
  active?: boolean
}

const PADDING_START = 20
const PADDING_END = 28
/** Spazio sotto l'ultimo turno per la riga "in attesa di N agenti" (22 px). */
const WAITING_ROW = 22
const AT_END_PX = 8
const JUMP_PX = 240
const ANCHOR_DEBOUNCE_MS = 300

/** Lo stato interno (sezioni aperte, misure, ancora) riparte da zero a ogni cambio di sessione. */
export function ChatView(props: ChatViewProps) {
  return <ChatViewInner key={props.sessionId} {...props} />
}

/** Elemento in cima alla vista e quanti pixel ne sono già passati sopra il bordo. */
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
  return turns.findIndex((t) => t.id === item.turnId)
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

  // Le sezioni aperte non dipendono da `compact`: l'archivio resta lo stesso quando la colonna cambia larghezza.
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
  // Passando alla vista compatta le card degli strumenti si chiudono.
  useEffect(() => {
    if (compact) toggles.closeAll(['tool:', 'out:'])
  }, [compact, toggles])

  const chatFont = useApp((s) => s.prefs?.chatFont) ?? DEFAULT_CHAT_FONT
  const chatWidth = useApp((s) => s.prefs?.chatWidth) ?? DEFAULT_CHAT_WIDTH
  const chatSize = useApp((s) => s.prefs?.chatTextSize) ?? DEFAULT_TEXT_SIZE
  // Colonna di testo effettiva (caratteri per riga): si misura in modo sincrono al primo layout e poi a ogni resize,
  // ma lo stato cambia solo se cambiano chars, userChars o line, non a ogni pixel di una finestra più larga del limite.
  const [column, setColumn] = useState(() => chatColumn(chatFont, chatWidth, 0, compact, chatSize))
  const [measured, setMeasured] = useState(false)
  // Ultima posizione di lettura vista PRIMA di un eventuale cambio di layout: si aggiorna a ogni scroll, a ogni resize e a ogni
  // passo del ripristino. Al cambio di larghezza o font non si rilegge il DOM (che a quel punto è già quello nuovo).
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

  // Chiavi e stime cambiano solo quando cambia la sequenza dei turni (non a ogni pezzo di streaming) o la colonna.
  // `column` è anche tra le dipendenze di getItemKey: virtual-core ricalcola le misure solo quando cambiano le sue opzioni
  // (estimateSize non conta), e così gli elementi non ancora misurati prendono la stima nuova senza perdere quelli misurati.
  const idsKey = useMemo(() => turns.map((t) => t.id).join('\u0001'), [turns])
  const getItemKey = useCallback((index: number) => turnsRef.current[index]?.id ?? index, [idsKey, column])
  const estimateSize = useCallback(
    (index: number) => (turnsRef.current[index] ? estimateTurnHeight(turnsRef.current[index], column) : 120),
    [idsKey, column]
  )

  // La riga "in attesa" compare con gli agenti al lavoro e sparisce da sé quando finiscono o parte un turno (run non più idle).
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

  // Ancora di lettura, con debounce e un ultimo invio allo smontaggio.
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

  // Cambio di larghezza o di font a metà lettura: le altezze cambiano, la posizione di lettura no. Si prende l'ancora
  // prima che il DOM cambi (durante il render, dove ancora c'è il layout vecchio) e la si ritrova dopo, rifinita sulle misure reali.
  const layoutKey = `${chatFont}|${chatWidth}|${chatSize}`
  const layoutKeyRef = useRef(layoutKey)
  const pendingRef = useRef<{ anchor: ChatAnchor | null; end: boolean } | null>(null)
  // Di norma l'ancora è già stata presa dall'evento (useChatFont lo manda prima di cambiare il layout); questo è il ripiego.
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
      // In fondo si resta in fondo, finché le misure delle righe non smettono di cambiare l'altezza totale.
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

  // Posizione iniziale: il fondo, oppure l'ancora salvata (rifinita sugli elementi reali per qualche frame).
  const positionedRef = useRef(false)
  useLayoutEffect(() => {
    // Si parte a larghezza misurata: stime e posizione iniziale usano la colonna reale.
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
      // In StrictMode l'effetto riparte subito: il ripristino deve poter ricominciare.
      positionedRef.current = false
    }
    // Solo alla prima comparsa degli elementi.
  }, [turns.length > 0 && measured])

  // Quando l'utente invia un messaggio si torna in fondo, anche se stava leggendo più su.
  const lastUserIdRef = useRef<string | null>(null)
  const lastUserId = useMemo(() => {
    // Vale anche un messaggio inserito nel turno (steered): l'ultimo 'user' di tutti, nei passi o in testa.
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

  // Se la vista cambia altezza (finestra, composer che cresce) e eri in fondo, resti in fondo.
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

  // Elemento richiesto da fuori: si scorre al suo turno, poi all'elemento, e il focus va sulla prima azione.
  const hasTurns = turns.length > 0
  useEffect(() => {
    const target = focusRequest
    if (!target || !hasTurns) return
    const list = turnsRef.current
    const lastOpen = list[list.length - 1]?.open.at(-1)?.id ?? null
    const itemId = target.itemId ?? lastOpen
    const index = itemId ? turnIndexOfItem(list, itemsRef.current, itemId) : -1
    // Ferma il ripristino della posizione di lettura: adesso conta l'elemento.
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

  // Turno in corso e divisore "Nuovo".
  const lastTurn = turns[turns.length - 1]
  const liveIndex =
    lastTurn && !lastTurn.end && (run === 'running' || run === 'starting' || run === 'waiting') ? turns.length - 1 : -1
  const unread = useMemo(() => {
    if (firstUnreadSeq === null) return null
    const item = items.find((i) => i.seq >= firstUnreadSeq)
    return item ? { itemId: item.id, turnId: item.turnId } : null
  }, [items, firstUnreadSeq])

  const openRequest = lastTurn?.open[lastTurn.open.length - 1] ?? null
  const announcement = openRequest
    ? openRequest.requestType === 'question'
      ? t('Question from the agent: {question}', { question: openRequest.questions?.[0]?.question ?? openRequest.title })
      : t('Approval requested: {target}', { target: openRequest.command ?? openRequest.path ?? openRequest.title })
    : ''

  // Seq dell'ultima riga di avvio "dopo la fine degli agenti": le righe "picked up" che la precedono sarebbero un doppione.
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

        {/* Il testo sfuma sotto l'intestazione invece di finirci contro: un velo del colore del fondo, non una linea.
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
