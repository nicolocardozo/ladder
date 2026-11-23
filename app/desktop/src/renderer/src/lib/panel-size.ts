// Larghezze regolabili (LAD-75): sidebar e ispettore si ricordano per tutta l'app, in localStorage come il resto delle
// preferenze di interfaccia. Le colonne affiancate invece stanno nello stato del progetto (ProjectUiState.columnWidths).

/** Il contenuto principale non scende sotto questa larghezza quando si allarga la sidebar o l'ispettore. */
export const MIN_CONTENT_WIDTH = 480
/** Passo delle frecce su un divisore; con Maiusc, il passo grande. */
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
    // Solo una comodità: senza storage la misura torna quella predefinita al prossimo avvio.
  }
}

/**
 * La larghezza della sidebar è una variabile CSS su <html>: la sidebar e il pannello "All sessions" (che le sta accanto)
 * la leggono senza ridisegnarsi a ogni pixel del trascinamento.
 */
export function applySidebarWidth(px: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${Math.round(px)}px`)
}

export const readSidebarWidth = (): number => readSize(SIDEBAR_WIDTH.key, SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)

applySidebarWidth(readSidebarWidth())
