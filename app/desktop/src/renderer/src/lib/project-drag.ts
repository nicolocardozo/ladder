// Trascinamento di progetti e sezioni nella sidebar, sul nucleo di pointer-drag (soglia, Esc, clic che resta clic).
// Il DOM dice dove si può rilasciare: `data-project-list` (l'area scorrevole), `data-project-zone` (sezione o elenco senza
// sezione), `data-project-row` (la riga di un progetto) e `data-section` (il blocco di una sezione).
import { create } from 'zustand'
import { startPointerDrag } from '@/lib/pointer-drag'
import { useApp } from '@/store/app-store'

/** Valore di `data-project-zone` per i progetti fuori da ogni sezione. */
export const NO_SECTION = 'none'

export interface ProjectDropTarget {
  /** Id della sezione, o `NO_SECTION`. Per una sezione trascinata vale sempre `NO_SECTION`. */
  zone: string
  /** Posizione tra gli altri elementi della zona, contati senza quello trascinato. */
  index: number
  /** Sezione chiusa: il progetto va in fondo e la sezione si apre. */
  collapsed: boolean
}

interface DragState {
  active: { kind: 'project' | 'section'; id: string; label: string } | null
  target: ProjectDropTarget | null
  x: number
  y: number
}

export const useProjectDrag = create<DragState>(() => ({ active: null, target: null, x: 0, y: 0 }))

const EDGE = 28

function inList(x: number, y: number): HTMLElement | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-project-list]') ?? null
}

function midY(element: Element): number {
  const rect = element.getBoundingClientRect()
  return rect.top + rect.height / 2
}

/** Dove cadrebbe un progetto rilasciato in (x, y): la zona sotto il puntatore, o la più vicina se è nello spazio tra due. */
function projectTarget(x: number, y: number, id: string): ProjectDropTarget | null {
  const list = inList(x, y)
  if (!list) return null
  const zones = [...list.querySelectorAll<HTMLElement>('[data-project-zone]')]
  const distance = (zone: HTMLElement) => {
    const rect = zone.getBoundingClientRect()
    return y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
  }
  const zone = zones.sort((a, b) => distance(a) - distance(b))[0]
  if (!zone) return null
  const rows = [...zone.querySelectorAll<HTMLElement>('[data-project-row]')].filter((row) => row.dataset.projectRow !== id)
  const collapsed = zone.dataset.collapsed === 'true'
  return { zone: zone.dataset.projectZone ?? NO_SECTION, index: collapsed ? rows.length : rows.filter((row) => midY(row) < y).length, collapsed }
}

/** Dove cadrebbe una sezione rilasciata in (x, y): tra le altre, contate senza quella trascinata. */
function sectionTarget(x: number, y: number, id: string): ProjectDropTarget | null {
  const list = inList(x, y)
  if (!list) return null
  const others = [...list.querySelectorAll<HTMLElement>('[data-section]')].filter((section) => section.dataset.section !== id)
  return { zone: NO_SECTION, index: others.filter((section) => midY(section) < y).length, collapsed: false }
}

/** Vicino al bordo dell'elenco lo fa scorrere, così si raggiungono anche i progetti fuori vista. */
function autoScroll(x: number, y: number): void {
  const list = inList(x, y)
  const viewport = list?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
  if (!list || !viewport) return
  const rect = viewport.getBoundingClientRect()
  if (y < rect.top + EDGE) viewport.scrollTop -= 8
  else if (y > rect.bottom - EDGE) viewport.scrollTop += 8
}

interface DragOptions {
  event: { button: number; clientX: number; clientY: number }
  id: string
  label: string
}

function startDrag(kind: 'project' | 'section', { event, id, label }: DragOptions, targetAt: typeof projectTarget, commit: (target: ProjectDropTarget) => void): void {
  const end = () => useProjectDrag.setState({ active: null, target: null })
  startPointerDrag(event, {
    onStart: (move) => useProjectDrag.setState({ active: { kind, id, label }, target: targetAt(move.clientX, move.clientY, id), x: move.clientX, y: move.clientY }),
    onMove: (move) => {
      autoScroll(move.clientX, move.clientY)
      useProjectDrag.setState({ target: targetAt(move.clientX, move.clientY, id), x: move.clientX, y: move.clientY })
    },
    onEnd: (up) => {
      const target = targetAt(up.clientX, up.clientY, id)
      end()
      if (target) commit(target)
    },
    onCancel: end
  })
}

/** Trascina un progetto: tra le sezioni e dentro la sua. Rilasciare fuori dall'elenco non fa nulla. */
export function startProjectDrag(options: DragOptions): void {
  startDrag('project', options, projectTarget, (target) => {
    const section = target.zone === NO_SECTION ? null : target.zone
    useApp.getState().moveProject(options.id, section, target.collapsed ? undefined : target.index)
  })
}

/** Trascina una sezione per cambiarne il posto tra le altre. */
export function startSectionDrag(options: DragOptions): void {
  startDrag('section', options, sectionTarget, (target) => {
    const ids = (useApp.getState().projectGroups?.groups ?? []).map((g) => g.id).filter((id) => id !== options.id)
    ids.splice(target.index, 0, options.id)
    useApp.getState().reorderProjectGroups(ids)
  })
}
