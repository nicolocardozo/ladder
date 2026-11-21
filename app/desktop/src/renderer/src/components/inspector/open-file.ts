// Apertura dei file fuori da Ladder, nell'editor scelto per il progetto (Cursor se non è indicato).
import type { EditorId } from '@shared/protocol'
import { useApp } from '@/store/app-store'

/** Editor del progetto, poi quello delle preferenze, poi Cursor. */
export function editorOf(projectId: string | null): EditorId {
  const state = useApp.getState()
  return (projectId && state.ui[projectId]?.editor) || state.prefs?.editor || 'cursor'
}

export const EDITORS: EditorId[] = ['cursor', 'vscode', 'zed', 'xcode']
export const EDITOR_NAME: Record<EditorId, string> = { cursor: 'Cursor', vscode: 'VS Code', zed: 'Zed', xcode: 'Xcode' }

export function openInEditor(projectId: string | null, absolutePath: string, line?: number): void {
  void window.ladder?.openInEditor(absolutePath, line, editorOf(projectId))
}
