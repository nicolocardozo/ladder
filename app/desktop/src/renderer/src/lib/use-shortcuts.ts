// Le etichette delle scorciatoie (shortcutLabel) si leggono dal registro condiviso, che non è reattivo:
// un componente che le mostra chiama questo hook per rifare il rendering quando cambiano preset o personalizzazioni.
import { useApp } from '@/store/app-store'

export function useShortcutsRevision(): void {
  useApp((s) => s.shortcuts)
}
