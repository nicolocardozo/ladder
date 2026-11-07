// Stato del renderer: copia di ciò che l'host pubblica più lo stato dell'interfaccia (selezione, cartelle aperte).
import { create } from 'zustand'
import { request, send } from '@/lib/host-client'
import type { AgentStatus, AppPrefs, ChatItem, DiffScope, HostEvent, InspectorTab, IssueItem, Project, ProjectUiState, SessionSummary, TerminalInfo } from '@shared/protocol'
import { isConcluded, CONCLUDED_AFTER_MS } from '@/lib/session-state'
import { routeTerminalData } from '@/lib/terminal-registry'

export type Selection = { kind: 'new'; projectId: string | null } | { kind: 'session'; projectId: string; sessionId: string }

interface AppState {
  connected: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  items: Record<string, ChatItem[]>
  drafts: Record<string, string>
  ui: Record<string, ProjectUiState>
  agents: AgentStatus[]
  selection: Selection
  expanded: string[]
  /** Primo elemento non letto quando la sessione è stata aperta, per il divisore "Nuovo". */
  firstUnread: Record<string, number | null>
  /** Sidebar visibile. Si ricorda tra un avvio e l'altro. */
  sidebarOpen: boolean
  paletteOpen: boolean
  /** Sessione con il titolo in modifica nella sidebar. */
  renaming: string | null
  /** Sessione aperta che l'utente ha segnato come da leggere: la vista non deve rileggerla finché non cambia la selezione. */
  heldUnread: string | null
  /** Cronologia delle selezioni per Indietro/Avanti; `historyIndex` punta alla selezione corrente. */
  history: Selection[]
  historyIndex: number
  terminals: Record<string, TerminalInfo>
  /** Contatore per cartella: cresce quando l'host segnala un cambiamento, e le viste rileggono. */
  fsVersion: Record<string, number>
  /** Ultima richiesta di apertura dell'ispettore: un file nel viewer o un ambito del diff. */
  inspectorRequest: InspectorRequest | null
  /** Testo da inserire nel composer con la chiave indicata (Aggiungi alla chat, @terminal). */
  composerInsert: { key: string; text: string; nonce: number } | null
  quickOpen: boolean
  /** Elemento da raggiungere all'apertura della sessione (⌘⇧A, notifica, ricerca): la vista scorre lì e mette il focus. */
  focusTarget: { sessionId: string; itemId: string | null; nonce: number } | null
  /** Popover "In attesa" della sidebar. */
  inboxOpen: boolean
  /** Finestra "Nuova sessione da…" (⌘⇧N). */
  newFromOpen: boolean
  /** Issue, PR o branch scelto per la nuova chat del progetto. */
  newSource: { projectId: string; item: IssueItem } | null
  /** Riepilogo "Mentre eri via" per progetto, calcolato quando torni dopo più di 30 minuti. */
  away: Record<string, AwaySummary>
  prefs: AppPrefs | null
  applyEvent: (event: HostEvent) => void
  select: (selection: Selection) => void
  toggleProject: (projectId: string) => void
  setDraft: (key: string, text: string) => void
  setUi: (projectId: string, state: ProjectUiState) => void
  closeTab: (projectId: string, sessionId: string) => void
  /** Torna su un progetto: riapre la tab attiva che aveva, oppure la nuova chat. */
  selectProject: (projectId: string) => void
  toggleSidebar: () => void
  setPaletteOpen: (open: boolean) => void
  /** Avvia la modifica del titolo: apre la sidebar e il progetto se servono. */
  startRename: (sessionId: string) => void
  stopRename: () => void
  /** Indietro (-1) o avanti (+1) nella cronologia, saltando le sessioni archiviate. */
  navigate: (delta: -1 | 1) => void
  /** Archivia: la riga sparisce, la tab si chiude e, se era aperta, si passa alla tab vicina o alla nuova chat. */
  archiveSession: (sessionId: string) => void
  /** Toglie il progetto da Ladder (i file restano). Le sue sessioni vengono archiviate, così si fermano. */
  removeProject: (projectId: string) => Promise<void>
  /** Apre la prossima sessione in attesa dopo quella corrente. Restituisce false se non ce ne sono. */
  goToNextWaiting: () => boolean
  markUnread: (sessionId: string) => void
  markRead: (sessionId: string) => void
  /** Apre l'ispettore del progetto su una scheda, con un file o un ambito del diff. */
  openInspector: (projectId: string, tab: InspectorTab, extra?: Omit<InspectorRequest, 'projectId' | 'tab' | 'nonce'>) => void
  /** Apre o chiude l'ispettore; con `tab` diversa da quella aperta cambia scheda. */
  toggleInspector: (projectId: string, tab?: InspectorTab) => void
  setTerminalPanel: (projectId: string, patch: Partial<NonNullable<ProjectUiState['terminal']>>) => void
  insertIntoComposer: (key: string, text: string) => void
  setQuickOpen: (open: boolean) => void
  /** Apre la sessione (nel suo progetto e nella sua tab) e chiede alla vista di raggiungere l'elemento. */
  openSessionAt: (sessionId: string, itemId: string | null) => boolean
  consumeFocus: (nonce: number) => void
  setInboxOpen: (open: boolean) => void
  setNewFromOpen: (open: boolean) => void
  setNewSource: (source: { projectId: string; item: IssueItem } | null) => void
  /** Hai lasciato il progetto (o la finestra): da qui parte il conto di "Mentre eri via". */
  markSeen: (projectId: string) => void
  /** Sei tornato sul progetto: se eri via da più di 30 minuti, prepara il riepilogo. */
  checkAway: (projectId: string) => void
  dismissAway: (projectId: string) => void
  setPrefs: (prefs: AppPrefs) => void
}

export interface AwaySummary {
  since: number
  replies: number
  requests: number
  errors: number
  concluded: number
}

/** Oltre questa assenza, tornando sul progetto compare "Mentre eri via". */
export const AWAY_MS = 30 * 60_000

export interface InspectorRequest {
  projectId: string
  tab: InspectorTab
  path?: string
  line?: number
  scope?: DiffScope
  nonce: number
}

export const DEFAULT_TERMINAL_HEIGHT = 260

const MAX_TABS = 8
const MAX_HISTORY = 50
const SIDEBAR_KEY = 'ladder.sidebar'

// Un timer per progetto: due progetti cambiati a breve distanza non si sovrascrivono il salvataggio.
const uiTimers = new Map<string, number>()
function persistUi(projectId: string, state: ProjectUiState): void {
  const timer = uiTimers.get(projectId)
  if (timer) window.clearTimeout(timer)
  uiTimers.set(
    projectId,
    window.setTimeout(() => {
      uiTimers.delete(projectId)
      send({ type: 'ui.set', projectId, state })
    }, 300)
  )
}
const emptyUi = (): ProjectUiState => ({ tabs: [], activeTab: null, scroll: {} })
let nonce = 0

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  } catch {
    return true
  }
}

function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed')
  } catch {
    // Solo una comodità: senza storage la sidebar torna visibile al prossimo avvio.
  }
}

function mergeItems(current: ChatItem[] | undefined, incoming: ChatItem[]): ChatItem[] {
  if (!current || current.length === 0) return [...incoming].sort((a, b) => a.seq - b.seq)
  const byId = new Map(current.map((item) => [item.id, item]))
  let appended = false
  for (const item of incoming) {
    if (!byId.has(item.id)) appended = true
    byId.set(item.id, item)
  }
  const merged = [...byId.values()]
  return appended ? merged.sort((a, b) => a.seq - b.seq) : merged
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  return a.kind === b.kind && a.projectId === b.projectId
}

/** Sessione visibile: non archiviata e con il progetto ancora presente. */
export function isLiveSession(state: Pick<AppState, 'projects'>, session: SessionSummary | undefined): session is SessionSummary {
  return Boolean(session && !session.archived && state.projects.some((p) => p.id === session.projectId))
}

function isValidEntry(state: Pick<AppState, 'projects' | 'sessions'>, entry: Selection): boolean {
  if (entry.kind === 'session') return isLiveSession(state, state.sessions[entry.sessionId])
  return entry.projectId === null ? state.projects.length === 0 : state.projects.some((p) => p.id === entry.projectId)
}

/** Aggiunge `next` dopo la voce corrente, scartando quelle in avanti. Niente doppioni consecutivi. */
function pushHistory(state: AppState, next: Selection): Pick<AppState, 'history' | 'historyIndex'> {
  let entries = state.history.slice(0, state.historyIndex + 1)
  const last = entries[entries.length - 1]
  if (!last || !sameSelection(last, state.selection)) entries.push(state.selection)
  if (!sameSelection(entries[entries.length - 1], next)) entries.push(next)
  if (entries.length > MAX_HISTORY) entries = entries.slice(entries.length - MAX_HISTORY)
  return { history: entries, historyIndex: entries.length - 1 }
}

/** Cronologia senza le voci non più raggiungibili (sessioni archiviate, progetti rimossi). */
function cleanHistory(state: AppState): { history: Selection[]; index: number } {
  let entries = state.history
  let index = state.historyIndex
  const current = entries[index]
  if (!current || !sameSelection(current, state.selection)) {
    entries = [...entries.slice(0, index + 1), state.selection]
    index = entries.length - 1
  }
  const kept: Selection[] = []
  let keptIndex = 0
  entries.forEach((entry, i) => {
    const isCurrent = i === index
    if (!isCurrent && !isValidEntry(state, entry)) return
    const last = kept[kept.length - 1]
    if (!last || !sameSelection(last, entry)) kept.push(entry)
    if (isCurrent) keptIndex = kept.length - 1
  })
  return { history: kept, index: keptIndex }
}

export function canNavigate(state: AppState, delta: -1 | 1): boolean {
  const { history, index } = cleanHistory(state)
  const target = index + delta
  return target >= 0 && target < history.length
}

/** Effetti di una selezione su tab, cartelle aperte e divisore "Nuovo". Non tocca la cronologia. */
function selectionPatch(state: AppState, selection: Selection): Partial<AppState> {
  if (selection.kind !== 'session') return { selection, heldUnread: null }
  const session = state.sessions[selection.sessionId]
  const firstUnread = { ...state.firstUnread }
  // Il divisore "Nuovo" si calcola all'apertura e resta fermo finché la sessione è aperta.
  if (session && !(selection.sessionId in firstUnread)) firstUnread[selection.sessionId] = session.unread ? session.lastReadSeq + 1 : null
  const expanded = state.expanded.includes(selection.projectId) ? state.expanded : [...state.expanded, selection.projectId]
  // La sessione aperta diventa una tab del suo progetto; oltre 8 tab si chiude la meno recente.
  const ui = state.ui[selection.projectId] ?? emptyUi()
  let tabs = ui.tabs.includes(selection.sessionId) ? ui.tabs : [...ui.tabs, selection.sessionId]
  if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS)
  const nextUi = { ...ui, tabs, activeTab: selection.sessionId }
  persistUi(selection.projectId, nextUi)
  return { selection, firstUnread, expanded, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null }
}

/** Sessioni nell'ordine della sidebar: progetti in ordine, poi la più recente in alto. */
function sidebarOrder(state: AppState): SessionSummary[] {
  const rank = new Map(state.projects.map((p, i) => [p.id, i]))
  return Object.values(state.sessions)
    .filter((s) => isLiveSession(state, s))
    .sort((a, b) => rank.get(a.projectId)! - rank.get(b.projectId)! || b.createdAt - a.createdAt)
}

export const useApp = create<AppState>((set, get) => ({
  connected: false,
  projects: [],
  sessions: {},
  items: {},
  drafts: {},
  ui: {},
  agents: [],
  selection: { kind: 'new', projectId: null },
  expanded: [],
  firstUnread: {},
  sidebarOpen: readSidebarOpen(),
  paletteOpen: false,
  renaming: null,
  heldUnread: null,
  history: [],
  historyIndex: -1,
  terminals: {},
  fsVersion: {},
  inspectorRequest: null,
  composerInsert: null,
  quickOpen: false,
  focusTarget: null,
  inboxOpen: false,
  newFromOpen: false,
  newSource: null,
  away: {},
  prefs: null,

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case 'snapshot': {
          const sessions: Record<string, SessionSummary> = {}
          for (const s of event.sessions) sessions[s.id] = s
          const firstProject = event.projects[0]?.id ?? null
          const selection =
            state.selection.kind === 'new' && !state.selection.projectId ? { kind: 'new' as const, projectId: firstProject } : state.selection
          const terminals: Record<string, TerminalInfo> = {}
          for (const t of event.terminals) terminals[t.id] = t
          return {
            connected: true,
            projects: event.projects,
            sessions,
            drafts: event.drafts,
            ui: event.ui,
            agents: event.agents,
            terminals,
            selection,
            expanded: state.expanded.length ? state.expanded : firstProject ? [firstProject] : []
          }
        }
        case 'project.upsert': {
          const exists = state.projects.some((p) => p.id === event.project.id)
          return {
            projects: exists ? state.projects.map((p) => (p.id === event.project.id ? event.project : p)) : [...state.projects, event.project]
          }
        }
        case 'project.removed': {
          const projects = state.projects.filter((p) => p.id !== event.projectId)
          const expanded = state.expanded.filter((id) => id !== event.projectId)
          if (state.selection.projectId !== event.projectId) return { projects, expanded }
          // La selezione era nel progetto rimosso: si passa alla nuova chat del primo progetto rimasto.
          const selection: Selection = { kind: 'new', projectId: projects[0]?.id ?? null }
          return { projects, expanded, selection, ...pushHistory(state, selection) }
        }
        case 'session.upsert': {
          const before = state.sessions[event.session.id]
          // Archiviata dall'host (per esempio a PR unita): la tab si chiude come per un archivio dalla UI.
          if (event.session.archived && before && !before.archived) queueMicrotask(() => useApp.getState().closeTab(event.session.projectId, event.session.id))
          return { sessions: { ...state.sessions, [event.session.id]: event.session } }
        }
        case 'session.items':
          return {
            items: {
              ...state.items,
              [event.sessionId]: event.replace ? [...event.items].sort((a, b) => a.seq - b.seq) : mergeItems(state.items[event.sessionId], event.items)
            }
          }
        case 'agent.status':
          return { agents: [...state.agents.filter((a) => a.agent !== event.status.agent), event.status] }
        case 'terminal.upsert':
          return { terminals: { ...state.terminals, [event.terminal.id]: event.terminal } }
        case 'terminal.removed': {
          const terminals = { ...state.terminals }
          delete terminals[event.id]
          return { terminals }
        }
        case 'terminal.data':
          // L'output va direttamente a xterm: passare dallo store rifarebbe il rendering a ogni carattere.
          routeTerminalData(event.id, event.data)
          return {}
        case 'fs.changed':
          return { fsVersion: { ...state.fsVersion, [event.root]: (state.fsVersion[event.root] ?? 0) + 1 } }
      }
      return {}
    }),

  select: (selection) =>
    set((state) => {
      const patch = selectionPatch(state, selection)
      return sameSelection(state.selection, selection) ? patch : { ...patch, ...pushHistory(state, selection) }
    }),

  toggleProject: (projectId) =>
    set((state) => ({
      expanded: state.expanded.includes(projectId) ? state.expanded.filter((id) => id !== projectId) : [...state.expanded, projectId]
    })),

  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  setUi: (projectId, uiState) => set((state) => ({ ui: { ...state.ui, [projectId]: uiState } })),

  closeTab: (projectId, sessionId) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const index = ui.tabs.indexOf(sessionId)
      // Le tab di sessioni archiviate o sparite si tolgono insieme a questa.
      const tabs = ui.tabs.filter((id) => id !== sessionId && isLiveSession(state, state.sessions[id]))
      const wasActive = state.selection.kind === 'session' && state.selection.sessionId === sessionId
      const nextActive = wasActive ? (tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null) : ui.activeTab === sessionId ? null : ui.activeTab
      const nextUi = { ...ui, tabs, activeTab: nextActive }
      persistUi(projectId, nextUi)
      const next = { ...state, ui: { ...state.ui, [projectId]: nextUi } }
      if (!wasActive) return { ui: next.ui }
      const selection: Selection = nextActive ? { kind: 'session', projectId, sessionId: nextActive } : { kind: 'new', projectId }
      return { ui: next.ui, ...selectionPatch(next, selection), ...pushHistory(state, selection) }
    }),

  selectProject: (projectId) => {
    const state = get()
    const active = state.ui[projectId]?.activeTab
    if (active && isLiveSession(state, state.sessions[active])) state.select({ kind: 'session', projectId, sessionId: active })
    else state.select({ kind: 'new', projectId })
  },

  toggleSidebar: () =>
    set((state) => {
      writeSidebarOpen(!state.sidebarOpen)
      return { sidebarOpen: !state.sidebarOpen }
    }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  startRename: (sessionId) =>
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return {}
      if (!state.sidebarOpen) writeSidebarOpen(true)
      const expanded = state.expanded.includes(session.projectId) ? state.expanded : [...state.expanded, session.projectId]
      return { renaming: sessionId, sidebarOpen: true, expanded }
    }),

  stopRename: () => set({ renaming: null }),

  navigate: (delta) =>
    set((state) => {
      const { history, index } = cleanHistory(state)
      const target = index + delta
      if (target < 0 || target >= history.length) return { history, historyIndex: index }
      return { ...selectionPatch(state, history[target]), history, historyIndex: target }
    }),

  archiveSession: (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session) return
    // Ottimista: la riga sparisce subito, l'host conferma con session.upsert.
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...session, archived: true } } }))
    get().closeTab(session.projectId, sessionId)
    request({ type: 'session.archive', sessionId }).catch(() => {
      set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], archived: false } } }))
    })
  },

  removeProject: async (projectId) => {
    // Senza progetto le sessioni non sono più raggiungibili: si archiviano, così l'host chiude i processi.
    for (const session of Object.values(get().sessions)) {
      if (session.projectId === projectId && !session.archived) send({ type: 'session.archive', sessionId: session.id })
    }
    await request({ type: 'project.remove', projectId })
  },

  goToNextWaiting: () => {
    const state = get()
    // In ordine di arrivo: la richiesta più vecchia per prima, in qualunque progetto.
    const waiting = sidebarOrder(state)
      .filter((s) => s.run === 'waiting')
      .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
    if (waiting.length === 0) return false
    const { selection } = state
    const current = selection.kind === 'session' ? waiting.findIndex((s) => s.id === selection.sessionId) : -1
    const next = waiting[(current + 1) % waiting.length]
    return state.openSessionAt(next.id, next.request?.id ?? null)
  },

  markUnread: (sessionId) => {
    const { selection } = get()
    if (selection.kind === 'session' && selection.sessionId === sessionId) set({ heldUnread: sessionId })
    send({ type: 'session.unread', sessionId })
  },

  markRead: (sessionId) => {
    if (get().heldUnread === sessionId) set({ heldUnread: null })
    send({ type: 'session.read', sessionId })
  },

  openInspector: (projectId, tab, extra = {}) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const nextUi = { ...ui, inspector: { open: true, tab } }
      persistUi(projectId, nextUi)
      return { ui: { ...state.ui, [projectId]: nextUi }, inspectorRequest: { projectId, tab, ...extra, nonce: ++nonce } }
    }),

  toggleInspector: (projectId, tab) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const current = ui.inspector ?? { open: false, tab: 'changes' as InspectorTab }
      const open = tab && current.open && current.tab !== tab ? true : !current.open
      const nextUi = { ...ui, inspector: { open, tab: tab ?? current.tab } }
      persistUi(projectId, nextUi)
      return { ui: { ...state.ui, [projectId]: nextUi } }
    }),

  setTerminalPanel: (projectId, patch) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const current = ui.terminal ?? { open: false, height: DEFAULT_TERMINAL_HEIGHT, active: null }
      const nextUi = { ...ui, terminal: { ...current, ...patch } }
      persistUi(projectId, nextUi)
      return { ui: { ...state.ui, [projectId]: nextUi } }
    }),

  insertIntoComposer: (key, text) => set({ composerInsert: { key, text, nonce: ++nonce } }),
  setQuickOpen: (open) => set({ quickOpen: open }),

  openSessionAt: (sessionId, itemId) => {
    const state = get()
    const session = state.sessions[sessionId]
    if (!isLiveSession(state, session)) return false
    set({ focusTarget: { sessionId, itemId, nonce: ++nonce }, inboxOpen: false })
    state.select({ kind: 'session', projectId: session.projectId, sessionId })
    return true
  },
  consumeFocus: (value) => set((state) => (state.focusTarget?.nonce === value ? { focusTarget: null } : {})),
  setInboxOpen: (open) => set({ inboxOpen: open }),
  setNewFromOpen: (open) => set({ newFromOpen: open }),
  setNewSource: (source) => set({ newSource: source }),

  markSeen: (projectId) =>
    set((state) => {
      if (!state.projects.some((p) => p.id === projectId)) return {}
      const ui = state.ui[projectId] ?? emptyUi()
      const nextUi = { ...ui, seenAt: Date.now() }
      persistUi(projectId, nextUi)
      return { ui: { ...state.ui, [projectId]: nextUi } }
    }),

  checkAway: (projectId) =>
    set((state) => {
      const seen = state.ui[projectId]?.seenAt
      const now = Date.now()
      if (!seen || now - seen < AWAY_MS) return {}
      const list = Object.values(state.sessions).filter((s) => s.projectId === projectId && isLiveSession(state, s))
      const summary: AwaySummary = {
        since: seen,
        replies: list.filter((s) => s.unread && s.run !== 'error' && s.activityAt > seen).length,
        requests: list.filter((s) => s.run === 'waiting').length,
        errors: list.filter((s) => s.run === 'error' && s.activityAt > seen).length,
        // Scese in "Concluse" mentre non c'eri: l'ultima attività ha superato i 3 giorni dopo la tua ultima visita.
        concluded: list.filter((s) => isConcluded(s, Boolean(state.drafts[s.id]?.trim()), now) && Math.max(s.activityAt, s.createdAt) + CONCLUDED_AFTER_MS > seen).length
      }
      if (summary.replies + summary.requests + summary.errors + summary.concluded === 0) return {}
      return { away: { ...state.away, [projectId]: summary } }
    }),

  dismissAway: (projectId) =>
    set((state) => {
      if (!(projectId in state.away)) return {}
      const away = { ...state.away }
      delete away[projectId]
      return { away }
    }),

  setPrefs: (prefs) => set({ prefs })
}))
