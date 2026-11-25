// Sub-agent graph: a left-to-right tree, the session on the left and the children stacked in a column on the right.
// Links have a single solid color (like the branch map lines): state lives on the cards.
// It lives in the badge popover (agent-map.tsx) and, enlarged with zoom and drag, in a near-fullscreen dialog.
// Tree semantics (tree/treeitem with aria-level); the list remains the complete alternative.
import { Bot, Maximize, Minus, Plus, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { plural, t } from '@shared/i18n'
import type { SubagentInfo } from '@shared/protocol'
import { Spinner } from '@/components/chat/bits'
import { formatDuration } from '@/components/chat/format'
import { formatTokens, StatusMark, useAgentModel } from '@/components/subagent-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/components/chat/chat-context'
import { GRAPH_MAX, layoutAgentGraph, neighbor, NODE_HEIGHT, SESSION_NODE, type GraphLayout, type GraphNode } from '@/lib/agent-graph'
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

/** Link color: solid, the same as the branch map lines. No transparency, which adds up where strokes touch. */
const LINE = 'color-mix(in oklab, var(--muted-foreground) 45%, var(--background))'

const NODE_RING: Record<SubagentInfo['status'], string> = {
  running: 'ring-running/45',
  done: 'ring-border',
  error: 'ring-destructive/45',
  stopped: 'ring-border'
}

interface CanvasProps {
  layout: GraphLayout
  now: number
  modelOf: (a: Pick<SubagentInfo, 'model'>) => string | null
  onOpen: (id: string) => void
  /** When a node has focus: the enlarged view brings it into view. */
  onFocusNode?: (node: GraphNode, element: HTMLElement) => void
}

/** Nodes and links at scale 1: whoever contains it decides scrolling, zoom and dragging. */
const GraphCanvas = memo(function GraphCanvas({ layout, now, modelOf, onOpen, onFocusNode }: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const first = layout.byId.get(SESSION_NODE)?.children[0] ?? SESSION_NODE
  const [active, setActive] = useState(first)
  // A single tab stop: the last node that had focus, if it still exists.
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

  // A click gives focus but must not move the view: the node would move under the pointer and the click would be lost.
  const handleFocus = (node: GraphNode) => (event: FocusEvent<HTMLElement>) => {
    setActive(node.id)
    if (event.currentTarget.matches(':focus-visible')) onFocusNode?.(node, event.currentTarget)
  }

  return (
    <div
      ref={rootRef}
      role="tree"
      aria-label={t('Agent graph')}
      aria-description={t('Left arrow goes to the parent, right arrow to the first child, up and down arrows to siblings, Home and End to the first and last sibling, Enter opens the details')}
      onKeyDown={onKeyDown}
      className="relative text-sm"
      style={{ width: layout.width, height: layout.height }}
    >
      <svg width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0" aria-hidden>
        {layout.edges.map((edge) => (
          <path key={edge.from} d={edge.d} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: LINE }} />
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
  // Second line: type and tokens, only if the model has them; with nothing, the state.
  const second = [agent.kind, agent.tokens != null && t('{tokens} tokens', { tokens: formatTokens(agent.tokens) })].filter(Boolean).join(' · ') || STATUS_TEXT[agent.status]()
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
        <span className="truncate pl-6 text-xs text-muted-foreground tabular-nums">{second}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start gap-0.5 break-words">
        <span className="font-medium">{agent.title}</span>
        {facts && <span className="opacity-80 tabular-nums">{facts}</span>}
        {agent.status === 'running' && agent.activity && <span className="opacity-80">{agent.activity}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** The graph inside the popover: scrolls if needed, never zooms. */
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
  const forest = useMemo(() => buildForest(agents), [agents])
  const layout = useMemo(() => layoutAgentGraph(forest), [forest])
  // A tall tree opens with the session at half height, not at the top among the first children: once, on the first measurement.
  const scroller = useRef<HTMLDivElement>(null)
  const centered = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    const root = layout.byId.get(SESSION_NODE)
    if (!el || !root || centered.current || !el.clientHeight) return
    centered.current = true
    el.scrollTop = root.y + NODE_HEIGHT / 2 - el.clientHeight / 2
  }, [layout])
  return (
    // The graph needs more space than the list: the popover widens until it shows all columns and grows up to 560px tall.
    <div ref={scroller} className="relative max-h-[min(70vh,560px)] min-h-0 overflow-auto overscroll-contain px-1.5 pb-1.5" style={{ width: `min(${layout.width + 12}px, calc(100vw - 2rem), 56rem)`, minWidth: '100%' }}>
      <div className="mx-auto w-fit shrink-0">
        {/* With keyboard focus the node is brought into view by hand: native scrolling is not enough with few nodes. */}
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
/** Below this scale nodes are not readable: the initial framing does not go lower. */
const READABLE_ZOOM = 0.6
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

/** Near-fullscreen dialog: zoom with wheel, trackpad pinch and buttons, dragging, arrows between nodes. */
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
  // When an agent's detail is opened, focus goes to it, not to the badge.
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
  // The panel is in a portal and may mount after this component: a callback ref, and the effects wait for it.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const forest = useMemo(() => buildForest(agents), [agents])
  const layout = useMemo(() => layoutAgentGraph(forest), [forest])

  // The view lives in a ref and is written directly to the transform: dragging and zooming does not re-render the graph.
  // State only holds the scale, for the percentage and the buttons.
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
      // A single limit for every update (drag, wheel, pinch, buttons, keys): at least 80 px of the graph panel,
      // scaled, stay inside the panel, and at least one node is visible. If the graph disappears it is brought back toward the center.
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
        // Not even at the center is a node visible (huge graph and maximum scale): stay where it was.
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
    // Everything in view if the scale stays readable; below the minimum it stops there and the rest is reached by moving the view.
    const k = clampZoom(Math.max(READABLE_ZOOM, Math.min(1, (size.w - 48) / layout.width, (size.h - 48) / layout.height)))
    const root = layout.byId.get(SESSION_NODE)
    const centered = (size.w - layout.width * k) / 2
    // Too wide (many levels): start from the session side, without leaving empty space on one side.
    const x = centered >= 24 ? centered : Math.min(24, Math.max(size.w - layout.width * k - 24, size.w / 2 - ((root?.x ?? 0) + (root?.w ?? 0) / 2) * k))
    // Too tall: start with the session at mid window, so you can see where the branches start; otherwise the graph is centered.
    const cy = (root?.y ?? 0) + NODE_HEIGHT / 2
    const tall = layout.height * k > size.h - 48
    setView({ k, x, y: tall ? Math.min(24, Math.max(size.h - layout.height * k - 24, size.h / 2 - cy * k)) : (size.h - layout.height * k) / 2 })
  }, [size.w, size.h, layout, setView])
  // Everything is framed once, as soon as measurements exist; after that the user decides (or "Fit to view").
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !size.w || !agents.length) return
    fitted.current = true
    fit()
  }, [fit, size.w, agents.length])

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const v = viewRef.current
      const k = clampZoom(v.k * factor)
      setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k })
    },
    [setView]
  )
  const zoomCenter = (factor: number) => zoomAt(factor, size.w / 2, size.h / 2)
  // Only a click on the buttons announces the scale: wheel and pinch change the percentage silently.
  const zoomButton = (factor: number) => {
    zoomCenter(factor)
    setAnnounce(`${Math.round(viewRef.current.k * 100)}%`)
  }

  // The wheel must be able to call preventDefault: React registers it as passive, so it is done by hand.
  useEffect(() => {
    const el = viewport
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch arrives as wheel with ctrl and small deltaY: it goes faster.
        const speed = event.ctrlKey && !event.metaKey ? 0.01 : 0.0025
        zoomAt(Math.exp(-event.deltaY * speed), event.clientX - rect.left, event.clientY - rect.top)
      } else {
        // Wheel or two fingers move the view.
        const v = viewRef.current
        setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewport, zoomAt, setView])

  // Dragging: the pointer is captured only beyond a few pixels, so a click on a node stays a click.
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

  // With the arrows the node that takes focus stays in the window.
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

  // Stable: the graph is not rebuilt on every render of the dialog.
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
        // The panel does not scroll by itself: if the browser does it (focus, selection) it is put back, the view is the transform.
        onScroll={(event) => {
          event.currentTarget.scrollLeft = 0
          event.currentTarget.scrollTop = 0
        }}
        className={cn('relative min-h-0 flex-1 touch-none overflow-hidden border-t border-border/60 select-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
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
