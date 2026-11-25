// Drag-and-drop of projects and sections in the sidebar, built on the pointer-drag core (threshold, Esc, a click stays a click).
// The DOM says where to drop: `data-project-list` (the scrollable area), `data-project-zone` (a section or the list with no
// section), `data-project-row` (a project row) and `data-section` (a section block).
import { create } from 'zustand'
import { startPointerDrag } from '@/lib/pointer-drag'
import { useApp } from '@/store/app-store'

/** Value of `data-project-zone` for projects outside any section. */
export const NO_SECTION = 'none'

export interface ProjectDropTarget {
  /** Section id, or `NO_SECTION`. For a dragged section it is always `NO_SECTION`. */
  zone: string
  /** Position among the other items in the zone, counted without the dragged one. */
  index: number
  /** Closed section: the project goes to the bottom and the section opens. */
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

/** Where a project dropped at (x, y) would land: the zone under the pointer, or the nearest one if it is in the gap between two. */
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

/** Where a section dropped at (x, y) would land: among the others, counted without the dragged one. */
function sectionTarget(x: number, y: number, id: string): ProjectDropTarget | null {
  const list = inList(x, y)
  if (!list) return null
  const others = [...list.querySelectorAll<HTMLElement>('[data-section]')].filter((section) => section.dataset.section !== id)
  return { zone: NO_SECTION, index: others.filter((section) => midY(section) < y).length, collapsed: false }
}

/** Near the list edge it scrolls the list, so projects out of view can be reached too. */
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

/** Drags a project: between sections and within its own. Dropping outside the list does nothing. */
export function startProjectDrag(options: DragOptions): void {
  startDrag('project', options, projectTarget, (target) => {
    const section = target.zone === NO_SECTION ? null : target.zone
    useApp.getState().moveProject(options.id, section, target.collapsed ? undefined : target.index)
  })
}

/** Drags a section to change its place among the others. */
export function startSectionDrag(options: DragOptions): void {
  startDrag('section', options, sectionTarget, (target) => {
    const ids = (useApp.getState().projectGroups?.groups ?? []).map((g) => g.id).filter((id) => id !== options.id)
    ids.splice(target.index, 0, options.id)
    useApp.getState().reorderProjectGroups(ids)
  })
}
