// Scorciatoie globali: il registro (shared/shortcuts.ts) dice quale tasto fa cosa, qui stanno le azioni.
// Un solo ascoltatore di keydown per tutta la finestra; composer, editor e terminale leggono lo stesso registro
// per i tasti del proprio contesto.
import { fileTabId } from '@shared/file-tabs'
import { findBinding, type CommandId, type KeyLike } from '@shared/shortcuts'
import { getBuffer } from '@/components/editor/buffers'
import { send } from '@/lib/host-client'
import { visibleProjects } from '@/lib/project-groups'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { useApp } from '@/store/app-store'

type State = ReturnType<typeof useApp.getState>

/** Vero se l'azione ha fatto qualcosa: solo allora l'evento si ferma (preventDefault). */
type Action = (state: State) => boolean

const inspector = (tab: 'changes' | 'files' | 'history' | 'merge'): Action => (state) => {
  const projectId = state.selection.projectId
  if (!projectId) return false
  state.toggleInspector(projectId, tab)
  return true
}

const selectProject =
  (position: number): Action =>
  (state) => {
    // L'ordine è quello che si vede nella sidebar: le sezioni chiuse non contano.
    const project = visibleProjects(state.projects, state.projectGroups, state.selection.projectId)[position - 1]
    if (!project) return false
    state.selectProject(project.id)
    return true
  }

/** Azioni dei comandi di contesto 'global'. Quelli del menu (app.openSettings, window.close) li gestisce main. */
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
  // Nuova sessione da una issue, una PR o un branch.
  'chat.newFrom': (state) => {
    if (state.selection.projectId) state.setNewFromOpen(true)
    return true
  },
  // Affianca: la sessione aperta e un'altra chat una accanto all'altra.
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
  // Colonna a sinistra o a destra tra le sessioni affiancate.
  'column.focusLeft': (state) => state.focusColumn(-1),
  'column.focusRight': (state) => state.focusColumn(1),
  // Sposta la tab attiva.
  'tab.moveLeft': (state) => Boolean(state.selection.projectId && state.moveActiveTab(state.selection.projectId, -1)),
  'tab.moveRight': (state) => Boolean(state.selection.projectId && state.moveActiveTab(state.selection.projectId, 1)),
  // Tab successiva e precedente del progetto, in ciclo (chat e poi file, come nella barra).
  'tab.next': (state) => Boolean(state.selection.projectId && state.cycleTab(state.selection.projectId, 1)),
  'tab.previous': (state) => Boolean(state.selection.projectId && state.cycleTab(state.selection.projectId, -1)),
  // Riapre l'ultima tab chiusa del progetto.
  'tab.reopenClosed': (state) => Boolean(state.selection.projectId && state.reopenClosedTab(state.selection.projectId)),
  // Non c'è ancora una ricerca nel contenuto dei file: apre il pannello File con il focus sul filtro per nome.
  'search.project': (state) => {
    if (!state.selection.projectId) return false
    state.searchInProject(state.selection.projectId)
    return true
  },
  'tab.close': (state) => {
    const current = state.selection
    if (current.kind === 'session') state.closeTab(current.projectId, current.sessionId)
    else if (current.kind === 'file') state.closeFile(current.projectId, current.root, current.path)
    else if (current.kind === 'browser') state.closeBrowser(current.projectId, current.tabId)
    else return false
    return true
  },
  'inspector.changes': inspector('changes'),
  'inspector.files': inspector('files'),
  'inspector.history': inspector('history'),
  'inspector.merge': inspector('merge'),
  // Pannello terminale del progetto. Si ferma sempre l'evento; con la palette aperta (vedi ALWAYS_ACTIVE) non fa nulla.
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
  // Prossima sessione che ti aspetta, in qualunque progetto.
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

/** Con la palette o la ricerca file aperte le altre scorciatoie aspettano: agirebbero sotto la finestra di dialogo. */
const ALWAYS_ACTIVE = new Set<CommandId>(['palette.toggle', 'quickOpen.toggle', 'terminal.toggle'])

/** Vero se il focus è dove si scrive: campo di testo, area di testo, contenteditable (editor di codice) o terminale (xterm usa una textarea). */
function typingInField(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(el.type)
  return el.closest('.xterm') !== null || el.getAttribute('role') === 'textbox'
}

/** Ascoltatore di keydown della finestra (e delle scorciatoie inoltrate dal main quando la pagina del browser ha il focus): cerca il comando globale che l'evento attiva e lo esegue. */
export function handleGlobalKeydown(event: KeyLike & { preventDefault?: () => void }): void {
  const binding = findBinding(event, 'global')
  const action = binding && ACTIONS[binding.id]
  if (!binding || !action) return
  // Una scorciatoia senza ⌘/⌃/⌥ (nessun modificatore o solo ⇧) è un carattere come un altro: mentre si scrive non scatta.
  const { ctrl, meta, alt } = binding.chord
  if (!ctrl && !meta && !alt && typingInField()) return
  const state = useApp.getState()
  if ((state.paletteOpen || state.quickOpen) && !ALWAYS_ACTIVE.has(binding.id)) return
  if (action(state)) event.preventDefault?.()
}
