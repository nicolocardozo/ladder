// Le etichette delle scorciatoie (shortcutLabel) si leggono dal registro condiviso, che non è reattivo:
// un componente che le mostra chiama questo hook per rifare il rendering quando cambiano preset, personalizzazioni
// o la tastiera in uso (le etichette dei tasti riconosciuti per posizione mostrano il carattere del layout).
import { useSyncExternalStore } from 'react'
import { setKeyboardLayout } from '@shared/shortcuts'
import { useApp } from '@/store/app-store'

let layoutRevision = 0
let layoutSignature = ''
const listeners = new Set<() => void>()

interface KeyboardApi extends EventTarget {
  getLayoutMap(): Promise<ReadonlyMap<string, string>>
}

/** Rilegge il layout della tastiera; se è cambiato aggiorna il registro e ridisegna chi mostra etichette. */
async function readLayout(): Promise<void> {
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard
  if (!keyboard?.getLayoutMap) return
  try {
    const map = new Map(await keyboard.getLayoutMap())
    const signature = [...map].map(([code, key]) => `${code}=${key}`).join(',')
    if (signature === layoutSignature) return
    layoutSignature = signature
    setKeyboardLayout(map)
    layoutRevision++
    for (const listener of listeners) listener()
  } catch {
    // Senza permesso o fuori da un contesto sicuro: restano le etichette americane.
  }
}

if (typeof window !== 'undefined') {
  void readLayout()
  // Il layout si può cambiare dal menu di macOS ad app aperta: si rilegge quando la finestra torna in primo piano
  // e, dove esiste, all'evento layoutchange.
  window.addEventListener('focus', () => void readLayout())
  ;(navigator as Navigator & { keyboard?: KeyboardApi }).keyboard?.addEventListener?.('layoutchange', () => void readLayout())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useShortcutsRevision(): void {
  useApp((s) => s.shortcuts)
  useSyncExternalStore(subscribe, () => layoutRevision)
}
