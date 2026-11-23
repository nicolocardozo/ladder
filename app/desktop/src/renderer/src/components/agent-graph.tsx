// Grafico dei sotto-agenti: la sessione in cima, un nodo per agente, i figli sui livelli sotto, collegamenti curvi colorati per stato.
// Sta nel popover del badge (agent-map.tsx) e, ingrandito con zoom e trascinamento, in un dialogo quasi a tutto schermo.
// Semantica ad albero (tree/treeitem con aria-level); la lista resta l'alternativa completa.
import { Bot, Maximize, Minus, Plus, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { plural, t } from '@shared/i18n'
import type { SubagentInfo } from '@shared/protocol'
import { Spinner } from '@/components/chat/bits'
import { formatDuration } from '@/components/chat/format'
import { formatTokens, StatusMark, useAgentModel } from '@/components/subagent-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/components/chat/chat-context'
import { GRAPH_MAX, layoutAgentGraph, neighbor, nodeWidth, NODE_HEIGHT, SESSION_NODE, type GraphEdge, type GraphLayout, type GraphNode } from '@/lib/agent-graph'
import { agentElapsed, buildForest, useSubagentList } from '@/lib/subagents'
import type { AgentId } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const STATUS_TEXT: Record<SubagentInfo['status'], () => string> = {
  running: () => t('Running'),
  done: () => t('Completed'),
  error: () => t('Error'),
  stopped: () => t('Stopped')
}

/**
 * Colore e tratto del collegamento per stato: l'in corso e il completato sono pieni, l'errore tratteggiato corto, il fermato lungo.
 * Colori pieni, senza trasparenza: sui temi chiari con l'opacità il verde scendeva a 2,4:1 sul fondo, pieno resta sopra 4,8:1.
 */
const EDGE: Record<SubagentInfo['status'], { className: string; dash?: string }> = {
  running: { className: 'stroke-running' },
  done: { className: 'stroke-success' },
  error: { className: 'stroke-destructive', dash: '2 3' },
  stopped: { className: 'stroke-muted-foreground', dash: '6 4' }
}

const NODE_RING: Record<SubagentInfo['status'], string> = {
  running: 'ring-running/45',
  done: 'ring-border',
  error: 'ring-destructive/45',
  stopped: 'ring-border'
}

/** Il font dei nodi, letto da una sonda invisibile con le stesse classi: la larghezza dei nodi si misura con quello vero. */
function useNodeFont(): [ReactNode, string] {
  const [el, setEl] = useState<HTMLSpanElement | null>(null)
  const [font, setFont] = useState('')
  useLayoutEffect(() => {
    if (!el) return
    let alive = true
    const read = () => {
      if (!alive) return
      const style = getComputedStyle(el)
      setFont(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`)
    }
    read()
    // Il font può arrivare dopo il primo disegno.
    void document.fonts?.ready.then(read)
    return () => {
      alive = false
    }
  }, [el])
  const probe = <span ref={setEl} aria-hidden className="pointer-events-none invisible absolute text-sm" />
  return [probe, font]
}

interface CanvasProps {
  layout: GraphLayout
  now: number
  modelOf: (a: Pick<SubagentInfo, 'model'>) => string | null
  onOpen: (id: string) => void
  /** Con il focus su un nodo: l'ingrandito lo porta in vista. */
  onFocusNode?: (node: GraphNode, element: HTMLElement) => void
}

/** Nodi e collegamenti alla scala 1: chi lo contiene decide scorrimento, zoom e trascinamento. */
const GraphCanvas = memo(function GraphCanvas({ layout, now, modelOf, onOpen, onFocusNode }: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const first = layout.byId.get(SESSION_NODE)?.children[0] ?? SESSION_NODE
  const [active, setActive] = useState(first)
  // Un solo punto di tabulazione: l'ultimo nodo che ha avuto il focus, se c'è ancora.
  const tabId = layout.byId.has(active) ? active : first

  const focusNode = (id: string) => rootRef.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-node]')?.dataset.node
    if (!id) return
    if (event.key === 'Enter' || event.key === ' ') {
      if (id === SESSION_NODE) return
      event.preventDefault()
      onOpen(id)
      return
    }
    const next = neighbor(layout, id, event.key)
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') event.preventDefault()
    if (next) focusNode(next)
  }

  // Il clic dà il focus ma non deve spostare la vista: il nodo si muoverebbe sotto il puntatore e il clic andrebbe perso.
  const handleFocus = (node: GraphNode) => (event: FocusEvent<HTMLElement>) => {
    setActive(node.id)
    if (event.currentTarget.matches(':focus-visible')) onFocusNode?.(node, event.currentTarget)
  }

  return (
    <div
      ref={rootRef}
      role="tree"
      aria-label={t('Agent graph')}
      aria-description={t('Up arrow goes to the parent, down arrow to the first child, left and right arrows to siblings, Home and End to the first and last sibling, Enter opens the details')}
      onKeyDown={onKeyDown}
      className="relative text-sm"
      style={{ width: layout.width, height: layout.height }}
    >
      <svg width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0" aria-hidden>
        {layout.edges.map((edge) => (
          <Edge key={edge.to} edge={edge} />
        ))}
      </svg>
      {layout.nodes.map((node) =>
        node.agent ? (
          <AgentNodeView
            key={node.id}
            node={node}
            agent={node.agent}
            now={now}
            model={modelOf(node.agent)}
            tabIndex={node.id === tabId ? 0 : -1}
            onOpen={() => onOpen(node.id)}
            onFocus={handleFocus(node)}
          />
        ) : (
          <SessionNodeView
            key={node.id}
            node={node}
            count={layout.nodes.length - 1}
            tabIndex={node.id === tabId ? 0 : -1}
            onFocus={handleFocus(node)}
          />
        )
      )}
    </div>
  )
})

function Edge({ edge }: { edge: GraphEdge }) {
  const style = EDGE[edge.status]
  return <path d={edge.d} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeDasharray={style.dash} className={style.className} />
}

const NODE_BOX = 'absolute flex flex-col justify-center rounded-lg bg-muted/60 px-3 text-left outline-none ring-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring'

function SessionNodeView({ node, count, tabIndex, onFocus }: { node: GraphNode; count: number; tabIndex: number; onFocus: (event: FocusEvent<HTMLElement>) => void }) {
  const summary = plural(count, '1 agent', '{n} agents')
  return (
    <div
      role="treeitem"
      data-node={node.id}
      tabIndex={tabIndex}
      aria-level={node.level}
      aria-posinset={1}
      aria-setsize={1}
      aria-label={t('This session, {summary}', { summary })}
      onFocus={onFocus}
      className={cn(NODE_BOX, 'ring-border')}
      style={{ left: node.x, top: node.y, width: node.w, height: NODE_HEIGHT }}
    >
      <span className="flex items-center gap-2">
        <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate font-medium">{t('This session')}</span>
      </span>
      <span className="truncate pl-6 text-xs text-muted-foreground tabular-nums">{summary}</span>
    </div>
  )
}

function AgentNodeView({
  node,
  agent,
  now,
  model,
  tabIndex,
  onOpen,
  onFocus
}: {
  node: GraphNode
  agent: SubagentInfo
  now: number
  model: string | null
  tabIndex: number
  onOpen: () => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
}) {
  const duration = formatDuration(agentElapsed(agent, now))
  const label = [agent.title, agent.kind, STATUS_TEXT[agent.status](), duration].filter(Boolean).join(', ')
  const facts = [agent.kind, model, agent.tokens != null && t('{tokens} tokens', { tokens: formatTokens(agent.tokens) }), agent.toolUses != null && plural(agent.toolUses, '1 tool', '{n} tools'), agent.background && t('background')]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tooltip>
      <TooltipTrigger
        render={<div />}
        role="treeitem"
        data-node={node.id}
        tabIndex={tabIndex}
        aria-level={node.level}
        aria-posinset={node.pos}
        aria-setsize={node.setSize}
        aria-label={label}
        onClick={onOpen}
        onFocus={onFocus}
        className={cn(NODE_BOX, 'cursor-pointer hover:bg-accent', NODE_RING[agent.status])}
        style={{ left: node.x, top: node.y, width: node.w, height: NODE_HEIGHT }}
      >
        <span className="flex items-center gap-2">
          <span className="grid size-4 shrink-0 place-items-center">
            <StatusMark status={agent.status} />
          </span>
          <span className={cn('min-w-0 flex-1 truncate', agent.status === 'running' ? 'text-foreground' : 'text-foreground/85')}>{agent.title}</span>
          <span className="shrink-0 text-xs text-faint tabular-nums">{duration}</span>
        </span>
        <span className="truncate pl-6 text-xs text-muted-foreground">{agent.kind ?? STATUS_TEXT[agent.status]()}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start gap-0.5 break-words">
        <span className="font-medium">{agent.title}</span>
        {facts && <span className="opacity-80 tabular-nums">{facts}</span>}
        {agent.status === 'running' && agent.activity && <span className="opacity-80">{agent.activity}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** Il grafico dentro il popover: scorre se serve, mai zoom. */
export function AgentGraph({
  agents,
  now,
  agent,
  model,
  onOpen
}: {
  agents: SubagentInfo[]
  now: number
  agent: AgentId
  model: string | null
  onOpen: (id: string) => void
}) {
  const modelOf = useAgentModel(agent, model)
  const [probe, font] = useNodeFont()
  const forest = useMemo(() => buildForest(agents), [agents])
  const layout = useMemo(() => layoutAgentGraph(forest, (a) => nodeWidth(a, font)), [forest, font])
  return (
    <div className="relative max-h-[min(60vh,440px)] min-h-0 overflow-auto overscroll-contain px-1.5 pb-1.5">
      {probe}
      <div className="mx-auto w-fit shrink-0">
        {/* Con il focus da tastiera il nodo si porta in vista a mano: lo scorrimento nativo non basta con pochi nodi. */}
        <GraphCanvas layout={layout} now={now} modelOf={modelOf} onOpen={onOpen} onFocusNode={(_, el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })} />
      </div>
    </div>
  )
}

interface View {
  x: number
  y: number
  k: number
}
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2.5
/** Sotto questa scala i nodi non si leggono: l'inquadratura iniziale non scende oltre. */
const READABLE_ZOOM = 0.6
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

/** Dialogo quasi a tutto schermo: zoom con rotella, pinch del trackpad e pulsanti, trascinamento, frecce fra i nodi. */
export function AgentGraphDialog({
  open,
  onOpenChange,
  sessionId,
  agent,
  model,
  onOpenAgent,
  returnFocus
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  agent: AgentId
  model: string | null
  onOpenAgent: (id: string) => void
  returnFocus: () => HTMLElement | null
}) {
  // Aperto il dettaglio di un agente il focus passa a lui, non al badge.
  const leaving = useRef(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <GraphDialogBody
          sessionId={sessionId}
          agent={agent}
          model={model}
          onOpenAgent={(id) => {
            leaving.current = true
            onOpenAgent(id)
          }}
          finalFocus={() => {
            const skip = leaving.current
            leaving.current = false
            const target = returnFocus()
            return skip ? false : target?.isConnected ? target : true
          }}
        />
      )}
    </Dialog>
  )
}

function GraphDialogBody({
  sessionId,
  agent,
  model,
  onOpenAgent,
  finalFocus
}: {
  sessionId: string
  agent: AgentId
  model: string | null
  onOpenAgent: (id: string) => void
  finalFocus: () => boolean | HTMLElement
}) {
  const list = useSubagentList(sessionId, true, 1)
  const total = useApp((s) => s.sessions[sessionId]?.subagentCounts?.total ?? 0)
  const agents = useMemo(() => list ?? [], [list])
  const tooMany = agents.length > GRAPH_MAX
  const running = useMemo(() => agents.filter((a) => a.status === 'running').length, [agents])
  const now = useNow(1000, running > 0)
  const modelOf = useAgentModel(agent, model)
  const [probe, font] = useNodeFont()
  // Il riquadro sta in un portale e può montarsi dopo questo componente: un ref a callback, e gli effetti lo aspettano.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const forest = useMemo(() => buildForest(agents), [agents])
  const layout = useMemo(() => layoutAgentGraph(forest, (a) => nodeWidth(a, font)), [forest, font])

  // La vista vive in un ref e si scrive sul transform direttamente: trascinare e zoomare non rifà il render del grafico.
  // Lo stato tiene solo la scala, per la percentuale e i pulsanti.
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 })
  const [zoom, setZoom] = useState(1)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const paint = (v: View) => {
    if (contentRef.current) contentRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
  }
  const setView = useCallback((next: View) => {
    const { w, h } = sizeRef.current
    const l = layoutRef.current
    let v = next
    if (w && h) {
      // Un solo limite per ogni aggiornamento (trascinamento, rotella, pinch, pulsanti, tasti): almeno 80 px del riquadro del grafico,
      // scalato, restano nel riquadro, e almeno un nodo si vede. Se il grafico sparisce lo si riporta verso il centro.
      const keep = 80
      const clamp = (view: View): View => ({ k: view.k, x: Math.min(w - keep, Math.max(keep - l.width * view.k, view.x)), y: Math.min(h - keep, Math.max(keep - l.height * view.k, view.y)) })
      const edge = 24
      const seen = (view: View) =>
        l.nodes.some((n) => {
          const left = n.x * view.k + view.x
          const top = n.y * view.k + view.y
          return left + n.w * view.k > edge && left < w - edge && top + NODE_HEIGHT * view.k > edge && top < h - edge
        })
      v = clamp(next)
      if (!seen(v)) {
        const center = { k: v.k, x: (w - l.width * v.k) / 2, y: (h - l.height * v.k) / 2 }
        for (const f of [0.25, 0.5, 0.75, 1]) {
          const step = clamp({ k: v.k, x: v.x + (center.x - v.x) * f, y: v.y + (center.y - v.y) * f })
          if (seen(step)) {
            v = step
            break
          }
        }
        // Neanche al centro si vede un nodo (grafico enorme e scala massima): si resta dov'era.
        if (!seen(v)) v = seen(viewRef.current) ? viewRef.current : v
      }
    }
    viewRef.current = v
    paint(v)
    setZoom(v.k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setContent = useCallback((el: HTMLDivElement | null) => {
    contentRef.current = el
    if (el) paint(viewRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [announce, setAnnounce] = useState('')

  useLayoutEffect(() => {
    const el = viewport
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewport])

  const fit = useCallback(() => {
    if (!size.w || !size.h) return
    // Tutto in vista se la scala resta leggibile; sotto il minimo si ferma lì e il resto si raggiunge spostando la vista.
    const k = clampZoom(Math.max(READABLE_ZOOM, Math.min(1, (size.w - 48) / layout.width, (size.h - 48) / layout.height)))
    const root = layout.byId.get(SESSION_NODE)
    const centered = (size.w - layout.width * k) / 2
    // Troppo largo: si parte centrati sulla sessione, senza lasciare vuoto da una parte.
    const x = centered >= 24 ? centered : Math.min(24, Math.max(size.w - layout.width * k - 24, size.w / 2 - ((root?.x ?? 0) + (root?.w ?? 0) / 2) * k))
    setView({ k, x, y: Math.max(24, (size.h - layout.height * k) / 2) })
  }, [size.w, size.h, layout, setView])
  // Si inquadra tutto una volta, appena ci sono le misure; poi decide l'utente (o "Fit to view").
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !size.w || !agents.length || !font) return
    fitted.current = true
    fit()
  }, [fit, size.w, agents.length, font])

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const v = viewRef.current
      const k = clampZoom(v.k * factor)
      setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k })
    },
    [setView]
  )
  const zoomCenter = (factor: number) => zoomAt(factor, size.w / 2, size.h / 2)
  // Solo il clic sui pulsanti annuncia la scala: rotella e pinch cambiano la percentuale in silenzio.
  const zoomButton = (factor: number) => {
    zoomCenter(factor)
    setAnnounce(`${Math.round(viewRef.current.k * 100)}%`)
  }

  // La rotella deve poter chiamare preventDefault: React la registra passiva, quindi a mano.
  useEffect(() => {
    const el = viewport
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        // Il pinch del trackpad arriva come rotella con ctrl e deltaY piccoli: va più veloce.
        const speed = event.ctrlKey && !event.metaKey ? 0.01 : 0.0025
        zoomAt(Math.exp(-event.deltaY * speed), event.clientX - rect.left, event.clientY - rect.top)
      } else {
        // Rotella o due dita spostano la vista.
        const v = viewRef.current
        setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewport, zoomAt, setView])

  // Trascinamento: il pointer si cattura solo oltre qualche pixel, così il clic su un nodo resta un clic.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number; moving: boolean } | null>(null)
  const justDragged = useRef(false)
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, vx: viewRef.current.x, vy: viewRef.current.y, id: event.pointerId, moving: false }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moving) {
      if (Math.hypot(dx, dy) < 4) return
      d.moving = true
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }
    setView({ ...viewRef.current, x: d.vx + dx, y: d.vy + dy })
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    drag.current = null
    if (d.moving) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      justDragged.current = true
      window.setTimeout(() => (justDragged.current = false), 0)
      setDragging(false)
    }
  }

  // Con le frecce il nodo che prende il focus resta nella finestra.
  const reveal = useCallback(
    (node: GraphNode) => {
      const v = viewRef.current
      const margin = 24
      const left = node.x * v.k + v.x
      const top = node.y * v.k + v.y
      const right = left + node.w * v.k
      const bottom = top + NODE_HEIGHT * v.k
      let { x, y } = v
      if (left < margin) x += margin - left
      else if (right > size.w - margin) x -= right - (size.w - margin)
      if (top < margin) y += margin - top
      else if (bottom > size.h - margin) y -= bottom - (size.h - margin)
      if (x !== v.x || y !== v.y) setView({ ...v, x, y })
    },
    [size.w, size.h, setView]
  )

  // Stabile: il grafico non si rifà a ogni render del dialogo.
  const onOpenAgentRef = useRef(onOpenAgent)
  onOpenAgentRef.current = onOpenAgent
  const handleOpen = useCallback((id: string) => {
    if (!justDragged.current) onOpenAgentRef.current(id)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '+' || event.key === '=') zoomCenter(1.25)
    else if (event.key === '-' || event.key === '_') zoomCenter(0.8)
    else if (event.key === '0') fit()
    else return
    event.preventDefault()
  }

  const summary = [plural(agents.length, '1 agent', '{n} agents'), running > 0 && t('{n} running', { n: running })].filter(Boolean).join(' · ')
  return (
    <DialogContent
      showCloseButton={false}
      finalFocus={finalFocus}
      onKeyDown={onKeyDown}
      className="flex h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
    >
      <div className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <DialogTitle className="text-sm leading-none font-semibold">{t('Agent graph')}</DialogTitle>
          <DialogDescription className="text-xs tabular-nums">{summary}</DialogDescription>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={t('Zoom out')} disabled={zoom <= MIN_ZOOM} focusableWhenDisabled onClick={() => zoomButton(0.8)}>
            <Minus aria-hidden />
          </Button>
          <span className="w-10 text-center text-xs text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
          <span role="status" className="sr-only">
            {announce}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={t('Zoom in')} disabled={zoom >= MAX_ZOOM} focusableWhenDisabled onClick={() => zoomButton(1.25)}>
            <Plus aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('Fit to view')} onClick={fit}>
            <Maximize aria-hidden />
          </Button>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t('Close')} />}>
            <X aria-hidden />
          </DialogClose>
        </div>
      </div>

      <div
        ref={setViewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Il riquadro non scorre da solo: se il browser lo fa (focus, selezione) si rimette a posto, la vista è il transform.
        onScroll={(event) => {
          event.currentTarget.scrollLeft = 0
          event.currentTarget.scrollTop = 0
        }}
        className={cn('relative min-h-0 flex-1 touch-none overflow-hidden border-t border-border/60 select-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
        {probe}
        {agents.length === 0 && (list !== undefined || total === 0) ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('No agents yet')}</p>
        ) : list === undefined ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Spinner />
            {t('Loading…')}
          </p>
        ) : tooMany ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('The graph is available up to {n} agents. Use the list.', { n: GRAPH_MAX })}</p>
        ) : (
          <div ref={setContent} className="absolute top-0 left-0 origin-top-left will-change-transform">
            <GraphCanvas layout={layout} now={now} modelOf={modelOf} onOpen={handleOpen} onFocusNode={reveal} />
          </div>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center border-t border-border/60 px-4 text-xs text-muted-foreground">
        {t('Scroll to move, pinch or ⌘ scroll to zoom, arrows between agents, Enter for details')}
      </div>
    </DialogContent>
  )
}
