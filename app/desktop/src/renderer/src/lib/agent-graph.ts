// Layout of the subagent graph, computed by hand without DOM measurements: a tree from left to right.
// One column per depth, the session on the left, children stacked in a column; each parent sits at the center of its children.
// Fixed widths (text is truncated), so the layout is a pure function of the list: no library.
import type { SubagentInfo } from '@shared/protocol'
import type { AgentNode } from '@/lib/subagents'

/** Id of the session node, the root of the graph. */
export const SESSION_NODE = '__session__'

/** Beyond this number the graph is not offered: the list is the complete alternative. */
export const GRAPH_MAX = 150

export const NODE_HEIGHT = 44
export const NODE_WIDTH = 264
export const SESSION_WIDTH = 176
/** Vertical step between two adjacent nodes. */
const ROW_PITCH = NODE_HEIGHT + 8
/** Space between columns: the links' trunk runs inside it. */
const COL_GAP = 48
const PAD = 12
/** Radius of the curve between trunk and connector. */
const CORNER = 10

export interface GraphNode {
  id: string
  /** null for the session node. */
  agent: SubagentInfo | null
  x: number
  y: number
  w: number
  /** 1 for the session node, then 2, 3… as aria-level. */
  level: number
  parent: string | null
  children: string[]
  /** Position among siblings (from 1) and how many there are, for aria-posinset and aria-setsize. */
  pos: number
  setSize: number
}

export interface GraphEdge {
  /** The parent: one path per parent, with the trunk and the connectors of all its children. */
  from: string
  /** Path already written for a `d` attribute. */
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
 * Positions the nodes. Leaves take consecutive rows in depth-first visit order; a parent is centered
 * between its first and last child. This way no link crosses a node and siblings keep the given order.
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

  /** Depth-first visit: returns the node's vertical center. */
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

  // One path per parent: from the right edge it exits at the middle of the space between columns (the trunk), which goes up and down
  // to the children; each connector curves toward the child's left edge. All in the same solid color: where it
  // overlaps it is invisible, and the connector starts from the center of the trunk.
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
 * Where focus goes with an arrow: left = parent, right = first child, up and down = siblings;
 * Home and End the first and last sibling.
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
