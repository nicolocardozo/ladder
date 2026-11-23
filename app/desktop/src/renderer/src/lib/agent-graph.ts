// Layout del grafico dei sotto-agenti, calcolato a mano: un livello per profondità, il nodo della sessione in cima,
// ogni livello una sola riga, figli centrati sotto il genitore. Se il grafico è più largo dello spazio, scorre chi lo contiene:
// così i collegamenti vanno solo fra livelli adiacenti e non attraversano mai un nodo. Nessuna libreria.
import type { SubagentInfo } from '@shared/protocol'
import type { AgentNode } from '@/lib/subagents'

/** Id del nodo della sessione, radice del grafico. */
export const SESSION_NODE = '__session__'

/** Fino a questo numero di agenti il grafico è la vista predefinita; oltre c'è la lista. */
export const GRAPH_DEFAULT_MAX = 12
/** Oltre questo numero il grafico non si propone: è illeggibile e la lista è l'alternativa completa. */
export const GRAPH_MAX = 40

export const NODE_HEIGHT = 44
export const NODE_MIN_WIDTH = 124
export const NODE_MAX_WIDTH = 188
export const SESSION_WIDTH = 148
const GAP_X = 10
const GROUP_GAP = 20
const GAP_Y = 40
const PAD = 12
/** Spazio per la durata a destra del titolo (cifre tabulari, "12m 34s"). */
const DURATION_WIDTH = 44
/** Segno di stato, spazi e padding interno del nodo. */
const NODE_CHROME = 16 + 8 + 8 + 24

export interface GraphNode {
  id: string
  /** null per il nodo della sessione. */
  agent: SubagentInfo | null
  x: number
  y: number
  w: number
  /** 1 per il nodo della sessione, poi 2, 3… come aria-level. */
  level: number
  parent: string | null
  children: string[]
  /** Posizione fra i fratelli (da 1) e quanti sono, per aria-posinset e aria-setsize. */
  pos: number
  setSize: number
}

export interface GraphEdge {
  from: string
  to: string
  /** Stato dell'agente a cui porta il collegamento: ne decide il colore. */
  status: SubagentInfo['status']
  /** Curva di Bézier cubica già scritta per un attributo `d`. */
  d: string
}

export interface GraphLayout {
  nodes: GraphNode[]
  byId: Map<string, GraphNode>
  edges: GraphEdge[]
  width: number
  height: number
}

let canvas: CanvasRenderingContext2D | null | undefined
/** Larghezza in pixel di un testo con il font dato (es. "13px Mona Sans"). Senza canvas, una stima. */
export function measureText(text: string, font: string): number {
  if (canvas === undefined) canvas = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!canvas || !font) return text.length * 7
  canvas.font = font
  return canvas.measureText(text).width
}

/** Larghezza di un nodo: titolo misurato, con un minimo e un massimo; il resto del titolo si tronca. */
export function nodeWidth(agent: SubagentInfo, font: string): number {
  const width = NODE_CHROME + measureText(agent.title, font) + DURATION_WIDTH
  return Math.round(Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, width)))
}

interface Slot {
  node: AgentNode | null
  parent: string | null
  id: string
}

/**
 * Posiziona i nodi, una riga per livello.
 * L'ordine dentro un livello è quello della visita in profondità, quindi i fratelli restano vicini e nell'ordine del genitore.
 */
export function layoutAgentGraph(forest: AgentNode[], widthOf: (agent: SubagentInfo) => number): GraphLayout {
  const levels: Slot[][] = [[{ node: null, parent: null, id: SESSION_NODE }]]
  const siblingsOf = new Map<string, AgentNode[]>([[SESSION_NODE, forest]])
  const walk = (list: AgentNode[], depth: number, parent: string) => {
    if (!levels[depth]) levels[depth] = []
    for (const node of list) {
      siblingsOf.set(node.agent.id, node.children)
      levels[depth].push({ node, parent, id: node.agent.id })
      if (depth < 64) walk(node.children, depth + 1, node.agent.id)
    }
  }
  walk(forest, 1, SESSION_NODE)

  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  const centers = new Map<string, number>()
  let y = PAD

  levels.forEach((slots, depth) => {
    if (!slots.length) return
    const widths = slots.map((s) => (s.node ? widthOf(s.node.agent) : SESSION_WIDTH))
    // Gruppi di fratelli: ognuno si centra sotto il genitore, poi si spingono a destra quelli che si sovrappongono.
    const groups: number[][] = []
    slots.forEach((slot, i) => {
      const last = groups[groups.length - 1]
      if (last && slots[last[0]].parent === slot.parent) last.push(i)
      else groups.push([i])
    })
    const span = (g: number[]) => g.reduce((n, i) => n + widths[i], 0) + GAP_X * (g.length - 1)
    const ideal = groups.map((g) => (centers.get(slots[g[0]].parent ?? '') ?? 0) - span(g) / 2)
    const lefts: number[] = []
    groups.forEach((g, gi) => {
      const prev = gi ? lefts[gi - 1] + span(groups[gi - 1]) + GROUP_GAP : -Infinity
      lefts.push(Math.max(ideal[gi], prev))
    })
    // Lo spostamento medio si ridistribuisce: la riga non deriva tutta a destra.
    const drift = lefts.reduce((n, l, gi) => n + (l - ideal[gi]), 0) / groups.length
    groups.forEach((g, gi) => {
      let x = lefts[gi] - drift
      for (const i of g) {
        const s = slots[i]
        const siblings = s.parent ? (siblingsOf.get(s.parent) ?? []) : []
        const box: GraphNode = {
          id: s.id,
          agent: s.node?.agent ?? null,
          x,
          y,
          w: widths[i],
          level: depth + 1,
          parent: s.parent,
          children: s.node ? s.node.children.map((c) => c.agent.id) : forest.map((c) => c.agent.id),
          pos: s.node ? siblings.findIndex((c) => c.agent.id === s.id) + 1 : 1,
          setSize: s.node ? siblings.length : 1
        }
        nodes.push(box)
        byId.set(box.id, box)
        centers.set(box.id, x + box.w / 2)
        x += widths[i] + GAP_X
      }
    })
    y += NODE_HEIGHT + GAP_Y
  })

  const minX = Math.min(...nodes.map((n) => n.x))
  const maxX = Math.max(...nodes.map((n) => n.x + n.w))
  for (const n of nodes) n.x += PAD - minX
  const width = Math.round(maxX - minX + PAD * 2)
  const height = Math.round(y - GAP_Y + PAD)

  const edges: GraphEdge[] = []
  for (const n of nodes) {
    const parent = n.parent ? byId.get(n.parent) : undefined
    if (!parent || !n.agent) continue
    const x0 = parent.x + parent.w / 2
    const y0 = parent.y + NODE_HEIGHT
    const x1 = n.x + n.w / 2
    const y1 = n.y
    const my = (y0 + y1) / 2
    edges.push({ from: parent.id, to: n.id, status: n.agent.status, d: `M${x0} ${y0} C${x0} ${my} ${x1} ${my} ${x1} ${y1}` })
  }
  return { nodes, byId, edges, width, height }
}

/** Dove va il focus con una freccia: su = genitore, giù = primo figlio, sinistra e destra = fratelli; Home e End il primo e l'ultimo fratello. */
export function neighbor(layout: GraphLayout, id: string, key: string): string | null {
  const node = layout.byId.get(id)
  if (!node) return null
  if (key === 'ArrowUp') return node.parent
  if (key === 'ArrowDown') return node.children[0] ?? null
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return null
  if (!node.parent) return null
  const siblings = layout.byId.get(node.parent)?.children ?? []
  if (key === 'Home') return siblings[0] ?? null
  if (key === 'End') return siblings[siblings.length - 1] ?? null
  const at = siblings.indexOf(id)
  return siblings[at + (key === 'ArrowRight' ? 1 : -1)] ?? null
}
