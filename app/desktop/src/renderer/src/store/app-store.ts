// Stato del renderer: copia di ciò che l'host pubblica più lo stato dell'interfaccia (selezione, cartelle aperte).
import { create } from 'zustand'
import { isElectron, onHostConnect, request, send } from '@/lib/host-client'
import { applyProjectGroupOp, normalizeProjectGroups, type ProjectGroupOp } from '@/lib/project-groups'
import type { AgentBrowserState, AgentStatus, AppPrefs, Attachment, BrowserState, ShortcutsState, ChatItem, ConnectionId, ConnectionStatus, Profile, ReviewState, SlashCommand, DiffScope, GitStatus, HostCommand, HostEvent, InspectorTab, IssueItem, Project, ProjectGroupsState, ProjectUiState, SessionPreset, SessionSummary, TerminalInfo } from '@shared/protocol'
import { isConcluded, CONCLUDED_AFTER_MS } from '@/lib/session-state'
import { routeTerminalData } from '@/lib/terminal-registry'
import { disposeBuffer } from '@/components/editor/buffers'
import { fileTabId, parseFileTab } from '@shared/file-tabs'
import { clipTitle, isBrowserTabId, newBrowserTabId, storableUrl } from '@/lib/browser-tabs'
import { agentTabSession, hasAgentTab, isAgentTabId } from '@/lib/browser-agent'
import { applyShortcutConfig } from '@shared/shortcuts'
import { plural, t } from '@shared/i18n'
import { useSettings } from '@/hooks/use-theme'
import { isDefaultProfileId } from '@/lib/profile-id'

/** Stati degli agenti dallo snapshot: il predefinito di ciascuno in `agents`, gli altri profili per id. */
function splitAgents(list: AgentStatus[]): Pick<AppState, 'agents' | 'profileAgents'> {
  const profileAgents: Record<string, AgentStatus> = {}
  const agents: AgentStatus[] = []
  for (const status of list) {
    if (isDefaultProfileId(status.profileId)) agents.push(status)
    else profileAgents[status.profileId!] = status
  }
  return { agents, profileAgents }
}

function splitConnections(list: ConnectionStatus[]): Pick<AppState, 'connections' | 'profileConnections'> {
  const connections: Partial<Record<ConnectionId, ConnectionStatus>> = {}
  const profileConnections: Record<string, ConnectionStatus> = {}
  for (const status of list) {
    if (isDefaultProfileId(status.profileId)) connections[status.id] = status
    else profileConnections[status.profileId!] = status
  }
  return { connections, profileConnections }
}

export type Selection =
  | { kind: 'new'; projectId: string | null }
  | { kind: 'session'; projectId: string; sessionId: string }
  | { kind: 'file'; projectId: string; root: string; path: string }
  | { kind: 'browser'; projectId: string; tabId: string }

interface AppState {
  connected: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  items: Record<string, ChatItem[]>
  drafts: Record<string, string>
  /** Comandi / dichiarati dall'agente, per sessione. Assente: non ancora caricati. */
  commands: Record<string, SlashCommand[]>
  ui: Record<string, ProjectUiState>
  /** Stato degli agenti col profilo predefinito (uno per agente). Gli altri profili stanno in `profileAgents`. */
  agents: AgentStatus[]
  /** Profili di Claude Code e Codex (LAD-23), predefiniti compresi. Vuoto nelle fixture: vale "solo i predefiniti" (vedi lib/profiles.ts). */
  profiles: Profile[]
  /** Stato degli agenti per i profili non predefiniti, per id del profilo: account, modelli e limiti sono suoi. */
  profileAgents: Record<string, AgentStatus>
  /** Dice anche il progetto selezionato: tab, file, terminale e nuova chat seguono lui. */
  selection: Selection
  /** Primo elemento non letto quando la sessione è stata aperta, per il divisore "Nuovo". */
  firstUnread: Record<string, number | null>
  /** Sidebar visibile. Si ricorda tra un avvio e l'altro. */
  sidebarOpen: boolean
  paletteOpen: boolean
  /** Sessione con il titolo in modifica nella sidebar. */
  renaming: string | null
  /** Gruppo con il nome in modifica nella sidebar. */
  renamingGroup: string | null
  /** Sezioni di progetti nella sidebar. Null: nessuna sezione (fixture e host che non le conoscono), tutti i progetti in ordine. */
  projectGroups: ProjectGroupsState | null
  /** Sezione con il nome in modifica nella sidebar. */
  renamingProjectGroup: string | null
  /** Ultimo errore di un comando della sidebar (sezioni di progetti, rigenerazione del titolo), già tradotto dall'host. Si toglie da solo dopo 6 s. */
  sidebarNotice: string | null
  /** 'error' per un comando fallito (rosa), 'info' per un'informazione (tenue), per esempio le sessioni archiviate in automatico. */
  sidebarNoticeTone: 'error' | 'info'
  /** File aperti come tab con modifiche non salvate, per id della tab. */
  dirtyFiles: Record<string, boolean>
  /** File di cui si sta chiudendo la tab con modifiche non salvate: si chiede cosa fare. */
  closingFile: { projectId: string; root: string; path: string } | null
  /** Sessione aperta che l'utente ha segnato come da leggere: la vista non deve rileggerla finché non cambia la selezione. */
  heldUnread: string | null
  /** Cronologia delle selezioni per Indietro/Avanti; `historyIndex` punta alla selezione corrente. */
  history: Selection[]
  historyIndex: number
  terminals: Record<string, TerminalInfo>
  /** Contatore per cartella: cresce quando l'host segnala un cambiamento, e le viste rileggono. */
  fsVersion: Record<string, number>
  // ── LAD-68 ──
  /** Stato git leggero per cartella (chiave `GitStatus.root`), solo per le sessioni osservate con `watchGit`. */
  gitStatus: Record<string, GitStatus>
  /** Cartella git di ogni sessione osservata, nota dopo il primo `git.status`. */
  gitRoot: Record<string, string>
  /** Iscrive la sessione agli aggiornamenti git dell'intestazione (idempotente) e legge lo stato iniziale. */
  watchGit: (sessionId: string) => void
  /** Toglie l'iscrizione (idempotente). */
  unwatchGit: (sessionId: string) => void
  // ── fine LAD-68 ──
  /** Ultima richiesta di apertura dell'ispettore: un file nel viewer o un ambito del diff. */
  inspectorRequest: InspectorRequest | null
  /** Testo da inserire nel composer con la chiave indicata (Aggiungi alla chat, @terminal). */
  composerInsert: { key: string; text: string; nonce: number } | null
  /** Sostituisce la bozza di un composer già montato (profilo di sessione, ⌘⇧N); lo store e l'host li aggiorna chi chiede. */
  composerReplace: { key: string; text: string; nonce: number } | null
  replaceComposerDraft: (key: string, text: string) => void
  /** Immagini in attesa di entrare nel composer con la chiave indicata (screenshot del browser): il composer le prende appena è montato. */
  composerAttachments: Record<string, Attachment[]>
  /** Browser integrato (LAD-57): ultimo stato inviato dal main per ogni tab, anche quelle non aperte in questo momento. */
  browserStates: Record<string, BrowserState>
  /** Browser dell'agente (LAD-57 parte 2): ultimo stato intero inviato dall'host per sessione. La tab dell'agente è effimera, non sta in `ui`. */
  agentBrowser: Record<string, AgentBrowserState>
  /** sessione -> tabId della vista dell'agente che vive in un'altra finestra (`open` ha restituito null con lo stato ancora attivo): qui non si mostra. */
  agentForeign: Record<string, string>
  /** Ultimo server locale visto nel terminale di ogni progetto e non ancora aperto né scartato. */
  devServers: Record<string, { url: string; terminalId: string }>
  quickOpen: boolean
  /** Un tab è trascinato sul bordo destro o in basso della vista: mostra dove si aprirà la nuova colonna. */
  splitDrop: boolean
  /** ⌘\ senza altre chat da affiancare: la prossima sessione scelta o creata nel progetto si apre accanto a `base`. */
  pendingSplit: { projectId: string; base: string } | null
  /** Elemento da raggiungere all'apertura della sessione (⌘⇧A, notifica, ricerca): la vista scorre lì e mette il focus. */
  focusTarget: { sessionId: string; itemId: string | null; nonce: number } | null
  /** Popover "In attesa" della sidebar. */
  inboxOpen: boolean
  /** Finestra "Nuova sessione da…" (⌘⇧N). */
  newFromOpen: boolean
  /** Issue, PR o branch scelto per la nuova chat del progetto. */
  newSource: { projectId: string; item: IssueItem } | null
  /** Profilo di sessione (LAD-60) da applicare alla nuova chat del progetto: la nuova chat lo legge una volta e lo azzera. */
  newPreset: { projectId: string; presetId: string } | null
  /** Finestra "Salva come profilo" aperta da menu di sessione o ⌘K; `seed` precompila i campi, `presetId` modifica uno esistente. */
  presetEditor: { presetId?: string; seed?: Partial<SessionPreset> } | null
  /** Riepilogo "Mentre eri via" per progetto, calcolato quando torni dopo più di 30 minuti. */
  away: Record<string, AwaySummary>
  prefs: AppPrefs | null
  /** Collegamenti (Claude, Codex, GitHub). Vuoto finché l'host non li ha letti. */
  connections: Partial<Record<ConnectionId, ConnectionStatus>>
  /** Collegamenti dei profili non predefiniti (Claude Code, Codex), per id del profilo. */
  profileConnections: Record<string, ConnectionStatus>
  /** Primo avvio: `open` finché non si preme Continua o Salta, anche se nel frattempo un agente si collega. `done` fino al prossimo avvio. */
  onboarding: 'idle' | 'open' | 'done'
  /** Cresce quando GitHub si collega o si scollega: issue e pannello Merge rileggono. */
  githubVersion: number
  /** Riga di Impostazioni → Abbonamenti su cui portare il focus (dal composer o dal pannello Merge). */
  connectionFocus: { id: ConnectionId; profileId?: string | null; nonce: number } | null
  setOnboarding: (state: 'idle' | 'open' | 'done') => void
  /** "Other agents found on your Mac" nascosta con Hide: vale fino alla chiusura dell'app, non è una preferenza. */
  detectedAgentsHidden: boolean
  hideDetectedAgents: () => void
  /** Porta l'utente alla riga del collegamento in Impostazioni → Abbonamenti. */
  focusConnection: (id: ConnectionId, profileId?: string | null) => void
  consumeConnectionFocus: (nonce: number) => void
  /** Review chieste a un altro agente, per id: in corso, finite o fallite. */
  reviews: Record<string, ReviewState>
  /** Scorciatoie in uso (preset, personalizzazioni, avvisi del file). Null finché l'host non le ha mandate: valgono i predefiniti. Ogni nuovo stato fa rileggere le etichette. */
  shortcuts: ShortcutsState | null
  /** Applica lo stato delle scorciatoie al registro condiviso (ascoltatore globale, palette, tooltip, editor). */
  applyShortcuts: (state: ShortcutsState) => void
  /** Tab chiuse per progetto, la più recente in fondo (⌘⇧T). Solo in memoria, al massimo MAX_CLOSED_TABS. */
  closedTabs: Record<string, ClosedTab[]>
  /** Richiesta di mettere il focus sul filtro del pannello File (Cerca nel progetto); il pannello la consuma. */
  filesFilterFocus: { projectId: string; nonce: number } | null
  consumeFilesFilterFocus: (nonce: number) => void
  applyEvent: (event: HostEvent) => void
  /** `history: false` cambia la selezione senza aggiungere una voce a ⌘[ ⌘] (per esempio passando da una colonna all'altra). */
  select: (selection: Selection, options?: { history?: boolean }) => void
  openFile: (projectId: string, root: string, path: string) => void
  closeFile: (projectId: string, root: string, path: string, force?: boolean) => void
  cancelCloseFile: () => void
  setFileDirty: (id: string, dirty: boolean) => void
  /** Nuovo gruppo, con le sessioni indicate già dentro. */
  createGroup: (projectId: string, sessionIds?: string | string[]) => void
  renameGroup: (projectId: string, groupId: string, name: string) => void
  startRenameGroup: (groupId: string) => void
  stopRenameGroup: () => void
  deleteGroup: (projectId: string, groupId: string) => void
  toggleGroup: (projectId: string, groupId: string) => void
  moveToGroup: (projectId: string, sessionId: string, groupId: string | null) => void
  /** Sposta più sessioni insieme in un gruppo (o fuori, con null). */
  moveSessionsToGroup: (projectId: string, sessionIds: string[], groupId: string | null) => void
  /** Nuova sezione in fondo, con i progetti indicati già dentro; il nome va in modifica nella sidebar. */
  createProjectGroup: (projectIds?: string[]) => Promise<void>
  renameProjectGroup: (groupId: string, name: string) => void
  startRenameProjectGroup: (groupId: string) => void
  stopRenameProjectGroup: () => void
  /** Elimina la sezione: i progetti restano, in coda a quelli senza sezione. */
  deleteProjectGroup: (groupId: string) => void
  toggleProjectGroup: (groupId: string) => void
  reorderProjectGroups: (groupIds: string[]) => void
  /** Sposta un progetto in una sezione (o fuori, con null) alla posizione indicata, contata senza di lui. Serve anche a riordinare. */
  moveProject: (projectId: string, groupId: string | null, index?: number) => void
  clearSidebarNotice: () => void
  /** LAD-59: mostra nel banner degli avvisi l'errore di un comando fatto fuori dalla sidebar. */
  notifyError: (error: unknown) => void
  /** LAD-59: conferma nel banner degli avvisi (tono tenue). */
  notifyInfo: (text: string) => void
  setDraft: (key: string, text: string) => void
  /** Chiede all'host i comandi / della sessione (all'apertura e alla riconnessione). */
  loadCommands: (sessionId: string) => void
  setUi: (projectId: string, state: ProjectUiState) => void
  closeTab: (projectId: string, sessionId: string) => void
  /** Sposta una tab nella posizione `toIndex` tra quelle dello stesso tipo (chat o file). L'ordine si salva per progetto. */
  reorderTab: (projectId: string, tabId: string, toIndex: number) => void
  /** ⌘⌥⇧← e ⌘⌥⇧→: sposta la tab attiva di una posizione. */
  /** Sposta la tab attiva di un posto. Restituisce true se si è mossa. */
  moveActiveTab: (projectId: string, delta: -1 | 1) => boolean
  /** Tab successiva (+1) o precedente (-1) del progetto, in ciclo: prima le chat, poi i file, come nella barra. Restituisce true se è cambiata la selezione. */
  cycleTab: (projectId: string, delta: -1 | 1) => boolean
  /** Riapre l'ultima tab chiusa del progetto (chat o file). Salta quelle non più riapribili. Restituisce true se ne ha riaperta una. */
  reopenClosedTab: (projectId: string) => boolean
  /** Cerca nel progetto: apre il pannello File dell'ispettore con il focus sul filtro. */
  searchInProject: (projectId: string) => void
  /** Torna su un progetto: riapre la tab attiva che aveva, oppure la nuova chat. */
  selectProject: (projectId: string) => void
  toggleSidebar: () => void
  setPaletteOpen: (open: boolean) => void
  /** Avvia la modifica del titolo: apre la sidebar e il progetto se servono. */
  startRename: (sessionId: string) => void
  /** Chiede all'host un nuovo titolo generato. Il titolo arriva con session.upsert; l'errore, già tradotto, si mostra come gli altri della sidebar. */
  regenerateTitle: (sessionId: string) => void
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
  /** Mette un'immagine in coda per il composer con la chiave indicata. */
  queueComposerAttachment: (key: string, attachment: Attachment) => void
  /** Il composer ha preso le immagini in coda. */
  takeComposerAttachments: (key: string) => Attachment[]
  /** Apre la tab browser del progetto (la prima se c'è già, altrimenti una nuova); `fresh` ne apre sempre una nuova. Con `url` ci naviga. */
  openBrowser: (projectId: string, options?: { url?: string; fresh?: boolean }) => string
  /** Chiude la tab browser e ne distrugge la vista nativa. */
  closeBrowser: (projectId: string, tabId: string) => void
  setBrowserState: (state: BrowserState) => void
  /** Sostituisce lo stato del browser dell'agente di una sessione; con `closed` lo toglie. Apre e mostra la vista alla prima volta. */
  applyAgentBrowser: (state: AgentBrowserState) => void
  /** Caricamento a ogni connessione (`browser.agent.state`, elenco completo): sostituisce lo stato e ritrova le viste, senza cambiare ciò che si guarda. */
  loadAgentBrowser: (states: AgentBrowserState[]) => void
  /** Mostra la tab del browser dell'agente della sessione. */
  showAgentBrowser: (sessionId: string) => void
  /** Chiede al main la vista dell'agente. `null` con stato attivo = è di un'altra finestra. Senza `force` al massimo un tentativo al secondo per sessione. */
  probeAgentBrowser: (sessionId: string, force?: boolean) => Promise<void>
  /** Chiude la tab dell'agente: vale come stop (la vista si distrugge e l'host rifiuta le chiamate successive). */
  closeAgentBrowser: (sessionId: string) => void
  /** Riattiva il browser dell'agente dopo uno stop esplicito o la chiusura della tab: gli strumenti tornano subito, la tab si ricrea alla prima azione dell'agente. */
  resumeAgentBrowser: (sessionId: string) => Promise<void>
  dismissDevServer: (projectId: string) => void
  /** Apre la sessione in una colonna accanto a quella attiva (o in fondo, con `at: 'end'`). Già aperta: la attiva. Colonne piene: prende il posto di quella attiva. Restituisce true se si è aperta una nuova colonna. */
  openSplit: (projectId: string, sessionId: string, options?: { at?: 'end' }) => boolean
  /** ⌘\ Affianca: la prossima chat aperta non ancora in colonna, oppure una nuova chat che si apre accanto. */
  splitActive: () => void
  /** Toglie la colonna dalla vista; la tab e la sessione restano. */
  closeColumn: (projectId: string, sessionId: string) => void
  /** ⌘⌥← e ⌘⌥→: la colonna a sinistra o a destra diventa attiva. */
  focusColumn: (delta: -1 | 1) => boolean
  setSplitDrop: (on: boolean) => void
  setQuickOpen: (open: boolean) => void
  /** ⌘P e il nome del progetto nella barra: chiude la palette e apre o chiude la ricerca dei file. */
  toggleQuickOpen: () => void
  /** Apre la sessione (nel suo progetto e nella sua tab) e chiede alla vista di raggiungere l'elemento. */
  openSessionAt: (sessionId: string, itemId: string | null) => boolean
  consumeFocus: (nonce: number) => void
  setInboxOpen: (open: boolean) => void
  setNewFromOpen: (open: boolean) => void
  setNewSource: (source: { projectId: string; item: IssueItem } | null) => void
  setNewPreset: (value: { projectId: string; presetId: string } | null) => void
  setPresetEditor: (value: { presetId?: string; seed?: Partial<SessionPreset> } | null) => void
  /** Hai lasciato il progetto (o la finestra): da qui parte il conto di "Mentre eri via". */
  markSeen: (projectId: string) => void
  /** Sei tornato sul progetto: se eri via da più di 30 minuti, prepara il riepilogo. */
  checkAway: (projectId: string) => void
  dismissAway: (projectId: string) => void
  setPrefs: (prefs: AppPrefs) => void
}

/** Una tab chiusa che ⌘⇧T può riaprire. */
export type ClosedTab = { kind: 'session'; sessionId: string } | { kind: 'file'; root: string; path: string } | { kind: 'browser'; tabId: string; url: string }

const MAX_CLOSED_TABS = 20

/** Pila delle tab chiuse del progetto con `entry` in cima, senza doppioni e limitata a MAX_CLOSED_TABS. */
function withClosedTab(closed: Record<string, ClosedTab[]>, projectId: string, entry: ClosedTab): Record<string, ClosedTab[]> {
  const same = (other: ClosedTab) => {
    if (entry.kind === 'session') return other.kind === 'session' && other.sessionId === entry.sessionId
    if (entry.kind === 'browser') return other.kind === 'browser' && other.tabId === entry.tabId
    return other.kind === 'file' && other.root === entry.root && other.path === entry.path
  }
  const stack = [...(closed[projectId] ?? []).filter((other) => !same(other)), entry].slice(-MAX_CLOSED_TABS)
  return { ...closed, [projectId]: stack }
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

export const DEFAULT_TERMINAL_WIDTH = 480
export const DEFAULT_TERMINAL_HEIGHT = 260

const MAX_TABS = 8
/** Colonne affiancate al massimo. */
export const MAX_COLUMNS = 3
const NO_COLUMNS: string[] = []
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
      // Lo stato attuale al momento dell'invio, non lo snapshot: un salvataggio ritardato non cancella modifiche arrivate dopo.
      send({ type: 'ui.set', projectId, state: useApp.getState().ui[projectId] ?? state })
    }, 300)
  )
}
const emptyUi = (): ProjectUiState => ({ tabs: [], activeTab: null, scroll: {} })
/** Ultima chat guardata per progetto: serve ad "Aggiungi alla chat" quando si è su una tab che non è una chat. Solo in memoria. */
const lastSession = new Map<string, string>()

/**
 * Dove vanno screenshot e citazioni del browser: la colonna attiva se ci sono colonne affiancate, altrimenti l'ultima chat
 * guardata, altrimenti la bozza della nuova chat. `key` è la chiave della bozza del composer.
 */
export function chatTargetFor(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): { key: string; sessionId: string | null } {
  const split = cleanSplit(state, projectId)
  const candidates = [split?.active, lastSession.get(projectId), ...[...(state.ui[projectId]?.tabs ?? [])].reverse()]
  const sessionId = candidates.find((id): id is string => Boolean(id) && state.sessions[id!]?.projectId === projectId && isLiveSession(state, state.sessions[id!]))
  return sessionId ? { key: sessionId, sessionId } : { key: `new:${projectId}`, sessionId: null }
}

/** Libera le viste native di un progetto rimosso e cancella cookie e storage della sua partizione (`persist:project-<id>`). */
function purgeProjectBrowser(projectId: string): void {
  void window.ladder?.browser?.purge(projectId)?.catch(() => undefined)
}

/** Indirizzo e titolo di una tab si salvano (e vanno all'host) dopo una pausa di 1 s: durante il caricamento cambiano di continuo. */
const BROWSER_SAVE_DELAY = 1000
// Tentativi di aprire la vista dell'agente: uno alla volta per sessione e a distanza minima, per non fare loop.
const AGENT_PROBE_GAP = 1000
const agentProbing = new Set<string>()
const agentProbedAt = new Map<string, number>()
const omitKey = (record: Record<string, string>, key: string): Record<string, string> => {
  const next = { ...record }
  delete next[key]
  return next
}
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
let nonce = 0

// ── LAD-68: sessioni di cui l'intestazione osserva lo stato git ──
const gitWatched = new Set<string>()
/** Legge lo stato git della sessione osservata; ignora la risposta se nel frattempo non è più osservata. */
function loadGitStatus(sessionId: string): void {
  request<GitStatus | null>({ type: 'git.status', sessionId })
    .then((status) => {
      // Tolta nel frattempo, o non è un repository: niente da mostrare.
      if (!status || !gitWatched.has(sessionId)) return
      useApp.setState((state) => ({ gitStatus: { ...state.gitStatus, [status.root]: status }, gitRoot: { ...state.gitRoot, [sessionId]: status.root } }))
    })
    .catch(() => {})
}
// Nuova connessione con l'host (riavvio o porta arrivata dopo): le iscrizioni dell'host vivono per porta e la porta è nuova, quindi la UI le rifà.
onHostConnect(() => {
  for (const sessionId of gitWatched) {
    send({ type: 'git.watch', sessionId, on: true })
    loadGitStatus(sessionId)
  }
})
/** Toglie lo stato git della sessione; quello della cartella resta finché un'altra sessione osservata la usa. */
function dropGit(sessionId: string): void {
  useApp.setState((state) => {
    const root = state.gitRoot[sessionId]
    if (root === undefined) return {}
    const gitRoot = { ...state.gitRoot }
    delete gitRoot[sessionId]
    if (Object.values(gitRoot).includes(root)) return { gitRoot }
    const gitStatus = { ...state.gitStatus }
    delete gitStatus[root]
    return { gitRoot, gitStatus }
  })
}

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed'
  } catch {
    return true
  }
}

const LAST_PROJECT_KEY = 'ladder.last-project'
function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}
function writeLastProject(projectId: string | null): void {
  try {
    if (projectId) localStorage.setItem(LAST_PROJECT_KEY, projectId)
  } catch {
    // Solo una comodità: senza storage si riparte dal primo progetto.
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
  if (a.kind === 'file' && b.kind === 'file') return a.root === b.root && a.path === b.path
  if (a.kind === 'browser' && b.kind === 'browser') return a.tabId === b.tabId
  return a.kind === b.kind && a.projectId === b.projectId
}

/** Sessione visibile: non archiviata e con il progetto ancora presente. */
export function isLiveSession(state: Pick<AppState, 'projects'>, session: SessionSummary | undefined): session is SessionSummary {
  return Boolean(session && !session.archived && state.projects.some((p) => p.id === session.projectId))
}

function isValidEntry(state: Pick<AppState, 'projects' | 'sessions' | 'ui' | 'agentBrowser' | 'agentForeign'>, entry: Selection): boolean {
  if (entry.kind === 'session') return isLiveSession(state, state.sessions[entry.sessionId])
  // La tab dell'agente vale finché l'host la tiene.
  if (entry.kind === 'browser' && isAgentTabId(entry.tabId)) { const agent = state.agentBrowser[agentTabSession(entry.tabId)]; return hasAgentTab(agent) && state.agentForeign[agent.sessionId] !== agent.tabId }
  // Una tab browser chiusa non si riapre tornando indietro: ⌘⇧T è il modo per riaprirla.
  if (entry.kind === 'browser') return Boolean(state.ui[entry.projectId]?.browserTabs?.some((tab) => tab.id === entry.tabId))
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
  writeLastProject(selection.projectId)
  if (selection.kind === 'file') {
    const ui = state.ui[selection.projectId] ?? emptyUi()
    const known = ui.fileTabs?.some((f) => f.root === selection.root && f.path === selection.path)
    const nextUi = { ...ui, fileTabs: known ? ui.fileTabs : [...(ui.fileTabs ?? []), { root: selection.root, path: selection.path }], activeTab: fileTabId(selection.root, selection.path) }
    persistUi(selection.projectId, nextUi)
    return { selection, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null, pendingSplit: null }
  }
  // La tab dell'agente è effimera: non entra in `browserTabs` e non diventa la tab attiva salvata.
  if (selection.kind === 'browser' && isAgentTabId(selection.tabId)) return { selection, heldUnread: null, pendingSplit: null }
  if (selection.kind === 'browser') {
    const ui = state.ui[selection.projectId] ?? emptyUi()
    const known = ui.browserTabs?.some((tab) => tab.id === selection.tabId)
    const nextUi: ProjectUiState = { ...ui, browserTabs: known ? ui.browserTabs : [...(ui.browserTabs ?? []), { id: selection.tabId, url: '' }], activeTab: selection.tabId }
    persistUi(selection.projectId, nextUi)
    return { selection, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null, pendingSplit: null }
  }
  if (selection.kind !== 'session') return { selection, heldUnread: null, pendingSplit: null }
  lastSession.set(selection.projectId, selection.sessionId)
  const session = state.sessions[selection.sessionId]
  const firstUnread = { ...state.firstUnread }
  // Il divisore "Nuovo" si calcola all'apertura e resta fermo finché la sessione è aperta.
  if (session && !(selection.sessionId in firstUnread)) firstUnread[selection.sessionId] = session.unread ? session.lastReadSeq + 1 : null
  // La sessione aperta diventa una tab del suo progetto; oltre 8 tab si chiude la meno recente.
  const ui = state.ui[selection.projectId] ?? emptyUi()
  let tabs = ui.tabs.includes(selection.sessionId) ? ui.tabs : [...ui.tabs, selection.sessionId]
  if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS)
  const nextUi: ProjectUiState = { ...ui, tabs, activeTab: selection.sessionId }
  // Con le colonne affiancate la sessione scelta o è già una colonna (diventa attiva) o prende il posto della colonna attiva.
  // Dopo ⌘\ senza altre chat, la sessione nuova si apre invece accanto a quella da cui si è partiti.
  const split = cleanSplit(state, selection.projectId)
  const pending = state.pendingSplit?.projectId === selection.projectId && state.pendingSplit.base !== selection.sessionId ? state.pendingSplit : null
  const base = split?.active ?? pending?.base ?? null
  if (split && split.sessions.includes(selection.sessionId)) nextUi.split = { ...split, active: selection.sessionId }
  else if (pending && isLiveSession(state, state.sessions[pending.base])) {
    const sessions = withColumn(split?.sessions ?? [pending.base], split?.active ?? pending.base, selection.sessionId)
    nextUi.split = { sessions, active: selection.sessionId }
  } else if (split && base) nextUi.split = { sessions: split.sessions.map((id) => (id === base ? selection.sessionId : id)), active: selection.sessionId }
  else if (ui.split) delete nextUi.split
  persistUi(selection.projectId, nextUi)
  return { selection, firstUnread, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null, pendingSplit: null }
}

/** Sessioni nell'ordine della sidebar: progetti in ordine, poi la più recente in alto. */
function sidebarOrder(state: AppState): SessionSummary[] {
  const rank = new Map(state.projects.map((p, i) => [p.id, i]))
  return Object.values(state.sessions)
    .filter((s) => isLiveSession(state, s))
    .sort((a, b) => rank.get(a.projectId)! - rank.get(b.projectId)! || b.createdAt - a.createdAt)
}

/** Colonne affiancate del progetto: solo sessioni vive del progetto. Meno di due: nessuna divisione (id sparsi dopo un riavvio). */
export function liveColumns(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): string[] {
  const split = state.ui[projectId]?.split
  if (!split) return NO_COLUMNS
  const ids = split.sessions.filter((id, i, all) => all.indexOf(id) === i && state.sessions[id]?.projectId === projectId && isLiveSession(state, state.sessions[id])).slice(0, MAX_COLUMNS)
  return ids.length >= 2 ? ids : NO_COLUMNS
}

/** Divisione ripulita: colonne vive e colonna attiva valida, oppure undefined se non resta niente da affiancare. */
function cleanSplit(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): { sessions: string[]; active: string } | undefined {
  const sessions = liveColumns(state, projectId)
  if (sessions.length < 2) return undefined
  const active = state.ui[projectId]?.split?.active
  return { sessions, active: active && sessions.includes(active) ? active : sessions[0] }
}

/** Aggiunge `id` alle colonne: dopo `base` (o in fondo con `end`). Se sono piene prende il posto di `base`. */
function withColumn(sessions: string[], base: string | null, id: string, end = false): string[] {
  if (sessions.includes(id)) return sessions
  const list = base && !sessions.includes(base) ? [base, ...sessions] : sessions
  if (list.length >= MAX_COLUMNS) return list.map((s) => (s === base ? id : s)).slice(0, MAX_COLUMNS)
  const at = end || !base ? list.length : list.indexOf(base) + 1
  return [...list.slice(0, at), id, ...list.slice(at)]
}

/** Toglie una colonna: restano le altre e la vicina che diventa attiva. Meno di due colonne: niente divisione. */
function withoutColumn(split: { sessions: string[]; active: string }, id: string): { split: { sessions: string[]; active: string } | undefined; neighbor: string | null } {
  const at = split.sessions.indexOf(id)
  const rest = split.sessions.filter((s) => s !== id)
  const neighbor = rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null
  const active = split.active === id ? (neighbor ?? '') : split.active
  return { split: rest.length >= 2 ? { sessions: rest, active } : undefined, neighbor }
}

/** Cosa riaprire tornando su un progetto: la sua tab attiva, chat o file, oppure la nuova chat. */
function selectionForProject(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): Selection {
  const ui = state.ui[projectId]
  const file = parseFileTab(ui?.activeTab)
  if (file && ui?.fileTabs?.some((f) => f.root === file.root && f.path === file.path)) return { kind: 'file', projectId, ...file }
  const active = ui?.activeTab
  if (isBrowserTabId(active) && ui?.browserTabs?.some((tab) => tab.id === active)) return { kind: 'browser', projectId, tabId: active }
  if (active && !file && isLiveSession(state, state.sessions[active])) return { kind: 'session', projectId, sessionId: active }
  return { kind: 'new', projectId }
}

/** Cambia e salva lo stato interfaccia di un progetto. */
function patchUi(state: AppState, projectId: string, change: (ui: ProjectUiState) => ProjectUiState): Pick<AppState, 'ui'> {
  const next = change(state.ui[projectId] ?? emptyUi())
  persistUi(projectId, next)
  return { ui: { ...state.ui, [projectId]: next } }
}

let errorTimer: ReturnType<typeof setTimeout> | undefined

/** Mostra un errore di un comando della sidebar: banner dismissibile che scompare dopo 6 s. */
function failSidebarNotice(error: unknown): void {
  clearTimeout(errorTimer)
  useApp.setState({ sidebarNotice: error instanceof Error ? error.message : String(error), sidebarNoticeTone: 'error' })
  errorTimer = setTimeout(() => useApp.setState({ sidebarNotice: null }), 6000)
}

/** Informazione nello stesso banner della sidebar, in tono tenue; resta 10 s. */
function infoSidebarNotice(text: string): void {
  clearTimeout(errorTimer)
  useApp.setState({ sidebarNotice: text, sidebarNoticeTone: 'info' })
  errorTimer = setTimeout(() => useApp.setState({ sidebarNotice: null }), 10_000)
}

/** Operazioni sui gruppi mandate all'host e non ancora risolte, in ordine, e l'ultimo stato confermato dall'host. */
const pendingGroupOps: { id: number; op: ProjectGroupOp }[] = []
let confirmedGroups: ProjectGroupsState | null = null
let groupOpId = 0

/** Lo stato confermato con sopra, di nuovo, le operazioni ancora in volo: quello che l'utente deve vedere. */
function replayGroupOps(projects: Project[], base: ProjectGroupsState | null): ProjectGroupsState | null {
  if (pendingGroupOps.length === 0) return base
  return pendingGroupOps.reduce((state, { op }) => applyProjectGroupOp(state, op), normalizeProjectGroups(projects, base))
}

/**
 * Applica subito il cambiamento e lo manda all'host, che risponde con lo stato vero (lo stesso arriva a tutte le finestre).
 * Con più comandi in volo ogni risposta, o rifiuto, riparte dall'ultimo stato confermato e ci rimette sopra solo le
 * operazioni ancora in attesa: una risposta in ritardo non cancella l'ottimistico del comando dopo, e un rifiuto toglie
 * solo il suo. Senza host (anteprima web) resta lo stato locale.
 */
function runGroupOp(op: ProjectGroupOp, command: HostCommand): void {
  const state = useApp.getState()
  if (pendingGroupOps.length === 0) confirmedGroups = state.projectGroups
  useApp.setState({ projectGroups: applyProjectGroupOp(normalizeProjectGroups(state.projects, state.projectGroups), op) })
  if (!isElectron) return
  const entry = { id: ++groupOpId, op }
  pendingGroupOps.push(entry)
  const settle = (confirmed?: ProjectGroupsState) => {
    pendingGroupOps.splice(pendingGroupOps.indexOf(entry), 1)
    if (confirmed) confirmedGroups = confirmed
    useApp.setState((current) => ({ projectGroups: replayGroupOps(current.projects, confirmedGroups) }))
  }
  request<ProjectGroupsState>(command)
    .then((result) => settle(result))
    .catch((error) => {
      settle()
      failSidebarNotice(error)
    })
}

export const useApp = create<AppState>((set, get) => ({
  renamingGroup: null,
  projectGroups: null,
  renamingProjectGroup: null,
  sidebarNotice: null,
  sidebarNoticeTone: 'error',
  dirtyFiles: {},
  closingFile: null,
  connected: false,
  projects: [],
  sessions: {},
  items: {},
  drafts: {},
  commands: {},
  ui: {},
  agents: [],
  profiles: [],
  profileAgents: {},
  selection: { kind: 'new', projectId: null },
  firstUnread: {},
  sidebarOpen: readSidebarOpen(),
  paletteOpen: false,
  renaming: null,
  heldUnread: null,
  history: [],
  historyIndex: -1,
  terminals: {},
  fsVersion: {},
  gitStatus: {},
  gitRoot: {},
  inspectorRequest: null,
  composerInsert: null,
  composerReplace: null,
  composerAttachments: {},
  browserStates: {},
  agentBrowser: {},
  agentForeign: {},
  devServers: {},
  quickOpen: false,
  splitDrop: false,
  pendingSplit: null,
  focusTarget: null,
  inboxOpen: false,
  newFromOpen: false,
  newSource: null,
  newPreset: null,
  presetEditor: null,
  away: {},
  prefs: null,
  connections: {},
  profileConnections: {},
  onboarding: 'idle',
  detectedAgentsHidden: false,
  githubVersion: 0,
  connectionFocus: null,
  reviews: {},
  shortcuts: null,
  closedTabs: {},
  filesFilterFocus: null,
  applyShortcuts: (shortcuts) => {
    // Prima il registro condiviso, poi lo stato: chi rilegge le etichette le trova già nuove.
    applyShortcutConfig({ preset: shortcuts.preset, overrides: shortcuts.overrides })
    set({ shortcuts })
  },
  consumeFilesFilterFocus: (nonce) => set((state) => (state.filesFilterFocus?.nonce === nonce ? { filesFilterFocus: null } : {})),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case 'snapshot': {
          const sessions: Record<string, SessionSummary> = {}
          for (const s of event.sessions) sessions[s.id] = s
          const terminals: Record<string, TerminalInfo> = {}
          for (const t of event.terminals) terminals[t.id] = t
          const loaded = { projects: event.projects, sessions, ui: event.ui }
          // All'avvio si torna sull'ultimo progetto guardato, sulla tab che aveva.
          let patch: Partial<AppState> = {}
          if (state.selection.kind === 'new' && !state.selection.projectId) {
            const last = readLastProject()
            const projectId = event.projects.some((p) => p.id === last) ? last : (event.projects[0]?.id ?? null)
            patch = selectionPatch({ ...state, ...loaded }, projectId ? selectionForProject(loaded, projectId) : { kind: 'new', projectId })
          }
          // Senza scorciatoie nello snapshot (fixture, host vecchio) restano quelle già note.
          if (event.shortcuts) applyShortcutConfig({ preset: event.shortcuts.preset, overrides: event.shortcuts.overrides })
          return {
            connected: true,
            ...(event.shortcuts ? { shortcuts: event.shortcuts } : {}),
            // Senza sezioni nello snapshot (fixture, host vecchio) restano quelle già note.
            projectGroups: event.projectGroups ?? state.projectGroups,
            drafts: event.drafts,
            ...splitAgents(event.agents),
            // Senza profili nello snapshot (fixture, host vecchio) restano quelli già noti: in assenza, solo i predefiniti.
            profiles: event.profiles ?? state.profiles,
            // Gli snapshot senza collegamenti (fixture, host vecchio) non cancellano quelli già noti.
            ...(event.connections ? splitConnections(event.connections) : {}),
            terminals,
            ...loaded,
            ...patch
          }
        }
        case 'shortcuts.changed':
          applyShortcutConfig({ preset: event.state.preset, overrides: event.state.overrides })
          return { shortcuts: event.state }
        case 'projectGroups.changed':
          confirmedGroups = event.state
          return { projectGroups: replayGroupOps(state.projects, event.state) }
        case 'project.upsert': {
          const exists = state.projects.some((p) => p.id === event.project.id)
          return {
            projects: exists ? state.projects.map((p) => (p.id === event.project.id ? event.project : p)) : [...state.projects, event.project]
          }
        }
        case 'project.removed': {
          const projects = state.projects.filter((p) => p.id !== event.projectId)
          purgeProjectBrowser(event.projectId)
          for (const s of Object.values(state.sessions)) if (s.projectId === event.projectId && gitWatched.delete(s.id)) queueMicrotask(() => dropGit(s.id))
          // I comandi delle sessioni del progetto rimosso non servono più.
          const commands = { ...state.commands }
          for (const s of Object.values(state.sessions)) if (s.projectId === event.projectId) delete commands[s.id]
          if (state.selection.projectId !== event.projectId) return { projects, commands }
          // La selezione era nel progetto rimosso: si passa alla nuova chat del primo progetto rimasto.
          const selection: Selection = { kind: 'new', projectId: projects[0]?.id ?? null }
          return { projects, commands, selection, ...pushHistory(state, selection) }
        }
        case 'sessions.autoArchived': {
          // Le tab si chiudono con i session.upsert delle sessioni archiviate; qui si avvisa, una volta sola per giro.
          const n = event.sessionIds.length
          if (n === 0) return {}
          const days = state.prefs?.autoArchiveDays
          queueMicrotask(() =>
            infoSidebarNotice(
              days === 1
                ? plural(n, '{n} session archived after a day without activity', '{n} sessions archived after a day without activity')
                : days
                ? plural(n, '{n} session archived after {days} days without activity', '{n} sessions archived after {days} days without activity', { days })
                : plural(n, '{n} idle session archived', '{n} idle sessions archived')
            )
          )
          return {}
        }
        case 'session.upsert': {
          const before = state.sessions[event.session.id]
          // Archiviata dall'host (per esempio a PR unita): la tab si chiude come per un archivio dalla UI.
          if (event.session.archived && before && !before.archived) {
            queueMicrotask(() => {
              const agent = useApp.getState().agentBrowser[event.session.id]
              if (agent) useApp.getState().applyAgentBrowser({ ...agent, tabId: null, closed: true, action: null })
              useApp.getState().closeTab(event.session.projectId, event.session.id)
            })
          }
          // L'host toglie da solo il watch della sessione archiviata: qui si pulisce lo stato.
          if (event.session.archived && gitWatched.delete(event.session.id)) queueMicrotask(() => dropGit(event.session.id))
          return { sessions: { ...state.sessions, [event.session.id]: event.session } }
        }
        case 'session.items':
          return {
            items: {
              ...state.items,
              [event.sessionId]: event.replace ? [...event.items].sort((a, b) => a.seq - b.seq) : mergeItems(state.items[event.sessionId], event.items)
            }
          }
        case 'session.commands':
          return { commands: { ...state.commands, [event.sessionId]: event.commands } }
        case 'agent.status': {
          // Un profilo non predefinito ha il suo stato: non tocca quello dell'agente.
          if (!isDefaultProfileId(event.status.profileId)) return { profileAgents: { ...state.profileAgents, [event.status.profileId!]: event.status } }
          // Ordine stabile: Claude Code, Codex, poi gli agenti ACP nell'ordine in cui arrivano.
          const exists = state.agents.some((a) => a.agent === event.status.agent)
          return { agents: exists ? state.agents.map((a) => (a.agent === event.status.agent ? event.status : a)) : [...state.agents, event.status] }
        }
        case 'agent.removed':
          return { agents: state.agents.filter((a) => a.agent !== event.agent) }
        case 'profile.upsert': {
          const exists = state.profiles.some((p) => p.id === event.profile.id)
          return { profiles: exists ? state.profiles.map((p) => (p.id === event.profile.id ? event.profile : p)) : [...state.profiles, event.profile] }
        }
        case 'profile.removed': {
          const { [event.profileId]: _agent, ...profileAgents } = state.profileAgents
          const { [event.profileId]: _connection, ...profileConnections } = state.profileConnections
          return { profiles: state.profiles.filter((p) => p.id !== event.profileId), profileAgents, profileConnections }
        }
        case 'review.update':
          return { reviews: { ...state.reviews, [event.review.id]: event.review } }
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
        case 'browser.agent':
          // Intero a ogni cambiamento: va fuori dal `set` perché apre la vista e può cambiare la selezione.
          queueMicrotask(() => useApp.getState().applyAgentBrowser(event.state))
          return {}
        case 'browser.devserver': {
          // Lo stesso indirizzo già aperto in una tab del progetto non serve proporlo.
          let origin = event.url
          try {
            origin = new URL(event.url).origin
          } catch {
            // Indirizzo non valido: si confronta com'è.
          }
          const open = state.ui[event.projectId]?.browserTabs?.some((tab) => (state.browserStates[tab.id]?.url ?? tab.url).startsWith(origin))
          return open ? {} : { devServers: { ...state.devServers, [event.projectId]: { url: event.url, terminalId: event.terminalId } } }
        }
        case 'connection.update': {
          // Una risposta partita prima di `profile.removed` non rimette in vita il profilo tolto.
          if (!isDefaultProfileId(event.status.profileId) && !state.profiles.some((p) => p.id === event.status.profileId)) return {}
          if (!isDefaultProfileId(event.status.profileId)) return { profileConnections: { ...state.profileConnections, [event.status.profileId!]: event.status } }
          const before = state.connections[event.status.id]
          const linked = (c: ConnectionStatus | undefined) => c?.state === 'connected' && !c.login
          // GitHub appena collegato (o scollegato): le viste che lo leggono si rinnovano. Il primo stato letto all'avvio non è una transizione.
          const github = event.status.id === 'github' && before !== undefined && linked(before) !== linked(event.status)
          return { connections: { ...state.connections, [event.status.id]: event.status }, ...(github ? { githubVersion: state.githubVersion + 1 } : {}) }
        }
        case 'git.status': {
          // Un evento in ritardo, dopo l'ultimo `unwatchGit`, non rimette in vita lo stato.
          if (gitWatched.size === 0) return {}
          return { gitStatus: { ...state.gitStatus, [event.status.root]: event.status } }
        }
        case 'fs.changed':
          return { fsVersion: { ...state.fsVersion, [event.root]: (state.fsVersion[event.root] ?? 0) + 1 } }
      }
      return {}
    }),

  select: (selection, options) =>
    set((state) => {
      const patch = selectionPatch(state, selection)
      if (options?.history === false) {
        // La voce corrente della cronologia passa alla nuova selezione: Indietro torna a prima del gruppo di colonne.
        const entry = state.history[state.historyIndex]
        if (!entry || !sameSelection(entry, state.selection)) return patch
        const history = [...state.history]
        history[state.historyIndex] = selection
        return { ...patch, history }
      }
      return sameSelection(state.selection, selection) ? patch : { ...patch, ...pushHistory(state, selection) }
    }),

  openFile: (projectId, root, path) => get().select({ kind: 'file', projectId, root, path }),
  closeFile: (projectId, root, path, force = false) => {
    const id = fileTabId(root, path)
    if (!force && get().dirtyFiles[id]) {
      set({ closingFile: { projectId, root, path } })
      return
    }
    disposeBuffer(id)
    set((state) => {
      const dirtyFiles = { ...state.dirtyFiles }
      delete dirtyFiles[id]
      const ui = state.ui[projectId] ?? emptyUi()
      const fileTabs = (ui.fileTabs ?? []).filter((f) => f.root !== root || f.path !== path)
      const nextUi = { ...ui, fileTabs, activeTab: ui.activeTab === id ? null : ui.activeTab }
      persistUi(projectId, nextUi)
      const next = { ...state, ui: { ...state.ui, [projectId]: nextUi } }
      const wasActive = state.selection.kind === 'file' && state.selection.root === root && state.selection.path === path
      // ⌘⇧T la riapre, ma solo se la tab c'era davvero.
      const closedTabs = ui.fileTabs?.some((f) => f.root === root && f.path === path) ? withClosedTab(state.closedTabs, projectId, { kind: 'file', root, path }) : state.closedTabs
      if (!wasActive) return { ui: next.ui, dirtyFiles, closingFile: null, closedTabs }
      // Si passa al file aperto prima, poi all'ultima chat aperta, poi alla nuova chat.
      const lastFile = fileTabs[fileTabs.length - 1]
      const lastSession = [...nextUi.tabs].reverse().find((s) => isLiveSession(state, state.sessions[s]))
      const selection: Selection = lastFile ? { kind: 'file', projectId, ...lastFile } : lastSession ? { kind: 'session', projectId, sessionId: lastSession } : { kind: 'new', projectId }
      return { ui: next.ui, dirtyFiles, closingFile: null, closedTabs, ...selectionPatch(next, selection), ...pushHistory(state, selection) }
    })
  },
  cancelCloseFile: () => set({ closingFile: null }),

  openBrowser: (projectId, options = {}) => {
    const state = get()
    const tabs = state.ui[projectId]?.browserTabs ?? []
    const existing = options.fresh ? undefined : tabs.find((tab) => tab.id === (state.selection.kind === 'browser' && state.selection.projectId === projectId ? state.selection.tabId : '')) ?? tabs[0]
    const tabId = existing?.id ?? newBrowserTabId()
    if (!existing) {
      // La tab nasce con il suo indirizzo: la vista lo carica alla prima apertura.
      set((current) => patchUi(current, projectId, (ui) => ({ ...ui, browserTabs: [...(ui.browserTabs ?? []), { id: tabId, url: storableUrl(options.url ?? '') }] })))
    } else if (options.url) {
      // Tab già viva: si naviga lì, la vista si aggiorna da sola con l'evento del main.
      void window.ladder?.browser.navigate(tabId, options.url)
      set((current) => patchUi(current, projectId, (ui) => ({ ...ui, browserTabs: (ui.browserTabs ?? []).map((tab) => (tab.id === tabId ? { ...tab, url: storableUrl(options.url!) } : tab)) })))
    }
    // L'avviso del server di sviluppo ha fatto il suo lavoro.
    const { [projectId]: _used, ...devServers } = get().devServers
    set({ devServers })
    get().select({ kind: 'browser', projectId, tabId })
    return tabId
  },

  closeBrowser: (projectId, tabId) => {
    // Chiudere la tab dell'agente è uno stop, non una chiusura come le altre.
    if (isAgentTabId(tabId)) {
      get().closeAgentBrowser(agentTabSession(tabId))
      return
    }
    clearTimeout(saveTimers.get(tabId))
    saveTimers.delete(tabId)
    void window.ladder?.browser.destroy(tabId)
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const closing = ui.browserTabs?.find((tab) => tab.id === tabId)
      if (!closing) return {}
      const browserTabs = (ui.browserTabs ?? []).filter((tab) => tab.id !== tabId)
      const nextUi: ProjectUiState = { ...ui, browserTabs, activeTab: ui.activeTab === tabId ? null : ui.activeTab }
      persistUi(projectId, nextUi)
      const next = { ...state, ui: { ...state.ui, [projectId]: nextUi } }
      const browserStates = { ...state.browserStates }
      const last = browserStates[tabId]?.url || closing.url
      delete browserStates[tabId]
      // ⌘⇧T la riapre sullo stesso indirizzo.
      const closedTabs = withClosedTab(state.closedTabs, projectId, { kind: 'browser', tabId, url: last })
      const wasActive = state.selection.kind === 'browser' && state.selection.tabId === tabId
      if (!wasActive) return { ui: next.ui, browserStates, closedTabs }
      // Si passa al browser aperto prima, poi ai file, poi all'ultima chat, poi alla nuova chat.
      const lastBrowser = browserTabs[browserTabs.length - 1]
      const lastFile = (nextUi.fileTabs ?? [])[(nextUi.fileTabs ?? []).length - 1]
      const lastLive = [...nextUi.tabs].reverse().find((s) => isLiveSession(state, state.sessions[s]))
      const selection: Selection = lastBrowser
        ? { kind: 'browser', projectId, tabId: lastBrowser.id }
        : lastFile
          ? { kind: 'file', projectId, ...lastFile }
          : lastLive
            ? { kind: 'session', projectId, sessionId: lastLive }
            : { kind: 'new', projectId }
      return { ui: next.ui, browserStates, closedTabs, ...selectionPatch(next, selection), ...pushHistory(state, selection) }
    })
  },

  setBrowserState: (incoming) => {
    const browser = { ...incoming, title: clipTitle(incoming.title) }
    // Tab dell'agente: esiste finché l'host la dichiara; non si salva né l'indirizzo né il titolo.
    const agentTab = isAgentTabId(browser.tabId)
    const exists = (state: AppState) =>
      agentTab ? state.agentBrowser[agentTabSession(browser.tabId)]?.tabId === browser.tabId : state.ui[browser.projectId]?.browserTabs?.some((tab) => tab.id === browser.tabId)
    // Un evento che arriva dopo la chiusura della tab non la rimette in `browserStates`.
    if (!exists(get())) return
    set((state) => ({ browserStates: { ...state.browserStates, [browser.tabId]: browser } }))
    if (agentTab) return
    // Si salvano solo origine e percorso (niente query né frammento: possono portare token) e il titolo tagliato; una tab appena creata, senza pagina, non cancella quelli salvati.
    const url = storableUrl(browser.url)
    if (!url) return
    clearTimeout(saveTimers.get(browser.tabId))
    const saved = get().ui[browser.projectId]?.browserTabs?.find((tab) => tab.id === browser.tabId)
    if (saved && saved.url === url && (saved.title ?? '') === browser.title) return
    saveTimers.set(
      browser.tabId,
      setTimeout(() => {
        saveTimers.delete(browser.tabId)
        set((state) => (exists(state) ? patchUi(state, browser.projectId, (current) => ({ ...current, browserTabs: (current.browserTabs ?? []).map((tab) => (tab.id === browser.tabId ? { ...tab, url, title: browser.title } : tab)) })) : {}))
      }, BROWSER_SAVE_DELAY)
    )
  },

  applyAgentBrowser: (incoming) => {
    const sessionId = incoming.sessionId
    const before = get().agentBrowser[sessionId]
    const gone = incoming.closed || !incoming.tabId
    const lostTab = before?.tabId && before.tabId !== incoming.tabId ? before.tabId : null
    set((state) => {
      const agentBrowser = { ...state.agentBrowser }
      if (incoming.closed) delete agentBrowser[sessionId]
      else agentBrowser[sessionId] = incoming
      // Un'altra tab o nessuna tab: l'appartenenza a un'altra finestra non vale più.
      const agentForeign = state.agentForeign[sessionId] && state.agentForeign[sessionId] !== incoming.tabId ? omitKey(state.agentForeign, sessionId) : state.agentForeign
      const browserStates = { ...state.browserStates }
      if (lostTab) delete browserStates[lostTab]
      // La tab che si guardava non c'è più: si torna alla sessione dell'agente (o alla nuova chat del progetto).
      const viewing = state.selection.kind === 'browser' && lostTab !== null && state.selection.tabId === lostTab
      if (!viewing) return { agentBrowser, agentForeign, browserStates }
      const selection: Selection = isLiveSession(state, state.sessions[sessionId]) ? { kind: 'session', projectId: incoming.projectId, sessionId } : { kind: 'new', projectId: incoming.projectId }
      return { agentBrowser, agentForeign, browserStates, ...selectionPatch(state, selection), ...pushHistory(state, selection) }
    })
    if (gone || !incoming.tabId || incoming.stopped) return
    // Stessa tab: solo se era di un'altra finestra si riprova (può essere cambiata la finestra che la possiede).
    if (incoming.tabId === before?.tabId) {
      if (get().agentForeign[sessionId] === incoming.tabId) void get().probeAgentBrowser(sessionId)
      return
    }
    // Vista nuova: si apre dal main (che la restituisce già creata) e, se si sta già guardando un browser del progetto, si mostra subito.
    // Altrimenti la tab compare accanto alla chat con un avviso "Mostra": la chat in cui si scrive non si tocca.
    void get().probeAgentBrowser(sessionId, true)
  },

  probeAgentBrowser: (sessionId, force) => {
    const api = window.ladder?.browser
    const state = get().agentBrowser[sessionId]
    // Anche da ferma la vista può esistere (stop dell'utente): chi apre una finestra deve ritrovarla o sapere che è di un'altra.
    if (!api || !hasAgentTab(state)) return Promise.resolve()
    const now = Date.now()
    if (agentProbing.has(sessionId)) return Promise.resolve()
    if (!force && now - (agentProbedAt.get(sessionId) ?? 0) < AGENT_PROBE_GAP) return Promise.resolve()
    agentProbedAt.set(sessionId, now)
    agentProbing.add(sessionId)
    const tabId = state.tabId
    return api.open(tabId, state.projectId).then(
      (view) => {
        agentProbing.delete(sessionId)
        const latest = get().agentBrowser[sessionId]
        if (!hasAgentTab(latest) || latest.tabId !== tabId) return
        if (view) {
          if (get().agentForeign[sessionId]) set((s) => ({ agentForeign: omitKey(s.agentForeign, sessionId) }))
          get().setBrowserState(view)
          // Vista nuova e si sta già guardando un browser del progetto: si mostra subito.
          const current = get().selection
          if (force && current.kind === 'browser' && current.projectId === latest.projectId) get().showAgentBrowser(sessionId)
          return
        }
        // Nessuna vista qui ma lo stato è attivo: appartiene a un'altra finestra. Non si mostra; se la si guardava si torna alla chat.
        set((s) => {
          const agentForeign = { ...s.agentForeign, [sessionId]: tabId }
          if (!(s.selection.kind === 'browser' && s.selection.tabId === tabId)) return { agentForeign }
          const selection: Selection = isLiveSession(s, s.sessions[sessionId]) ? { kind: 'session', projectId: latest.projectId, sessionId } : { kind: 'new', projectId: latest.projectId }
          return { agentForeign, ...selectionPatch(s, selection), ...pushHistory(s, selection) }
        })
      },
      () => {
        agentProbing.delete(sessionId)
      }
    )
  },

  loadAgentBrowser: (states) => {
    // Con la finestra appena aperta la vista c'è già nel main: la UI la ritrova senza cambiare ciò che si sta guardando.
    // L'elenco è completo: chi non c'è più (host ripartito) si chiude come per un evento `closed`.
    const listed = new Set(states.filter((state) => !state.closed).map((state) => state.sessionId))
    for (const old of Object.values(get().agentBrowser)) if (!listed.has(old.sessionId)) get().applyAgentBrowser({ ...old, tabId: null, closed: true, action: null })
    const agentBrowser = { ...get().agentBrowser }
    for (const state of states) {
      if (state.closed) delete agentBrowser[state.sessionId]
      else agentBrowser[state.sessionId] = state
    }
    const agentForeign = { ...get().agentForeign }
    for (const id of Object.keys(agentForeign)) if (agentBrowser[id]?.tabId !== agentForeign[id]) delete agentForeign[id]
    set({ agentBrowser, agentForeign })
    for (const state of states) if (!state.closed && state.tabId) void get().probeAgentBrowser(state.sessionId, true)
  },

  showAgentBrowser: (sessionId) => {
    const state = get().agentBrowser[sessionId]
    if (!hasAgentTab(state)) return
    // Richiesta di nuovo: riprova prima; se è ancora di un'altra finestra non si apre.
    if (get().agentForeign[sessionId] === state.tabId) {
      void get()
        .probeAgentBrowser(sessionId, true)
        .then(() => {
          const latest = get().agentBrowser[sessionId]
          if (hasAgentTab(latest) && get().agentForeign[sessionId] !== latest.tabId) get().select({ kind: 'browser', projectId: latest.projectId, tabId: latest.tabId })
        })
      return
    }
    get().select({ kind: 'browser', projectId: state.projectId, tabId: state.tabId })
  },

  closeAgentBrowser: (sessionId) => {
    const before = get().agentBrowser[sessionId]
    if (!before) return
    // La vista si distrugge (il main avvisa l'host) e si manda comunque lo stop: così vale anche se la vista non c'era più.
    if (before.tabId) void window.ladder?.browser?.destroy(before.tabId)
    void request({ type: 'browser.agent.stop', sessionId }).catch(() => undefined)
    get().applyAgentBrowser({ ...before, tabId: null, stopped: true, action: null })
  },

  resumeAgentBrowser: (sessionId) =>
    request<AgentBrowserState | AgentBrowserState[] | null>({ type: 'browser.agent.resume', sessionId }).then((next) => {
      const one = Array.isArray(next) ? next[0] : next
      if (one && one.sessionId === sessionId) get().applyAgentBrowser(one)
    }),

  dismissDevServer: (projectId) =>
    set((state) => {
      if (!state.devServers[projectId]) return {}
      const devServers = { ...state.devServers }
      delete devServers[projectId]
      return { devServers }
    }),
  setFileDirty: (id, dirty) => {
    if (Boolean(get().dirtyFiles[id]) !== dirty) set((state) => ({ dirtyFiles: { ...state.dirtyFiles, [id]: dirty } }))
  },

  createGroup: (projectId, sessionIds) =>
    set((state) => {
      const id = crypto.randomUUID()
      const moved = sessionIds === undefined ? [] : Array.isArray(sessionIds) ? sessionIds : [sessionIds]
      return {
        renamingGroup: id,
        ...patchUi(state, projectId, (ui) => ({
          ...ui,
          groups: [...(ui.groups ?? []), { id, name: t('New group') }],
          groupOf: moved.length ? { ...ui.groupOf, ...Object.fromEntries(moved.map((sessionId) => [sessionId, id])) } : ui.groupOf
        }))
      }
    }),
  renameGroup: (projectId, groupId, name) =>
    set((state) => patchUi(state, projectId, (ui) => ({ ...ui, groups: ui.groups?.map((g) => (g.id === groupId ? { ...g, name } : g)) }))),
  startRenameGroup: (groupId) => set({ renamingGroup: groupId }),
  stopRenameGroup: () => set({ renamingGroup: null }),
  // Togliere un gruppo non tocca le chat: tornano nella lista del progetto.
  deleteGroup: (projectId, groupId) =>
    set((state) =>
      patchUi(state, projectId, (ui) => ({
        ...ui,
        groups: ui.groups?.filter((g) => g.id !== groupId),
        groupOf: Object.fromEntries(Object.entries(ui.groupOf ?? {}).filter(([, g]) => g !== groupId))
      }))
    ),
  toggleGroup: (projectId, groupId) =>
    set((state) => patchUi(state, projectId, (ui) => ({ ...ui, groups: ui.groups?.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)) }))),
  moveToGroup: (projectId, sessionId, groupId) => get().moveSessionsToGroup(projectId, [sessionId], groupId),
  moveSessionsToGroup: (projectId, sessionIds, groupId) =>
    set((state) =>
      patchUi(state, projectId, (ui) => {
        const groupOf = { ...ui.groupOf }
        for (const sessionId of sessionIds) {
          if (groupId) groupOf[sessionId] = groupId
          else delete groupOf[sessionId]
        }
        return { ...ui, groupOf, groups: ui.groups?.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g)) }
      })
    ),

  createProjectGroup: async (projectIds) => {
    const name = t('New section')
    if (!isElectron) {
      const id = crypto.randomUUID()
      const state = get()
      set({ projectGroups: applyProjectGroupOp(normalizeProjectGroups(state.projects, state.projectGroups), { type: 'create', id, name, projectIds }), renamingProjectGroup: id })
      return
    }
    try {
      const state = await request<ProjectGroupsState>({ type: 'projectGroups.create', name, projectIds })
      // La sezione nuova è l'ultima dello stato restituito.
      set({ projectGroups: state, renamingProjectGroup: state.groups[state.groups.length - 1]?.id ?? null })
    } catch (error) {
      failSidebarNotice(error)
    }
  },
  renameProjectGroup: (groupId, name) => runGroupOp({ type: 'rename', groupId, name }, { type: 'projectGroups.rename', groupId, name }),
  startRenameProjectGroup: (groupId) => set({ renamingProjectGroup: groupId }),
  stopRenameProjectGroup: () => set({ renamingProjectGroup: null }),
  deleteProjectGroup: (groupId) => runGroupOp({ type: 'delete', groupId }, { type: 'projectGroups.delete', groupId }),
  toggleProjectGroup: (groupId) => {
    const group = get().projectGroups?.groups.find((g) => g.id === groupId)
    if (!group) return
    const collapsed = !group.collapsed
    runGroupOp({ type: 'collapse', groupId, collapsed }, { type: 'projectGroups.collapse', groupId, collapsed })
  },
  reorderProjectGroups: (groupIds) => runGroupOp({ type: 'reorder', groupIds }, { type: 'projectGroups.reorder', groupIds }),
  moveProject: (projectId, groupId, index) => {
    // Una sezione chiusa che riceve un progetto si apre, come i gruppi di chat.
    if (groupId && get().projectGroups?.groups.find((g) => g.id === groupId)?.collapsed) {
      runGroupOp({ type: 'collapse', groupId, collapsed: false }, { type: 'projectGroups.collapse', groupId, collapsed: false })
    }
    runGroupOp({ type: 'move', projectId, groupId, index }, { type: 'projectGroups.move', projectId, groupId, index })
  },
  clearSidebarNotice: () => set({ sidebarNotice: null }),
  notifyError: (error) => failSidebarNotice(error),
  notifyInfo: (text) => infoSidebarNotice(text),

  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  loadCommands: (sessionId) => {
    request<SlashCommand[]>({ type: 'session.commands', sessionId })
      // Una risposta vuota non cancella un elenco già arrivato con l'evento (corsa tra richiesta ed evento).
      .then((commands) => set((state) => (commands.length === 0 && state.commands[sessionId]?.length ? state : { commands: { ...state.commands, [sessionId]: commands } })))
      // Senza elenco restano solo i comandi di Ladder: niente errori davanti all'utente.
      .catch(() => undefined)
  },
  setUi: (projectId, uiState) => set((state) => ({ ui: { ...state.ui, [projectId]: uiState } })),

  closeTab: (projectId, sessionId) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const index = ui.tabs.indexOf(sessionId)
      // Le tab di sessioni archiviate o sparite si tolgono insieme a questa.
      const tabs = ui.tabs.filter((id) => id !== sessionId && isLiveSession(state, state.sessions[id]))
      const wasActive = state.selection.kind === 'session' && state.selection.sessionId === sessionId
      // Con le colonne affiancate si passa alla colonna vicina, non alla tab vicina.
      const before = cleanSplit(state, projectId)
      const column = before?.sessions.includes(sessionId) ? withoutColumn(before, sessionId) : null
      const fallback = column ? column.neighbor : (tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null)
      const nextActive = wasActive ? (fallback ?? tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null) : ui.activeTab === sessionId ? null : ui.activeTab
      const nextUi: ProjectUiState = { ...ui, tabs, activeTab: nextActive }
      if (column?.split) nextUi.split = column.split
      else if (ui.split) delete nextUi.split
      persistUi(projectId, nextUi)
      const next = { ...state, ui: { ...state.ui, [projectId]: nextUi } }
      // Le sessioni archiviate non si riaprono: ⌘⇧T riguarda solo le tab chiuse a mano.
      const closedTabs = ui.tabs.includes(sessionId) && isLiveSession(state, state.sessions[sessionId]) ? withClosedTab(state.closedTabs, projectId, { kind: 'session', sessionId }) : state.closedTabs
      if (!wasActive) return { ui: next.ui, closedTabs }
      const selection: Selection = nextActive ? { kind: 'session', projectId, sessionId: nextActive } : { kind: 'new', projectId }
      return { ui: next.ui, closedTabs, ...selectionPatch(next, selection), ...pushHistory(state, selection) }
    }),

  reorderTab: (projectId, tabId, toIndex) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      if (isBrowserTabId(tabId)) {
        const browsers = ui.browserTabs ?? []
        const from = browsers.findIndex((tab) => tab.id === tabId)
        if (from < 0 || toIndex < 0 || toIndex >= browsers.length || toIndex === from) return {}
        const next = browsers.filter((_, i) => i !== from)
        next.splice(toIndex, 0, browsers[from])
        return patchUi(state, projectId, (current) => ({ ...current, browserTabs: next }))
      }
      const isFile = parseFileTab(tabId) !== null
      if (isFile) {
        const files = ui.fileTabs ?? []
        const from = files.findIndex((f) => fileTabId(f.root, f.path) === tabId)
        if (from < 0 || toIndex < 0 || toIndex >= files.length || toIndex === from) return {}
        const next = files.filter((_, i) => i !== from)
        next.splice(toIndex, 0, files[from])
        return patchUi(state, projectId, (current) => ({ ...current, fileTabs: next }))
      }
      // Le sessioni archiviate non si vedono: la posizione conta solo tra quelle visibili.
      const visible = ui.tabs.filter((id) => isLiveSession(state, state.sessions[id]))
      const from = visible.indexOf(tabId)
      const target = visible[toIndex]
      if (from < 0 || !target || target === tabId) return {}
      const next = ui.tabs.filter((id) => id !== tabId)
      next.splice(next.indexOf(target) + (toIndex > from ? 1 : 0), 0, tabId)
      return patchUi(state, projectId, (current) => ({ ...current, tabs: next }))
    }),

  moveActiveTab: (projectId, delta) => {
    const state = get()
    const { selection } = state
    if (selection.kind === 'new' || selection.projectId !== projectId) return false
    const ui = state.ui[projectId] ?? emptyUi()
    const move = (ids: string[], id: string) => {
      const at = ids.indexOf(id)
      const to = Math.min(Math.max(at + delta, 0), ids.length - 1)
      if (at < 0 || to === at) return false
      state.reorderTab(projectId, id, to)
      return true
    }
    if (selection.kind === 'browser') return move((ui.browserTabs ?? []).map((tab) => tab.id), selection.tabId)
    if (selection.kind === 'file') return move((ui.fileTabs ?? []).map((f) => fileTabId(f.root, f.path)), fileTabId(selection.root, selection.path))
    return move(ui.tabs.filter((id) => isLiveSession(state, state.sessions[id])), selection.sessionId)
  },

  cycleTab: (projectId, delta) => {
    const state = get()
    const ui = state.ui[projectId] ?? emptyUi()
    // Stesso ordine della barra: chat visibili, poi file.
    const order: Selection[] = [
      ...ui.tabs.filter((id) => isLiveSession(state, state.sessions[id])).map((sessionId): Selection => ({ kind: 'session', projectId, sessionId })),
      ...(ui.fileTabs ?? []).map((file): Selection => ({ kind: 'file', projectId, root: file.root, path: file.path })),
      ...(ui.browserTabs ?? []).map((tab): Selection => ({ kind: 'browser', projectId, tabId: tab.id })),
      ...Object.values(state.agentBrowser)
        .filter((agent) => agent.projectId === projectId && hasAgentTab(agent))
        .map((agent): Selection => ({ kind: 'browser', projectId, tabId: agent.tabId! }))
    ]
    if (order.length === 0) return false
    const at = state.selection.projectId === projectId ? order.findIndex((entry) => sameSelection(entry, state.selection)) : -1
    // Da "nuova chat" (nessuna tab attiva) si entra dal primo o dall'ultimo.
    const target = at < 0 ? (delta > 0 ? 0 : order.length - 1) : (at + delta + order.length) % order.length
    if (at === target) return false
    state.select(order[target])
    return true
  },

  reopenClosedTab: (projectId) => {
    const state = get()
    const ui = state.ui[projectId] ?? emptyUi()
    const stack = [...(state.closedTabs[projectId] ?? [])]
    let reopened: Selection | null = null
    while (!reopened && stack.length > 0) {
      const entry = stack.pop()!
      if (entry.kind === 'browser') {
        // La tab riaperta riparte dallo stesso indirizzo, con una vista nuova.
        if (!ui.browserTabs?.some((tab) => tab.id === entry.tabId)) {
          set({ closedTabs: { ...state.closedTabs, [projectId]: stack } })
          state.openBrowser(projectId, { url: entry.url || undefined, fresh: true })
          return true
        }
      } else if (entry.kind === 'file') {
        if (!ui.fileTabs?.some((f) => f.root === entry.root && f.path === entry.path)) reopened = { kind: 'file', projectId, root: entry.root, path: entry.path }
      } else if (state.sessions[entry.sessionId]?.projectId === projectId && isLiveSession(state, state.sessions[entry.sessionId]) && !ui.tabs.includes(entry.sessionId)) {
        reopened = { kind: 'session', projectId, sessionId: entry.sessionId }
      }
    }
    // La pila si accorcia anche se nessuna voce era più riapribile.
    set({ closedTabs: { ...state.closedTabs, [projectId]: stack } })
    if (!reopened) return false
    state.select(reopened)
    return true
  },

  searchInProject: (projectId) => {
    get().openInspector(projectId, 'files')
    set({ filesFilterFocus: { projectId, nonce: ++nonce } })
  },

  selectProject: (projectId) => {
    const state = get()
    state.select(selectionForProject(state, projectId))
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
      return { renaming: sessionId, sidebarOpen: true }
    }),

  stopRename: () => set({ renaming: null }),

  regenerateTitle: (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session || session.mode !== 'chat' || session.titleGenerating) return
    request({ type: 'session.title.regenerate', sessionId }).catch(failSidebarNotice)
  },

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

  watchGit: (sessionId) => {
    if (gitWatched.has(sessionId)) return
    gitWatched.add(sessionId)
    send({ type: 'git.watch', sessionId, on: true })
    loadGitStatus(sessionId)
  },

  unwatchGit: (sessionId) => {
    if (!gitWatched.delete(sessionId)) return
    send({ type: 'git.watch', sessionId, on: false })
    dropGit(sessionId)
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

  replaceComposerDraft: (key, text) => set({ composerReplace: { key, text, nonce: ++nonce } }),
  insertIntoComposer: (key, text) => set({ composerInsert: { key, text, nonce: ++nonce } }),
  queueComposerAttachment: (key, attachment) => set((state) => ({ composerAttachments: { ...state.composerAttachments, [key]: [...(state.composerAttachments[key] ?? []), attachment] } })),
  takeComposerAttachments: (key) => {
    const taken = get().composerAttachments[key] ?? []
    if (taken.length === 0) return taken
    set((state) => {
      const composerAttachments = { ...state.composerAttachments }
      delete composerAttachments[key]
      return { composerAttachments }
    })
    return taken
  },
  openSplit: (projectId, sessionId, options) => {
    const state = get()
    const session = state.sessions[sessionId]
    const select = () => state.select({ kind: 'session', projectId, sessionId })
    if (!isLiveSession(state, session) || session.projectId !== projectId) return false
    const split = cleanSplit(state, projectId)
    // Già in una colonna: basta attivarla.
    if (split?.sessions.includes(sessionId)) {
      select()
      return false
    }
    const current = state.selection.kind === 'session' && state.selection.projectId === projectId ? state.selection.sessionId : null
    const base = split?.active ?? current
    // Niente da cui affiancare (o la stessa sessione): si apre e basta. Colonne piene: prende il posto di quella attiva.
    if (!base || base === sessionId || (split && split.sessions.length >= MAX_COLUMNS)) {
      select()
      return false
    }
    set((current) => patchUi(current, projectId, (ui) => ({ ...ui, split: { sessions: withColumn(split?.sessions ?? [base], base, sessionId, options?.at === 'end'), active: sessionId } })))
    select()
    return true
  },

  splitActive: () => {
    const state = get()
    const { selection } = state
    if (selection.kind !== 'session') return
    const projectId = selection.projectId
    const split = cleanSplit(state, projectId)
    if (split && split.sessions.length >= MAX_COLUMNS) return
    const open = split?.sessions ?? [selection.sessionId]
    // La prossima chat aperta in una tab che non è ancora in colonna, partendo da quella dopo la corrente.
    const tabs = (state.ui[projectId]?.tabs ?? []).filter((id) => isLiveSession(state, state.sessions[id]) && state.sessions[id].projectId === projectId)
    const from = Math.max(0, tabs.indexOf(selection.sessionId))
    const candidate = [...tabs.slice(from + 1), ...tabs.slice(0, from)].find((id) => !open.includes(id))
    if (candidate) {
      state.openSplit(projectId, candidate)
      return
    }
    // Nessuna chat da affiancare: si apre una nuova chat, che finisce accanto a questa appena nasce.
    state.select({ kind: 'new', projectId })
    set({ pendingSplit: { projectId, base: split?.active ?? selection.sessionId } })
  },

  closeColumn: (projectId, sessionId) => {
    const state = get()
    const split = cleanSplit(state, projectId)
    if (!split?.sessions.includes(sessionId)) return
    const { split: next, neighbor } = withoutColumn(split, sessionId)
    const wasSelected = state.selection.kind === 'session' && state.selection.sessionId === sessionId
    set((current) =>
      patchUi(current, projectId, (ui) => {
        const rest = { ...ui }
        if (next) rest.split = next
        else delete rest.split
        return rest
      })
    )
    if (wasSelected && neighbor) get().select({ kind: 'session', projectId, sessionId: neighbor })
  },

  focusColumn: (delta) => {
    const state = get()
    const { selection } = state
    if (selection.kind !== 'session') return false
    const columns = liveColumns(state, selection.projectId)
    const at = columns.indexOf(selection.sessionId)
    const target = at < 0 ? undefined : columns[at + delta]
    if (!target) return false
    state.select({ kind: 'session', projectId: selection.projectId, sessionId: target }, { history: false })
    // Il composer della colonna riceve il focus: le scorciatoie e la scrittura continuano lì.
    window.requestAnimationFrame(() => document.getElementById(`composer-${target}`)?.focus())
    return true
  },

  setSplitDrop: (on) => set((state) => (state.splitDrop === on ? {} : { splitDrop: on })),
  setQuickOpen: (open) => set({ quickOpen: open }),
  toggleQuickOpen: () => set((state) => ({ paletteOpen: false, quickOpen: !state.quickOpen })),

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
  setNewPreset: (value) => set({ newPreset: value }),
  setPresetEditor: (value) => set({ presetEditor: value }),

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

  setPrefs: (prefs) => set({ prefs }),
  setOnboarding: (onboarding) => set({ onboarding }),
  hideDetectedAgents: () => set({ detectedAgentsHidden: true }),
  focusConnection: (id, profileId) => {
    set({ connectionFocus: { id, ...(profileId ? { profileId } : {}), nonce: ++nonce } })
    useSettings.getState().openSection('subscriptions')
  },
  consumeConnectionFocus: (value) => set((state) => (state.connectionFocus?.nonce === value ? { connectionFocus: null } : {}))
}))
