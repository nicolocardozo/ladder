// Shortcut labels (shortcutLabel) are read from the shared registry, which is not reactive:
// a component that shows them calls this hook to rerender when presets, customizations
// or the keyboard in use change (labels of keys recognized by position show the layout's character).
import { useSyncExternalStore } from 'react'
import { setKeyboardLayout } from '@shared/shortcuts'
import { useApp } from '@/store/app-store'

let layoutRevision = 0
let layoutSignature = ''
const listeners = new Set<() => void>()

interface KeyboardApi extends EventTarget {
  getLayoutMap(): Promise<ReadonlyMap<string, string>>
}

/** Rereads the keyboard layout; if it changed it updates the registry and redraws whoever shows labels. */
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
    // Without permission or outside a secure context: the US labels remain.
  }
}

if (typeof window !== 'undefined') {
  void readLayout()
  // The layout can be changed from the macOS menu while the app is open: it is reread when the window comes back to the foreground
  // and, where it exists, on the layoutchange event.
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
