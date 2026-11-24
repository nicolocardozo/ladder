// Layout del grafico dei sotto-agenti, calcolato a mano e senza misure del DOM: un albero da sinistra a destra.
// Una colonna per profondità, la sessione a sinistra, i figli impilati in colonna; ogni genitore sta al centro dei suoi figli.
// Larghezze fisse (il testo si tronca), quindi il layout è una funzione pura dell'elenco: nessuna libreria.
import type { SubagentInfo } from '@shared/protocol'
import type { AgentNode } from '@/lib/subagents'

/** Id del nodo della sessione, radice del grafico. */
export const SESSION_NODE = '__session__'

/** Oltre questo numero il grafico non si propone: la lista è l'alternativa completa. */
export const GRAPH_MAX = 150

export const NODE_HEIGHT = 44
export const NODE_WIDTH = 264
export const SESSION_WIDTH = 176
/** Passo verticale fra due nodi vicini. */
const ROW_PITCH = NODE_HEIGHT + 8
/** Spazio fra le colonne: dentro corre il tronco dei collegamenti. */
const COL_GAP = 48
const PAD = 12
/** Raggio della curva fra tronco e raccordo. */
const CORNER = 10

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
  /** Il genitore: un solo tracciato per genitore, con il tronco e i raccordi di tutti i figli. */
  from: string
  /** Tracciato già scritto per un attributo `d`. */
  d: string
}

export interface GraphLayout {
  nodes: GraphNode[]
  byId: Map<string, GraphNode>
  edges: GraphEdge[]
  width: number
  height: number
}

/**
 * Posiziona i nodi. Le foglie prendono righe consecutive nell'ordine di visita in profondità; un genitore si centra
 * fra il primo e l'ultimo figlio. Così nessun collegamento attraversa un nodo e i fratelli restano nell'ordine dato.
 */
export function layoutAgentGraph(forest: AgentNode[]): GraphLayout {
  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  let leaf = 0
  const colX: number[] = []
  const colLeft = (depth: number) => {
    if (colX[depth] === undefined) colX[depth] = depth === 0 ? PAD : colLeft(depth - 1) + (depth === 1 ? SESSION_WIDTH : NODE_WIDTH) + COL_GAP
    return colX[depth]
  }

  /** Visita in profondità: restituisce il centro verticale del nodo. */
  const place = (node: AgentNode | null, id: string, children: AgentNode[], depth: number, parent: string | null, pos: number, setSize: number): number => {
    const childCenters = depth < 64 ? children.map((c, i) => place(c, c.agent.id, c.children, depth + 1, id, i + 1, children.length)) : []
    const center = childCenters.length ? (childCenters[0] + childCenters[childCenters.length - 1]) / 2 : PAD + NODE_HEIGHT / 2 + leaf++ * ROW_PITCH
    const box: GraphNode = {
      id,
      agent: node?.agent ?? null,
      x: colLeft(depth),
      y: center - NODE_HEIGHT / 2,
      w: node ? NODE_WIDTH : SESSION_WIDTH,
      level: depth + 1,
      parent,
      children: depth < 64 ? children.map((c) => c.agent.id) : [],
      pos,
      setSize
    }
    nodes.push(box)
    byId.set(id, box)
    return center
  }
  place(null, SESSION_NODE, forest, 0, null, 1, 1)

  let width = 0
  let height = 0
  for (const n of nodes) {
    width = Math.max(width, n.x + n.w)
    height = Math.max(height, n.y + NODE_HEIGHT)
  }

  // Un tracciato per genitore: dal bordo destro si esce a metà dello spazio fra le colonne (il tronco), che sale e scende
  // fino ai figli; ogni raccordo curva verso il bordo sinistro del figlio. Tutto dello stesso colore pieno: dove si
  // sovrappone non si vede, e il raccordo nasce dal centro del tronco.
  const edges: GraphEdge[] = []
  for (const parent of nodes) {
    if (!parent.children.length) continue
    const x0 = parent.x + parent.w
    const y0 = parent.y + NODE_HEIGHT / 2
    const trunk = x0 + COL_GAP / 2
    const parts: string[] = []
    for (const id of parent.children) {
      const child = byId.get(id)
      if (!child) continue
      const y1 = child.y + NODE_HEIGHT / 2
      const dy = y1 - y0
      if (Math.abs(dy) < 0.5) {
        parts.push(`M${x0} ${y0}H${child.x}`)
        continue
      }
      const r = Math.min(CORNER, Math.abs(dy), COL_GAP / 2)
      const dir = dy > 0 ? 1 : -1
      parts.push(`M${x0} ${y0}H${trunk}V${y1 - dir * r}Q${trunk} ${y1} ${trunk + r} ${y1}H${child.x}`)
    }
    edges.push({ from: parent.id, d: parts.join('') })
  }
  return { nodes, byId, edges, width: Math.round(width + PAD), height: Math.round(height + PAD) }
}

/**
 * Dove va il focus con una freccia: sinistra = genitore, destra = primo figlio, su e giù = fratelli;
 * Home e End il primo e l'ultimo fratello.
 */
export function neighbor(layout: GraphLayout, id: string, key: string): string | null {
  const node = layout.byId.get(id)
  if (!node) return null
  if (key === 'ArrowLeft') return node.parent
  if (key === 'ArrowRight') return node.children[0] ?? null
  if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return null
  if (!node.parent) return null
  const siblings = layout.byId.get(node.parent)?.children ?? []
  if (key === 'Home') return siblings[0] ?? null
  if (key === 'End') return siblings[siblings.length - 1] ?? null
  const at = siblings.indexOf(id)
  return siblings[at + (key === 'ArrowDown' ? 1 : -1)] ?? null
}
