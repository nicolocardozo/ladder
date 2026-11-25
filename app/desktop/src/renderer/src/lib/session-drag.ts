// Multi-select and drag of sessions in the sidebar (groups). Local UI state: not persisted.
import { create } from 'zustand'
import { startPointerDrag } from '@/lib/pointer-drag'
import { useApp } from '@/store/app-store'

/** Value of `data-drop-group` for "outside the groups". */
export const NO_GROUP = 'none'

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
  x: number
  y: number
}

export const useSessionDrag = create<DragState>(() => ({ active: null, over: null, x: 0, y: 0 }))

function zoneAt(x: number, y: number, projectId: string): string | null {
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-group]')
  return zone && zone.dataset.dropProject === projectId ? (zone.dataset.dropGroup ?? null) : null
}

interface SessionDragOptions {
  event: { button: number; clientX: number; clientY: number }
  projectId: string
  ids: string[]
  label: string
}

/** Drags one or more sessions onto the groups (`data-drop-group` zones of the project). Dropping elsewhere does nothing. */
export function startSessionDrag({ event, projectId, ids, label }: SessionDragOptions): void {
  const end = () => useSessionDrag.setState({ active: null, over: null })
  startPointerDrag(event, {
    onStart: (move) => useSessionDrag.setState({ active: { projectId, ids, label }, over: zoneAt(move.clientX, move.clientY, projectId), x: move.clientX, y: move.clientY }),
    onMove: (move) => useSessionDrag.setState({ over: zoneAt(move.clientX, move.clientY, projectId), x: move.clientX, y: move.clientY }),
    onEnd: (up) => {
      const zone = zoneAt(up.clientX, up.clientY, projectId)
      end()
      if (zone === null) return
      useApp.getState().moveSessionsToGroup(projectId, ids, zone === NO_GROUP ? null : zone)
      usePick.getState().clear()
    },
    onCancel: end
  })
}
