// Ponte verso le funzioni di sistema del main usate dalle impostazioni (editor, cartelle, suoni). Nell'app vengono dal preload;
// nell'anteprima web (senza Electron) `overrideSystemBridge` mette risposte finte, così le sezioni si provano uguale.
import type { EditorAvailability, RequestSound } from '@shared/protocol'

export interface SystemBridge {
  editors: () => Promise<EditorAvailability | null>
  pickFolder: () => Promise<string | null>
  pickSavePath: (defaultName: string) => Promise<string | null>
  /** Prova di un suono delle richieste: true se si è sentito, false se serve il banner di prova. */
  playSound: (name: RequestSound) => Promise<boolean>
  testNotification: () => Promise<boolean>
}

const SYSTEM_SOUNDS = '/System/Library/Sounds'

const real: SystemBridge = {
  editors: async () => (await window.ladder?.editors()) ?? null,
  pickFolder: async () => (await window.ladder?.pickFolder()) ?? null,
  pickSavePath: async (name) => (await window.ladder?.pickSavePath(name)) ?? null,
  // Un suono di sistema si sente anche dalla pagina (file://, nell'app installata); 'default' non ha un file, e se la pagina non può
  // leggerlo (sviluppo su http) si ripiega sul banner di prova del main, che usa il suono scelto.
  playSound: async (name) => {
    if (name === 'default') return false
    try {
      await new Audio(`file://${SYSTEM_SOUNDS}/${name}.aiff`).play()
      return true
    } catch {
      return false
    }
  },
  testNotification: async () => (await window.ladder?.testNotification()) ?? false
}

let current: SystemBridge = real

export const system: SystemBridge = {
  editors: () => current.editors(),
  pickFolder: () => current.pickFolder(),
  pickSavePath: (name) => current.pickSavePath(name),
  playSound: (name) => current.playSound(name),
  testNotification: () => current.testNotification()
}

export function overrideSystemBridge(next: Partial<SystemBridge>): void {
  current = { ...real, ...next }
}

export const REQUEST_SOUNDS: RequestSound[] = ['default', 'Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Funk', 'Tink']

/** Dimensione leggibile: 1,4 MB. */
export function formatBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}
