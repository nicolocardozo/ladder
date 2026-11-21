// Selezione multipla e trascinamento delle sessioni nella sidebar (gruppi). Stato locale dell'interfaccia: non si salva.
import { create } from 'zustand'
import { startPointerDrag } from '@/lib/pointer-drag'
import { useApp } from '@/store/app-store'

/** Valore di `data-drop-group` per "fuori dai gruppi". */
export const NO_GROUP = 'none'

interface PickState {
  projectId: string | null
  ids: string[]
  /** Ultima riga toccata: da lì parte la selezione con ⇧. */
  anchor: string | null
  clear: () => void
}

/** Sessioni selezionate con ⌘ e ⇧ clic, in un solo progetto alla volta. */
export const usePick = create<PickState>((set) => ({
  projectId: null,
  ids: [],
  anchor: null,
  clear: () => set((state) => (state.ids.length ? { ids: [], projectId: null } : {}))
}))

/**
 * Clic su una riga con i modificatori. ⌘ aggiunge o toglie la riga, ⇧ seleziona dall'ultima toccata a questa.
 * Restituisce true se il clic è stato preso (la sessione non si apre); con un clic semplice la selezione si azzera.
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
    // Come nel Finder: la selezione si estende dall'ancora, l'ancora resta dov'era.
    usePick.setState({ projectId, ids: range, anchor: from < 0 ? id : order[from] })
    return true
  }
  usePick.setState({ projectId, ids: [], anchor: id })
  return false
}

interface DragState {
  active: { projectId: string; ids: string[]; label: string } | null
  /** Id del gruppo sotto il puntatore, `NO_GROUP` fuori dai gruppi, null altrove. */
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

/** Trascina una o più sessioni sui gruppi (zone `data-drop-group` del progetto). Rilasciare altrove non fa nulla. */
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
