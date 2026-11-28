// Multi-select and drag of sessions in the sidebar (groups). Local UI state: not persisted.
import { create } from 'zustand'
import { startPointerDrag } from '@/lib/pointer-drag'
import { useApp } from '@/store/app-store'

/** Value of `data-drop-group` for "outside the groups". */
export const NO_GROUP = 'none'

/** Where dragged sessions would land inside a group: before `beforeId`, or at the end with null. `anchor` draws the line. */
export interface DropSlot {
  beforeId: string | null
  anchor: { id: string; position: 'before' | 'after' }
}

interface PickState {
  projectId: string | null
  ids: string[]
  /** Last row touched: ⇧ selection starts from there. */
  anchor: string | null
  clear: () => void
}

/** Sessions selected with ⌘ and ⇧ click, in one project at a time. */
export const usePick = create<PickState>((set) => ({
  projectId: null,
  ids: [],
  anchor: null,
  clear: () => set((state) => (state.ids.length ? { ids: [], projectId: null } : {}))
}))

/**
 * Click on a row with modifiers. ⌘ adds or removes the row, ⇧ selects from the last touched to this one.
 * Returns true if the click was consumed (the session does not open); a plain click clears the selection.
 */
export function pickClick(event: { metaKey: boolean; shiftKey: boolean }, projectId: string, order: string[], id: string): boolean {
  const pick = usePick.getState()
  const current = pick.projectId === projectId ? pick.ids : []
  if (event.metaKey) {
    const ids = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    usePick.setState({ projectId, ids, anchor: id })
    return true
  }
  if (event.shiftKey) {
    const from = order.indexOf(pick.projectId === projectId && pick.anchor ? pick.anchor : id)
    const to = order.indexOf(id)
    const range = from < 0 || to < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1)
    // Like in Finder: the selection extends from the anchor, the anchor stays where it was.
    usePick.setState({ projectId, ids: range, anchor: from < 0 ? id : order[from] })
    return true
  }
  usePick.setState({ projectId, ids: [], anchor: id })
  return false
}

interface DragState {
  active: { projectId: string; ids: string[]; label: string } | null
  /** Id of the group under the pointer, `NO_GROUP` outside the groups, null elsewhere. */
  over: string | null
  /** Position inside the group under the pointer (groups only: outside them the order is by date). */
  slot: DropSlot | null
  x: number
  y: number
}

export const useSessionDrag = create<DragState>(() => ({ active: null, over: null, slot: null, x: 0, y: 0 }))

/** The group zone under the pointer and, inside a group, the row the sessions would land next to (dragged rows excluded). */
function zoneAt(x: number, y: number, projectId: string, dragged: string[]): { over: string | null; slot: DropSlot | null } {
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-group]')
  if (!zone || zone.dataset.dropProject !== projectId) return { over: null, slot: null }
  const over = zone.dataset.dropGroup ?? null
  if (!over || over === NO_GROUP) return { over, slot: null }
  const rows = [...zone.querySelectorAll<HTMLElement>('[data-session-row]')].filter((row) => !dragged.includes(row.dataset.sessionRow ?? ''))
  if (rows.length === 0) return { over, slot: null }
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (y < rect.top + rect.height / 2) return { over, slot: { beforeId: row.dataset.sessionRow!, anchor: { id: row.dataset.sessionRow!, position: 'before' } } }
  }
  const last = rows[rows.length - 1].dataset.sessionRow!
  return { over, slot: { beforeId: null, anchor: { id: last, position: 'after' } } }
}

interface SessionDragOptions {
  event: { button: number; clientX: number; clientY: number }
  projectId: string
  ids: string[]
  label: string
}

interface GroupDragState {
  active: { projectId: string; id: string } | null
  /** Group header the dragged group would land next to. */
  target: { id: string; position: 'before' | 'after' } | null
}

export const useGroupDrag = create<GroupDragState>(() => ({ active: null, target: null }))

function groupTargetAt(x: number, y: number, projectId: string, dragged: string): GroupDragState['target'] {
  // Released outside the project's list (the chat, another project): nothing moves, as with projects.
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-project]')
  if (!zone || zone.dataset.dropProject !== projectId) return null
  const heads = [...document.querySelectorAll<HTMLElement>(`[data-group-head][data-drop-project="${CSS.escape(projectId)}"]`)].filter((el) => el.dataset.groupHead !== dragged)
  if (heads.length === 0) return null
  for (const head of heads) {
    const rect = head.getBoundingClientRect()
    if (y < rect.top + rect.height / 2) return { id: head.dataset.groupHead!, position: 'before' }
  }
  return { id: heads[heads.length - 1].dataset.groupHead!, position: 'after' }
}

/** Drags a group by its header to another place among the project's groups. */
export function startGroupDrag(event: { button: number; clientX: number; clientY: number }, projectId: string, groupId: string): void {
  const end = () => useGroupDrag.setState({ active: null, target: null })
  startPointerDrag(event, {
    onStart: (move) => useGroupDrag.setState({ active: { projectId, id: groupId }, target: groupTargetAt(move.clientX, move.clientY, projectId, groupId) }),
    onMove: (move) => useGroupDrag.setState({ target: groupTargetAt(move.clientX, move.clientY, projectId, groupId) }),
    onEnd: (up) => {
      const target = groupTargetAt(up.clientX, up.clientY, projectId, groupId)
      end()
      if (!target) return
      const ids = (useApp.getState().ui[projectId]?.groups ?? []).map((g) => g.id).filter((id) => id !== groupId)
      const at = ids.indexOf(target.id) + (target.position === 'after' ? 1 : 0)
      ids.splice(at, 0, groupId)
      useApp.getState().reorderGroups(projectId, ids)
    },
    onCancel: end
  })
}

/** Drags one or more sessions onto the groups (`data-drop-group` zones of the project). Dropping elsewhere does nothing. */
export function startSessionDrag({ event, projectId, ids, label }: SessionDragOptions): void {
  const end = () => useSessionDrag.setState({ active: null, over: null, slot: null })
  startPointerDrag(event, {
    onStart: (move) => useSessionDrag.setState({ active: { projectId, ids, label }, ...zoneAt(move.clientX, move.clientY, projectId, ids), x: move.clientX, y: move.clientY }),
    onMove: (move) => useSessionDrag.setState({ ...zoneAt(move.clientX, move.clientY, projectId, ids), x: move.clientX, y: move.clientY }),
    onEnd: (up) => {
      const { over, slot } = zoneAt(up.clientX, up.clientY, projectId, ids)
      end()
      if (over === null) return
      // Into a group, at the line shown; outside the groups the list is by date, so only the group changes.
      // A closed or empty group shows no line: the sessions go on top, as when moved with the menu.
      if (over === NO_GROUP || !slot) useApp.getState().moveSessionsToGroup(projectId, ids, over === NO_GROUP ? null : over)
      else useApp.getState().placeSessions(projectId, over, ids, slot.beforeId)
      usePick.getState().clear()
    },
    onCancel: end
  })
}
