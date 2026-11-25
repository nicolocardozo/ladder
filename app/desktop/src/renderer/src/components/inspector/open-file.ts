// Opening files outside Ladder, in the editor chosen for the project (Cursor if none is specified).
import { useEffect, useState } from 'react'
import type { EditorAvailability, EditorId } from '@shared/protocol'
import { send } from '@/lib/host-client'
import { system } from '@/lib/system-bridge'
import { useApp } from '@/store/app-store'

/** Project editor, then the one from preferences, then Cursor. */
export function editorOf(projectId: string | null): EditorId {
  const state = useApp.getState()
  return (projectId && state.ui[projectId]?.editor) || state.prefs?.editor || 'cursor'
}

/** Like `editorOf`, but reactive: a single place for the chain project, preferences, Cursor. */
export function useEditorOf(projectId: string | null): EditorId {
  return useApp((s) => (projectId && s.ui[projectId]?.editor) || s.prefs?.editor || 'cursor')
}

/** Which editors are installed (read on open); null until known or if it can't be known. */
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

/** Editor of this project (replaces the one in settings, which stays for the others). */
export function chooseEditor(projectId: string, editor: EditorId): void {
  const state = useApp.getState()
  const current = state.ui[projectId] ?? { tabs: [], activeTab: null, scroll: {} }
  const next = { ...current, editor }
  state.setUi(projectId, next)
  send({ type: 'ui.set', projectId, state: next })
}
