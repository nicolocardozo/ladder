// Bridge to the main process's system functions used by settings (editor, folders, sounds). In the app they come from the preload;
// in the web preview (no Electron) `overrideSystemBridge` provides fake responses, so the sections can still be tried.
import type { EditorAvailability, RequestSound } from '@shared/protocol'

export interface SystemBridge {
  editors: () => Promise<EditorAvailability | null>
  pickFolder: () => Promise<string | null>
  pickSavePath: (defaultName: string) => Promise<string | null>
  /** Test of a request sound: true if it was heard, false if the test banner is needed. */
  playSound: (name: RequestSound) => Promise<boolean>
  testNotification: () => Promise<boolean>
}

const SYSTEM_SOUNDS = '/System/Library/Sounds'

const real: SystemBridge = {
  editors: async () => (await window.ladder?.editors()) ?? null,
  pickFolder: async () => (await window.ladder?.pickFolder()) ?? null,
  pickSavePath: async (name) => (await window.ladder?.pickSavePath(name)) ?? null,
  // A system sound is audible from the page too (file://, in the installed app); 'default' has no file, and if the page can't
  // read it (development over http) it falls back to main's test banner, which uses the chosen sound.
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
