// Apertura dei file fuori da Ladder, nell'editor scelto per il progetto (Cursor se non è indicato).
import { useEffect, useState } from 'react'
import type { EditorAvailability, EditorId } from '@shared/protocol'
import { send } from '@/lib/host-client'
import { system } from '@/lib/system-bridge'
import { useApp } from '@/store/app-store'

/** Editor del progetto, poi quello delle preferenze, poi Cursor. */
export function editorOf(projectId: string | null): EditorId {
  const state = useApp.getState()
  return (projectId && state.ui[projectId]?.editor) || state.prefs?.editor || 'cursor'
}

/** Come `editorOf`, ma reattivo: un solo posto per la catena progetto, preferenze, Cursor. */
export function useEditorOf(projectId: string | null): EditorId {
  return useApp((s) => (projectId && s.ui[projectId]?.editor) || s.prefs?.editor || 'cursor')
}

/** Quali editor sono installati (letti all'apertura); null finché non si sa o se non si può sapere. */
export function useInstalledEditors(): EditorAvailability | null {
  const [installed, setInstalled] = useState<EditorAvailability | null>(null)
  useEffect(() => {
    let cancelled = false
    void system.editors().then((found) => !cancelled && setInstalled(found))
    return () => {
      cancelled = true
    }
  }, [])
  return installed
}

export const EDITORS: EditorId[] = ['cursor', 'vscode', 'zed', 'xcode']
export const EDITOR_NAME: Record<EditorId, string> = { cursor: 'Cursor', vscode: 'VS Code', zed: 'Zed', xcode: 'Xcode' }

export function openInEditor(projectId: string | null, absolutePath: string, line?: number): void {
  void window.ladder?.openInEditor(absolutePath, line, editorOf(projectId))
}

/** Editor di questo progetto (sostituisce quello delle impostazioni, che resta per gli altri). */
export function chooseEditor(projectId: string, editor: EditorId): void {
  const state = useApp.getState()
  const current = state.ui[projectId] ?? { tabs: [], activeTab: null, scroll: {} }
  const next = { ...current, editor }
  state.setUi(projectId, next)
  send({ type: 'ui.set', projectId, state: next })
}
