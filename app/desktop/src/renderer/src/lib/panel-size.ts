// Adjustable widths: sidebar and inspector are remembered across the whole app, in localStorage like the rest of the
// interface preferences. Side-by-side columns instead live in the project state (ProjectUiState.columnWidths).

/** The main content does not shrink below this width when the sidebar or inspector is widened. */
export const MIN_CONTENT_WIDTH = 480
/** Arrow-key step on a divider; with Shift, the large step. */
export const RESIZE_STEP = 16
export const RESIZE_STEP_LARGE = 64

export const SIDEBAR_WIDTH = { key: 'ladder.sidebar-width', default: 262, min: 200, max: 420 }
export const INSPECTOR_WIDTH = { key: 'ladder.inspector-width', default: 460, min: 320 }

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

export function readSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value >= min ? Math.min(Math.round(value), max) : fallback
  } catch {
    return fallback
  }
}

export function writeSize(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // Only a convenience: without storage the size returns to the default at the next launch.
  }
}

/**
 * The sidebar width is a CSS variable on <html>: the sidebar and the "All sessions" panel (which sits next to it)
 * read it without redrawing on every pixel of the drag.
 */
export function applySidebarWidth(px: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${Math.round(px)}px`)
}

export const readSidebarWidth = (): number => readSize(SIDEBAR_WIDTH.key, SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)

applySidebarWidth(readSidebarWidth())
