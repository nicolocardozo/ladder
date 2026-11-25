// Global shortcuts: the registry (shared/shortcuts.ts) says which key does what, the actions live here.
// A single keydown listener for the whole window; composer, editor and terminal read the same registry
// for the keys of their own context.
import { fileTabId } from '@shared/file-tabs'
import { findBinding, type CommandId, type KeyLike } from '@shared/shortcuts'
import { getBuffer } from '@/components/editor/buffers'
import { send } from '@/lib/host-client'
import { visibleProjects } from '@/lib/project-groups'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { useApp } from '@/store/app-store'

type State = ReturnType<typeof useApp.getState>

/** True if the action did something: only then is the event stopped (preventDefault). */
type Action = (state: State) => boolean

/** Without `tab` it opens on the last used tab or closes the panel. */
const inspector = (tab?: 'changes' | 'files' | 'history' | 'merge'): Action => (state) => {
  const projectId = state.selection.projectId
  if (!projectId) return false
  state.toggleInspector(projectId, tab)
  return true
}

const selectProject =
  (position: number): Action =>
  (state) => {
    // The order is the one visible in the sidebar: closed sections don't count.
    const project = visibleProjects(state.projects, state.projectGroups, state.selection.projectId)[position - 1]
    if (!project) return false
    state.selectProject(project.id)
    return true
  }

/** Actions of the 'global' context commands. The menu ones (app.openSettings, window.close) are handled by main. */
const ACTIONS: Partial<Record<CommandId, Action>> = {
  'palette.toggle': (state) => {
    state.setQuickOpen(false)
    state.setPaletteOpen(!state.paletteOpen)
    return true
  },
  'quickOpen.toggle': (state) => {
    state.toggleQuickOpen()
    return true
  },
  'sidebar.toggle': (state) => {
    state.toggleSidebar()
    return true
  },
  'nav.back': (state) => {
    state.navigate(-1)
    return true
  },
  'nav.forward': (state) => {
    state.navigate(1)
    return true
  },
  'chat.new': (state) => {
    state.select({ kind: 'new', projectId: state.selection.projectId })
    return true
  },
  // New session from an issue, a PR or a branch.
  'chat.newFrom': (state) => {
    if (state.selection.projectId) state.setNewFromOpen(true)
    return true
  },
  // Side by side: the open session and another chat next to each other.
  'chat.split': (state) => {
    state.splitActive()
    return true
  },
  'project.select1': selectProject(1),
  'project.select2': selectProject(2),
  'project.select3': selectProject(3),
  'project.select4': selectProject(4),
  'project.select5': selectProject(5),
  'project.select6': selectProject(6),
  'project.select7': selectProject(7),
  'project.select8': selectProject(8),
  'project.select9': selectProject(9),
  // Column to the left or right among the side-by-side sessions.
  'column.focusLeft': (state) => state.focusColumn(-1),
  'column.focusRight': (state) => state.focusColumn(1),
  // Move the active tab.
  'tab.moveLeft': (state) => Boolean(state.selection.projectId && state.moveActiveTab(state.selection.projectId, -1)),
  'tab.moveRight': (state) => Boolean(state.selection.projectId && state.moveActiveTab(state.selection.projectId, 1)),
  // Next and previous tab of the project, cycling (chat then files, as in the bar).
  'tab.next': (state) => Boolean(state.selection.projectId && state.cycleTab(state.selection.projectId, 1)),
  'tab.previous': (state) => Boolean(state.selection.projectId && state.cycleTab(state.selection.projectId, -1)),
  // Reopen the project's last closed tab.
  'tab.reopenClosed': (state) => Boolean(state.selection.projectId && state.reopenClosedTab(state.selection.projectId)),
  // There is no search in file contents yet: opens the Files panel with focus on the name filter.
  'search.project': (state) => {
    if (!state.selection.projectId) return false
    state.searchInProject(state.selection.projectId)
    return true
  },
  'tab.close': (state) => {
    const current = state.selection
    if (current.kind === 'session') state.closeTab(current.projectId, current.sessionId)
    else if (current.kind === 'file') state.closeFile(current.projectId, current.root, current.path)
    else return false
    return true
  },
  'inspector.changes': inspector('changes'),
  'inspector.files': inspector('files'),
  'inspector.history': inspector('history'),
  'inspector.merge': inspector('merge'),
  // Right panel: opens on the last used tab or closes.
  'inspector.toggle': inspector(),
  // Project terminal panel. The event is always stopped; with the palette open (see ALWAYS_ACTIVE) it does nothing.
  'terminal.toggle': (state) => {
    const projectId = state.selection.projectId
    if (!projectId || state.paletteOpen || state.quickOpen) return true
    const open = Boolean(state.ui[projectId]?.terminal?.open)
    if (!open) focusNextTerminal()
    state.setTerminalPanel(projectId, { open: !open })
    return true
  },
  'file.save': (state) => {
    const current = state.selection
    if (current.kind !== 'file') return false
    getBuffer(fileTabId(current.root, current.path))?.onSave()
    return true
  },
  // Next session waiting for you, in any project.
  'session.nextWaiting': (state) => {
    state.goToNextWaiting()
    return true
  },
  'session.interrupt': (state) => {
    const current = state.selection
    if (current.kind !== 'session') return false
    send({ type: 'session.interrupt', sessionId: current.sessionId })
    return true
  }
}

/** With the palette or file search open, the other shortcuts wait: they would act beneath the dialog. */
const ALWAYS_ACTIVE = new Set<CommandId>(['palette.toggle', 'quickOpen.toggle', 'terminal.toggle'])

/** True if focus is where you type: text field, textarea, contenteditable (code editor) or terminal (xterm uses a textarea). */
function typingInField(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(el.type)
  return el.closest('.xterm') !== null || el.getAttribute('role') === 'textbox'
}

/** Window keydown listener (and of shortcuts forwarded by main when the browser page has focus): finds the global command the event triggers and runs it. */
export function handleGlobalKeydown(event: KeyLike & { preventDefault?: () => void }): void {
  const binding = findBinding(event, 'global')
  const action = binding && ACTIONS[binding.id]
  if (!binding || !action) return
  // A shortcut without ⌘/⌃/⌥ (no modifier or only ⇧) is a character like any other: it doesn't fire while typing.
  const { ctrl, meta, alt } = binding.chord
  if (!ctrl && !meta && !alt && typingInField()) return
  const state = useApp.getState()
  if ((state.paletteOpen || state.quickOpen) && !ALWAYS_ACTIVE.has(binding.id)) return
  if (action(state)) event.preventDefault?.()
}
