// Apertura dei file fuori da Ladder, nell'editor scelto per il progetto (Cursor se non è indicato).
import { useApp } from '@/store/app-store'

export function editorOf(projectId: string | null): 'cursor' | 'vscode' {
  return (projectId && useApp.getState().ui[projectId]?.editor) || 'cursor'
}

export const EDITOR_NAME = { cursor: 'Cursor', vscode: 'VS Code' } as const

export function openInEditor(projectId: string | null, absolutePath: string, line?: number): void {
  void window.ladder?.openInEditor(absolutePath, line, editorOf(projectId))
}
