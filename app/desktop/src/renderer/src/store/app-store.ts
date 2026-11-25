// Renderer state: a copy of what the host publishes plus the interface state (selection, open folders).
import { create } from 'zustand'
import { isElectron, onHostConnect, request, send } from '@/lib/host-client'
import { applyProjectGroupOp, normalizeProjectGroups, type ProjectGroupOp } from '@/lib/project-groups'
import type { AgentBrowserState, AgentId, AgentStatus, Effort, AppPrefs, Attachment, BranchMap, BrowserState, ShortcutsState, ChatItem, ConnectionId, ConnectionStatus, OtherAgentConnection, Profile, ReviewState, SlashCommand, DiffScope, GitStatus, HostCommand, HostEvent, InspectorTab, IssueItem, Project, ProjectGroupsState, ProjectUiState, SessionPreset, SessionSummary, TerminalInfo, RemoteStatus } from '@shared/protocol'
import { isConcluded, needsYou, CONCLUDED_AFTER_MS } from '@/lib/session-state'
import { routeTerminalCleared, routeTerminalData } from '@/lib/terminal-registry'
import { disposeBuffer } from '@/components/editor/buffers'
import { fileTabId, parseFileTab } from '@shared/file-tabs'
import { clipTitle, isBrowserTabId, newBrowserTabId, storableUrl } from '@/lib/browser-tabs'
import { agentTabSession, hasAgentTab, isAgentTabId } from '@/lib/browser-agent'
import { applyShortcutConfig } from '@shared/shortcuts'
import { plural, t } from '@shared/i18n'
import { useSettings } from '@/hooks/use-theme'
import { isDefaultProfileId } from '@/lib/profile-id'
import type { Plan, PlanChoice, PlanState, PlanTemplate } from '@shared/plan'

/** Agent states from the snapshot: each one's default in `agents`, the other profiles by id. */
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

/** Draft of a plan card in review: the edited plan, the revision it builds on and that plan as it was (to show what the agent changed in the meantime). */
export interface PlanDraft {
  base: number
  basePlan: Plan
  plan: Plan
}

/** Result of a plan command: the error is already translated by the host. */
export type PlanResult<T> = { ok: true; data: T } | { ok: false; error: string }

interface AppState {
  connected: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  items: Record<string, ChatItem[]>
  drafts: Record<string, string>
  /** Agent-declared / commands, per session. Absent: not loaded yet. */
  commands: Record<string, SlashCommand[]>
  ui: Record<string, ProjectUiState>
  /** Agent state with the default profile (one per agent). The other profiles are in `profileAgents`. */
  agents: AgentStatus[]
  /** Claude Code and Codex profiles, defaults included. Empty in fixtures: it means "defaults only" (see lib/profiles.ts). */
  profiles: Profile[]
  /** Agent state for non-default profiles, by profile id: account, models and limits are their own. */
  profileAgents: Record<string, AgentStatus>
  /** It also says the selected project: tabs, files, terminal and new chat follow it. */
  selection: Selection
  /** First unread item when the session was opened, for the "New" divider. */
  firstUnread: Record<string, number | null>
  /** Sidebar visible. It is remembered between launches. */
  sidebarOpen: boolean
  paletteOpen: boolean
  /** Session whose title is being edited in the sidebar. */
  renaming: string | null
  /** Group whose name is being edited in the sidebar. */
  renamingGroup: string | null
  /** Project sections in the sidebar. Null: no sections (fixtures and hosts that don't know them), all projects in order. */
  projectGroups: ProjectGroupsState | null
  /** Section whose name is being edited in the sidebar. */
  renamingProjectGroup: string | null
  /** Last error of a sidebar command (project sections, title regeneration), already translated by the host. It clears itself after 6 s. */
  sidebarNotice: string | null
  /** 'error' for a failed command (pink), 'info' for information (dim), for example automatically archived sessions. */
  sidebarNoticeTone: 'error' | 'info'
  /** Files open as tabs with unsaved changes, by tab id. */
  dirtyFiles: Record<string, boolean>
  /** File whose tab is being closed with unsaved changes: the user is asked what to do. */
  closingFile: { projectId: string; root: string; path: string } | null
  /** Open session that the user marked as unread: the view must not mark it read again until the selection changes. */
  heldUnread: string | null
  /** History of selections for Back/Forward; `historyIndex` points to the current selection. */
  history: Selection[]
  historyIndex: number
  terminals: Record<string, TerminalInfo>
  /** Per-folder counter: it grows when the host reports a change, and the views re-read. */
  fsVersion: Record<string, number>
  // ── Git state of watched sessions ──
  /** Lightweight git state per folder (key `GitStatus.root`), only for sessions watched with `watchGit`. */
  gitStatus: Record<string, GitStatus>
  /** Git folder of each watched session, known after the first `git.status`. */
  gitRoot: Record<string, string>
  /** Subscribes the session to the header's git updates (idempotent) and reads the initial state. */
  watchGit: (sessionId: string) => void
  /** Removes the subscription (idempotent). */
  unwatchGit: (sessionId: string) => void
  // ── end of git state ──
  // ── Branch maps ──
  /** Branch map per project, read by the host only while the History or Merge tab is looking at it (`watchBranchMap`). */
  branchMaps: Record<string, BranchMap>
  /** Last failed map request, per project: the UI shows the error with "Retry" instead of "Reading branches…". It clears on the first success. */
  branchMapError: Record<string, string>
  /** Re-reads the watched project's map (the "Retry" after an error). */
  retryBranchMap: (projectId: string) => void
  /** Subscribes the window to the project's map updates (idempotent) and reads the initial map. */
  watchBranchMap: (projectId: string) => void
  /** Removes the subscription (idempotent). The map already read stays until the project is removed. */
  unwatchBranchMap: (projectId: string) => void
  // ── end of branch maps ──
  /** Last request to open the inspector: a file in the viewer or a diff scope. */
  inspectorRequest: InspectorRequest | null
  /** Text to insert in the composer with the given key (Add to chat, @terminal). */
  composerInsert: { key: string; text: string; nonce: number } | null
  /** Replaces the draft of an already mounted composer (session profile, ⌘⇧N); whoever asks updates the store and the host. */
  composerReplace: { key: string; text: string; nonce: number } | null
  replaceComposerDraft: (key: string, text: string) => void
  /** Images waiting to enter the composer with the given key (browser screenshots): the composer takes them as soon as it is mounted. */
  composerAttachments: Record<string, Attachment[]>
  /** Built-in browser: last state sent by main for each tab, including those not open right now. */
  browserStates: Record<string, BrowserState>
  /** Agent browser (part 2): last full state sent by the host per session. The agent's tab is ephemeral, it is not in `ui`. */
  agentBrowser: Record<string, AgentBrowserState>
  /** session -> tabId of the agent's view that lives in another window (`open` returned null with the state still active): it is not shown here. */
  agentForeign: Record<string, string>
  /** Last local server seen in each project's terminal and not yet opened or dismissed. */
  devServers: Record<string, { url: string; terminalId: string }>
  quickOpen: boolean
  /** A tab is being dragged onto the right or bottom edge of the view: shows where the new column will open. */
  splitDrop: boolean
  /** ⌘\ with no other chats to split: the next session chosen or created in the project opens next to `base`. */
  pendingSplit: { projectId: string; base: string } | null
  /** Item to reach when the session opens (⌘⇧A, notification, search): the view scrolls there and takes focus. */
  focusTarget: { sessionId: string; itemId: string | null; nonce: number } | null
  /** Sidebar "Waiting" popover. */
  inboxOpen: boolean
  /** "New session from…" window (⌘⇧N). */
  newFromOpen: boolean
  /** Issue, PR or branch chosen for the project's new chat. */
  newSource: { projectId: string; item: IssueItem } | null
  /** Session profile to apply to the project's new chat: the new chat reads it once and clears it. */
  newPreset: { projectId: string; presetId: string } | null
  /** "Save as profile" window opened from the session menu or ⌘K; `seed` prefills the fields, `presetId` edits an existing one. */
  presetEditor: { presetId?: string; seed?: Partial<SessionPreset> } | null
  /** "Hand off to…" dialog for the given session; `agent` and `note` prefill the fields (from /handoff <agent> <note>). */
  handoffDialog: { sessionId: string; agent?: AgentId; note?: string } | null
  /** "Ask for advice…" dialog: /advisor without an agent (single mode) or /committee. `question` prefills the question. */
  adviceDialog: { sessionId: string; mode: 'advisor' | 'committee'; question?: string } | null
  /** Plan opened as a commentable document: markdown text and the session it comes from. */
  planDocument: { sessionId: string; text: string } | null
  /** "While you were away" summary per project, computed when you come back after more than 30 minutes. */
  away: Record<string, AwaySummary>
  prefs: AppPrefs | null
  /** State of the remote channel: paired devices, connected, active QR. Null until the host has sent it. */
  remote: RemoteStatus | null
  /** Connections (Claude, Codex, GitHub). Empty until the host has read them. */
  connections: Partial<Record<ConnectionId, ConnectionStatus>>
  /** Connections of non-default profiles (Claude Code, Codex), by profile id. */
  profileConnections: Record<string, ConnectionStatus>
  /** "Other agents" (CLIs like Gemini, Copilot, Cursor) with sign-in state. Null until `agents.others` has answered; `agent.connection` events update the row with the same id. */
  otherAgents: OtherAgentConnection[] | null
  setOtherAgents: (list: OtherAgentConnection[]) => void
  /** First launch: `open` until Continue or Skip is pressed, even if an agent connects in the meantime. `done` until the next launch. */
  onboarding: 'idle' | 'open' | 'done'
  /** Grows when GitHub connects or disconnects: issues and the Merge panel re-read. */
  githubVersion: number
  /** Row of Settings → Subscriptions to focus (from the composer or the Merge panel). */
  connectionFocus: { id: ConnectionId; profileId?: string | null; nonce: number; highlight?: boolean } | null
  setOnboarding: (state: 'idle' | 'open' | 'done') => void
  /** "Other agents found on your Mac" hidden with Hide: it holds until the app closes, it is not a preference. */
  detectedAgentsHidden: boolean
  hideDetectedAgents: () => void
  /** Takes the user to the connection's row in Settings → Subscriptions. */
  /** `highlight`: the row is highlighted for a moment (from the limits panel in the composer). */
  focusConnection: (id: ConnectionId, profileId?: string | null, options?: { highlight?: boolean }) => void
  consumeConnectionFocus: (nonce: number) => void
  /** Reviews requested from another agent, by id: running, finished or failed. */
  reviews: Record<string, ReviewState>
  // ── Executable plans ──
  /** Plans by id: from the snapshot and `plan.updated`. The card in the coordinator chat reads from here. */
  plans: Record<string, PlanState>
  /** Saved plan templates. Null until `plan.templates` has answered. */
  planTemplates: PlanTemplate[] | null
  /** Unsent edits of the card in review, per plan: they survive the row unmounting (the chat is virtualized). */
  planDrafts: Record<string, PlanDraft>
  setPlanDraft: (planId: string, draft: PlanDraft | null) => void
  /** Saves the user's edit (plan.edit). No sidebar notice: the card shows the error. */
  planEdit: (planId: string, revision: number, plan: Plan) => Promise<PlanResult<PlanState>>
  /** Approves and runs (plan.approve). No sidebar notice: the card shows the error. */
  planApprove: (planId: string, revision: number, workspace: 'main' | 'worktree') => Promise<PlanResult<PlanState>>
  planReject: (planId: string, message?: string) => Promise<PlanResult<unknown>>
  planChoose: (planId: string, choice: PlanChoice, taskId?: string, reassign?: { agent: AgentId; model: string | null; effort: Effort | null; keepWork: boolean }) => Promise<PlanResult<PlanState>>
  planConfirmUpdate: (planId: string, accept: boolean) => Promise<PlanResult<PlanState>>
  planStop: (planId: string) => Promise<PlanResult<PlanState>>
  loadPlanTemplates: () => Promise<PlanResult<PlanTemplate[]>>
  savePlanTemplate: (planId: string, name: string) => Promise<PlanResult<PlanTemplate>>
  deletePlanTemplate: (templateId: string) => Promise<PlanResult<unknown>>
  /** Creates a plan in review from the session (idle chat) with a template and a goal. */
  startPlanFromTemplate: (sessionId: string, templateId: string, goal: string) => Promise<PlanResult<PlanState>>
  /** Shortcuts in use (preset, customizations, file warnings). Null until the host has sent them: defaults apply. Each new state makes labels re-read. */
  shortcuts: ShortcutsState | null
  /** Applies the shortcuts state to the shared registry (global listener, palette, tooltips, editor). */
  applyShortcuts: (state: ShortcutsState) => void
  /** Closed tabs per project, the most recent last (⌘⇧T). In memory only, at most MAX_CLOSED_TABS. */
  closedTabs: Record<string, ClosedTab[]>
  /** Request to focus the Files panel filter (Search in project); the panel consumes it. */
  filesFilterFocus: { projectId: string; nonce: number } | null
  consumeFilesFilterFocus: (nonce: number) => void
  applyEvent: (event: HostEvent) => void
  /** `history: false` changes the selection without adding an entry to ⌘[ ⌘] (for example when moving between columns). */
  select: (selection: Selection, options?: { history?: boolean }) => void
  openFile: (projectId: string, root: string, path: string) => void
  closeFile: (projectId: string, root: string, path: string, force?: boolean) => void
  cancelCloseFile: () => void
  setFileDirty: (id: string, dirty: boolean) => void
  /** New group, with the given sessions already inside. */
  createGroup: (projectId: string, sessionIds?: string | string[]) => void
  renameGroup: (projectId: string, groupId: string, name: string) => void
  startRenameGroup: (groupId: string) => void
  stopRenameGroup: () => void
  deleteGroup: (projectId: string, groupId: string) => void
  toggleGroup: (projectId: string, groupId: string) => void
  moveToGroup: (projectId: string, sessionId: string, groupId: string | null) => void
  /** Moves several sessions together into a group (or out, with null). */
  moveSessionsToGroup: (projectId: string, sessionIds: string[], groupId: string | null) => void
  /** New section at the end, with the given projects already inside; the name goes into editing in the sidebar. */
  createProjectGroup: (projectIds?: string[]) => Promise<void>
  renameProjectGroup: (groupId: string, name: string) => void
  startRenameProjectGroup: (groupId: string) => void
  stopRenameProjectGroup: () => void
  /** Deletes the section: the projects stay, after those without a section. */
  deleteProjectGroup: (groupId: string) => void
  toggleProjectGroup: (groupId: string) => void
  reorderProjectGroups: (groupIds: string[]) => void
  /** Moves a project into a section (or out, with null) at the given position, counted without it. It also serves to reorder. */
  moveProject: (projectId: string, groupId: string | null, index?: number) => void
  clearSidebarNotice: () => void
  /** Shows in the notices banner the error of a command run outside the sidebar. */
  notifyError: (error: unknown) => void
  /** Confirmation in the notices banner (dim tone). */
  notifyInfo: (text: string) => void
  setDraft: (key: string, text: string) => void
  /** Asks the host for the session's / commands (on open and on reconnect). */
  loadCommands: (sessionId: string) => void
  setUi: (projectId: string, state: ProjectUiState) => void
  closeTab: (projectId: string, sessionId: string) => void
  /** Moves a tab to position `toIndex` among those of the same kind (chat or file). The order is saved per project. */
  reorderTab: (projectId: string, tabId: string, toIndex: number) => void
  /** ⌘⌥⇧← and ⌘⌥⇧→: move the active tab by one position. */
  /** Moves the active tab by one place. Returns true if it moved. */
  moveActiveTab: (projectId: string, delta: -1 | 1) => boolean
  /** Next (+1) or previous (-1) tab of the project, cycling: chats first, then files, as in the bar. Returns true if the selection changed. */
  cycleTab: (projectId: string, delta: -1 | 1) => boolean
  /** Reopens the project's last closed tab (chat or file). Skips those that can no longer be reopened. Returns true if it reopened one. */
  reopenClosedTab: (projectId: string) => boolean
  /** Search in project: opens the inspector's Files panel with focus on the filter. */
  searchInProject: (projectId: string) => void
  /** Goes back to a project: reopens the active tab it had, or the new chat. */
  selectProject: (projectId: string) => void
  toggleSidebar: () => void
  setPaletteOpen: (open: boolean) => void
  /** Starts editing the title: opens the sidebar and the project if needed. */
  startRename: (sessionId: string) => void
  /** Asks the host for a newly generated title. The title arrives with session.upsert; the error, already translated, is shown like the other sidebar ones. */
  regenerateTitle: (sessionId: string) => void
  stopRename: () => void
  /** Back (-1) or forward (+1) in the history, skipping archived sessions. */
  navigate: (delta: -1 | 1) => void
  /** Archives: the row disappears, the tab closes and, if it was open, it moves to the neighboring tab or the new chat. */
  archiveSession: (sessionId: string) => void
  /** Removes the project from Ladder (files stay). Its sessions are archived, so they stop. */
  removeProject: (projectId: string) => Promise<void>
  /** Opens the next waiting session after the current one. Returns false if there are none. */
  goToNextWaiting: () => boolean
  markUnread: (sessionId: string) => void
  markRead: (sessionId: string) => void
  /** Opens the project's inspector on a tab, with a file or a diff scope. */
  openInspector: (projectId: string, tab: InspectorTab, extra?: Omit<InspectorRequest, 'projectId' | 'tab' | 'nonce'>) => void
  /** Opens or closes the inspector; with a `tab` different from the open one it switches tab. */
  toggleInspector: (projectId: string, tab?: InspectorTab) => void
  setTerminalPanel: (projectId: string, patch: Partial<NonNullable<ProjectUiState['terminal']>>) => void
  insertIntoComposer: (key: string, text: string) => void
  /** Queues an image for the composer with the given key. */
  queueComposerAttachment: (key: string, attachment: Attachment) => void
  /** The composer took the queued images. */
  takeComposerAttachments: (key: string) => Attachment[]
  /** Opens the project's browser column on its active page (or the first, or creates one); `fresh` always opens a new one. With `url` it navigates there. It does not change the selection. */
  openBrowser: (projectId: string, options?: { url?: string; fresh?: boolean }) => string
  /** Closes the page and destroys its native view. When the last one is closed, the column closes too. */
  closeBrowser: (projectId: string, tabId: string) => void
  /** Opens the browser column (with `tabId` on that page). It does not change the selection and does not create pages. */
  showBrowserColumn: (projectId: string, tabId?: string) => void
  closeBrowserColumn: (projectId: string) => void
  /** Opens or closes the column; opened without pages it creates one. */
  toggleBrowserColumn: (projectId: string) => void
  /** Chosen width of the column; `undefined` goes back to the default. */
  setBrowserColumnWidth: (projectId: string, width: number | undefined) => void
  setBrowserState: (state: BrowserState) => void
  /** Replaces the agent browser state of a session; with `closed` it removes it. Opens and shows the view the first time. */
  applyAgentBrowser: (state: AgentBrowserState) => void
  /** Load on every connection (`browser.agent.state`, full list): replaces the state and finds the views again, without changing what is being looked at. */
  loadAgentBrowser: (states: AgentBrowserState[]) => void
  /** Shows the session's agent browser tab. */
  showAgentBrowser: (sessionId: string) => void
  /** Asks main for the agent's view. `null` with active state = it belongs to another window. Without `force`, at most one attempt per second per session. */
  probeAgentBrowser: (sessionId: string, force?: boolean) => Promise<void>
  /** Closes the agent's tab: it counts as a stop (the view is destroyed and the host refuses later calls). */
  closeAgentBrowser: (sessionId: string) => void
  /** Re-enables the agent browser after an explicit stop or tab close: tools come back right away, the tab is recreated at the agent's first action. */
  resumeAgentBrowser: (sessionId: string) => Promise<void>
  dismissDevServer: (projectId: string) => void
  /** Opens the session in a column next to the active one (or at the end, with `at: 'end'`). Already open: activates it. Columns full: takes the place of the active one. Returns true if a new column opened. */
  openSplit: (projectId: string, sessionId: string, options?: { at?: 'end' }) => boolean
  /** ⌘\ Split: the next open chat not yet in a column, or a new chat that opens next to it. */
  splitActive: () => void
  /** Removes the column from the view; the tab and the session stay. */
  closeColumn: (projectId: string, sessionId: string) => void
  /** ⌘⌥← and ⌘⌥→: the column to the left or right becomes active. */
  focusColumn: (delta: -1 | 1) => boolean
  setSplitDrop: (on: boolean) => void
  /** Proportions of the project's split columns; undefined = equal parts. */
  setColumnWidths: (projectId: string, widths: number[] | undefined) => void
  setQuickOpen: (open: boolean) => void
  /** ⌘P and the project name in the bar: closes the palette and opens or closes the file search. */
  toggleQuickOpen: () => void
  /** Opens the session (in its project and its tab) and asks the view to reach the item. */
  openSessionAt: (sessionId: string, itemId: string | null) => boolean
  consumeFocus: (nonce: number) => void
  setInboxOpen: (open: boolean) => void
  setNewFromOpen: (open: boolean) => void
  setNewSource: (source: { projectId: string; item: IssueItem } | null) => void
  setNewPreset: (value: { projectId: string; presetId: string } | null) => void
  setPresetEditor: (value: { presetId?: string; seed?: Partial<SessionPreset> } | null) => void
  setHandoffDialog: (value: { sessionId: string; agent?: AgentId; note?: string } | null) => void
  setAdviceDialog: (value: { sessionId: string; mode: 'advisor' | 'committee'; question?: string } | null) => void
  setPlanDocument: (value: { sessionId: string; text: string } | null) => void
  /** You left the project (or the window): the "While you were away" count starts from here. */
  markSeen: (projectId: string) => void
  /** You came back to the project: if you were away for more than 30 minutes, it prepares the summary. */
  checkAway: (projectId: string) => void
  dismissAway: (projectId: string) => void
  setPrefs: (prefs: AppPrefs) => void
}

/** A closed tab that ⌘⇧T can reopen. */
export type ClosedTab = { kind: 'session'; sessionId: string } | { kind: 'file'; root: string; path: string } | { kind: 'browser'; tabId: string; url: string }

const MAX_CLOSED_TABS = 20

/** Stack of the project's closed tabs with `entry` on top, without duplicates and limited to MAX_CLOSED_TABS. */
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

/** Beyond this absence, coming back to the project shows "While you were away". */
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
/** Maximum number of split columns. */
export const MAX_COLUMNS = 3
const NO_COLUMNS: string[] = []
const MAX_HISTORY = 50
const SIDEBAR_KEY = 'ladder.sidebar'

// One timer per project: two projects changed close together do not overwrite each other's save.
const uiTimers = new Map<string, number>()
function persistUi(projectId: string, state: ProjectUiState): void {
  const timer = uiTimers.get(projectId)
  if (timer) window.clearTimeout(timer)
  uiTimers.set(
    projectId,
    window.setTimeout(() => {
      uiTimers.delete(projectId)
      // The current state at the time of sending, not the snapshot: a delayed save does not erase changes that arrived later.
      send({ type: 'ui.set', projectId, state: useApp.getState().ui[projectId] ?? state })
    }, 300)
  )
}
const emptyUi = (): ProjectUiState => ({ tabs: [], activeTab: null, scroll: {} })
/** Last chat looked at per project: used by "Add to chat" when on a tab that is not a chat. In memory only. */
const lastSession = new Map<string, string>()

/**
 * Where browser screenshots and citations go: the active column if there are split columns, otherwise the last chat
 * looked at, otherwise the new chat's draft. `key` is the composer draft key.
 */
export function chatTargetFor(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): { key: string; sessionId: string | null } {
  const split = cleanSplit(state, projectId)
  const candidates = [split?.active, lastSession.get(projectId), ...[...(state.ui[projectId]?.tabs ?? [])].reverse()]
  const sessionId = candidates.find((id): id is string => Boolean(id) && state.sessions[id!]?.projectId === projectId && isLiveSession(state, state.sessions[id!]))
  return sessionId ? { key: sessionId, sessionId } : { key: `new:${projectId}`, sessionId: null }
}

/** Frees the native views of a removed project and clears the cookies and storage of its partition (`persist:project-<id>`). */
function purgeProjectBrowser(projectId: string): void {
  void window.ladder?.browser?.purge(projectId)?.catch(() => undefined)
}

/** A tab's address and title are saved (and go to the host) after a 1 s pause: they change continuously while loading. */
const BROWSER_SAVE_DELAY = 1000
// Attempts to open the agent's view: one at a time per session and with a minimum gap, to avoid loops.
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

// ── Sessions whose git state the header watches ──
const gitWatched = new Set<string>()
/** Reads the watched session's git state; ignores the response if it is no longer watched in the meantime. */
function loadGitStatus(sessionId: string): void {
  request<GitStatus | null>({ type: 'git.status', sessionId })
    .then((status) => {
      // Removed in the meantime, or not a repository: nothing to show.
      if (!status || !gitWatched.has(sessionId)) return
      useApp.setState((state) => ({ gitStatus: { ...state.gitStatus, [status.root]: status }, gitRoot: { ...state.gitRoot, [sessionId]: status.root } }))
    })
    .catch(() => {})
}
// New connection with the host (restart or port arrived later): the host's subscriptions live per port and the port is new, so the UI redoes them.
onHostConnect(() => {
  for (const sessionId of gitWatched) {
    send({ type: 'git.watch', sessionId, on: true })
    loadGitStatus(sessionId)
  }
})
/**
 * Stopping watching a session does not delete its git state: coming back to the tab the header immediately shows
 * the last known state (then updated by `loadGitStatus`) instead of disappearing and reappearing when tabs are moved.
 * `git.status` events arrive only for watched sessions, so the stale data gets no updates
 * until the tab becomes visible again.
 */
function dropGit(_sessionId: string): void {}

/** Before the host answers: a session without a worktree works in the project folder, whose state may already be known. */
function seedGitRoot(sessionId: string): void {
  useApp.setState((state) => {
    if (state.gitRoot[sessionId] !== undefined) return {}
    const session = state.sessions[sessionId]
    if (!session || session.worktree) return {}
    const project = state.projects.find((p) => p.id === session.projectId)
    if (!project || !state.gitStatus[project.path]) return {}
    return { gitRoot: { ...state.gitRoot, [sessionId]: project.path } }
  })
}

// ── Projects whose branch map the History or Merge tab looks at ──
const branchMapWatched = new Set<string>()
/** Reads the watched project's map; ignores the response if it is no longer watched in the meantime. */
function loadBranchMap(projectId: string): void {
  request<BranchMap>({ type: 'project.branchMap', projectId })
    .then((map) => {
      if (!branchMapWatched.has(projectId)) return
      useApp.setState((state) => {
        const { [projectId]: _gone, ...branchMapError } = state.branchMapError
        return { branchMaps: { ...state.branchMaps, [projectId]: map }, branchMapError }
      })
    })
    .catch((error: unknown) => {
      if (!branchMapWatched.has(projectId)) return
      useApp.setState((state) => ({ branchMapError: { ...state.branchMapError, [projectId]: error instanceof Error ? error.message : String(error) } }))
    })
}
// New connection with the host: subscriptions live per connection, so the UI redoes them and re-reads.
onHostConnect(() => {
  for (const projectId of branchMapWatched) {
    send({ type: 'project.branchMap.watch', projectId, on: true })
    loadBranchMap(projectId)
  }
})
// ── end of branch maps ──

// Remote channel state: read on every (re)connection, then updated by `remote.status` events.
onHostConnect(() => {
  request<RemoteStatus>({ type: 'remote.status' })
    .then((status) => useApp.setState({ remote: status }))
    .catch(() => {})
})

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
    // Just a convenience: without storage it starts again from the first project.
  }
}
function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed')
  } catch {
    // Just a convenience: without storage the sidebar is visible again at the next launch.
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
  return a.kind === b.kind && a.projectId === b.projectId
}

/** Visible session: not archived and with its project still present. */
export function isLiveSession(state: Pick<AppState, 'projects'>, session: SessionSummary | undefined): session is SessionSummary {
  return Boolean(session && !session.archived && state.projects.some((p) => p.id === session.projectId))
}

/** Session to list (sidebar, ⌘K, order, "while you were away"): alive and not a child of another (advice, delegations), which opens from its parent. */
export function isListedSession(state: Pick<AppState, 'projects'>, session: SessionSummary | undefined): session is SessionSummary {
  return isLiveSession(state, session) && !session.parent
}

function isValidEntry(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, entry: Selection): boolean {
  if (entry.kind === 'session') return isLiveSession(state, state.sessions[entry.sessionId])
  return entry.projectId === null ? state.projects.length === 0 : state.projects.some((p) => p.id === entry.projectId)
}

/** Adds `next` after the current entry, discarding the forward ones. No consecutive duplicates. */
function pushHistory(state: AppState, next: Selection): Pick<AppState, 'history' | 'historyIndex'> {
  let entries = state.history.slice(0, state.historyIndex + 1)
  const last = entries[entries.length - 1]
  if (!last || !sameSelection(last, state.selection)) entries.push(state.selection)
  if (!sameSelection(entries[entries.length - 1], next)) entries.push(next)
  if (entries.length > MAX_HISTORY) entries = entries.slice(entries.length - MAX_HISTORY)
  return { history: entries, historyIndex: entries.length - 1 }
}

/** History without the entries that can no longer be reached (archived sessions, removed projects). */
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

/** Effects of a selection on tabs, open folders and the "New" divider. It does not touch the history. */
function selectionPatch(state: AppState, selection: Selection): Partial<AppState> {
  writeLastProject(selection.projectId)
  if (selection.kind === 'file') {
    const ui = state.ui[selection.projectId] ?? emptyUi()
    const known = ui.fileTabs?.some((f) => f.root === selection.root && f.path === selection.path)
    const nextUi = { ...ui, fileTabs: known ? ui.fileTabs : [...(ui.fileTabs ?? []), { root: selection.root, path: selection.path }], activeTab: fileTabId(selection.root, selection.path) }
    persistUi(selection.projectId, nextUi)
    return { selection, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null, pendingSplit: null }
  }
  if (selection.kind !== 'session') return { selection, heldUnread: null, pendingSplit: null }
  lastSession.set(selection.projectId, selection.sessionId)
  const session = state.sessions[selection.sessionId]
  const firstUnread = { ...state.firstUnread }
  // The "New" divider is computed on open and stays fixed while the session is open.
  if (session && !(selection.sessionId in firstUnread)) firstUnread[selection.sessionId] = session.unread ? session.lastReadSeq + 1 : null
  // The open session becomes a tab of its project; beyond 8 tabs the least recent is closed.
  const ui = state.ui[selection.projectId] ?? emptyUi()
  let tabs = ui.tabs.includes(selection.sessionId) ? ui.tabs : [...ui.tabs, selection.sessionId]
  if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS)
  let nextUi: ProjectUiState = { ...ui, tabs, activeTab: selection.sessionId }
  // With split columns the chosen session is either already a column (it becomes active) or takes the place of the active column.
  // After ⌘\ with no other chats, the new session opens next to the one it started from instead.
  const split = cleanSplit(state, selection.projectId)
  const pending = state.pendingSplit?.projectId === selection.projectId && state.pendingSplit.base !== selection.sessionId ? state.pendingSplit : null
  const base = split?.active ?? pending?.base ?? null
  if (split && split.sessions.includes(selection.sessionId)) nextUi = withSplit(nextUi, { ...split, active: selection.sessionId })
  else if (pending && isLiveSession(state, state.sessions[pending.base])) {
    const sessions = withColumn(split?.sessions ?? [pending.base], split?.active ?? pending.base, selection.sessionId)
    nextUi = withSplit(nextUi, { sessions, active: selection.sessionId })
  } else if (split && base) nextUi = withSplit(nextUi, { sessions: split.sessions.map((id) => (id === base ? selection.sessionId : id)), active: selection.sessionId })
  else if (ui.split) nextUi = withSplit(nextUi, undefined)
  persistUi(selection.projectId, nextUi)
  return { selection, firstUnread, ui: { ...state.ui, [selection.projectId]: nextUi }, heldUnread: null, pendingSplit: null }
}

/** Sessions in sidebar order: projects in order, then the most recent at the top. */
function sidebarOrder(state: AppState): SessionSummary[] {
  const rank = new Map(state.projects.map((p, i) => [p.id, i]))
  return Object.values(state.sessions)
    .filter((s) => isListedSession(state, s))
    .sort((a, b) => rank.get(a.projectId)! - rank.get(b.projectId)! || b.createdAt - a.createdAt)
}

/** Split columns of the project: only live sessions of the project. Fewer than two: no split (stray ids after a restart). */
export function liveColumns(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): string[] {
  const split = state.ui[projectId]?.split
  if (!split) return NO_COLUMNS
  const ids = split.sessions.filter((id, i, all) => all.indexOf(id) === i && state.sessions[id]?.projectId === projectId && isLiveSession(state, state.sessions[id])).slice(0, MAX_COLUMNS)
  return ids.length >= 2 ? ids : NO_COLUMNS
}

/** The next chat open in a tab that is not yet in a column, starting from the one after the current (rule of ⌘\ and the Split button). */
export function splitCandidate(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string, currentId: string): string | undefined {
  const open = liveColumns(state, projectId)
  const taken = open.length >= 2 ? open : [currentId]
  const tabs = (state.ui[projectId]?.tabs ?? []).filter((id) => isLiveSession(state, state.sessions[id]) && state.sessions[id].projectId === projectId)
  const from = Math.max(0, tabs.indexOf(currentId))
  return [...tabs.slice(from + 1), ...tabs.slice(0, from)].find((id) => !taken.includes(id))
}

/** Cleaned-up split: live columns and a valid active column, or undefined if nothing is left to split. */
function cleanSplit(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): { sessions: string[]; active: string } | undefined {
  const sessions = liveColumns(state, projectId)
  if (sessions.length < 2) return undefined
  const active = state.ui[projectId]?.split?.active
  return { sessions, active: active && sessions.includes(active) ? active : sessions[0] }
}

/** Sets (or removes) the project's split. If the set or order of columns changes, the saved proportions reset: back to equal parts. The only place that writes `split`. */
function withSplit(ui: ProjectUiState, split: { sessions: string[]; active: string } | undefined): ProjectUiState {
  const next = { ...ui }
  const before = ui.split?.sessions
  if (!split || !before || before.length !== split.sessions.length || before.some((id, i) => id !== split.sessions[i])) delete next.columnWidths
  if (split) next.split = split
  else delete next.split
  return next
}

/** Adds `id` to the columns: after `base` (or at the end with `end`). If they are full it takes the place of `base`. */
function withColumn(sessions: string[], base: string | null, id: string, end = false): string[] {
  if (sessions.includes(id)) return sessions
  const list = base && !sessions.includes(base) ? [base, ...sessions] : sessions
  if (list.length >= MAX_COLUMNS) return list.map((s) => (s === base ? id : s)).slice(0, MAX_COLUMNS)
  const at = end || !base ? list.length : list.indexOf(base) + 1
  return [...list.slice(0, at), id, ...list.slice(at)]
}

/** Removes a column: the others stay and the neighboring one becomes active. Fewer than two columns: no split. */
function withoutColumn(split: { sessions: string[]; active: string }, id: string): { split: { sessions: string[]; active: string } | undefined; neighbor: string | null } {
  const at = split.sessions.indexOf(id)
  const rest = split.sessions.filter((s) => s !== id)
  const neighbor = rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null
  const active = split.active === id ? (neighbor ?? '') : split.active
  return { split: rest.length >= 2 ? { sessions: rest, active } : undefined, neighbor }
}

/** What to reopen when going back to a project: its active tab, chat or file, or the new chat. */
function selectionForProject(state: Pick<AppState, 'projects' | 'sessions' | 'ui'>, projectId: string): Selection {
  const ui = state.ui[projectId]
  const file = parseFileTab(ui?.activeTab)
  if (file && ui?.fileTabs?.some((f) => f.root === file.root && f.path === file.path)) return { kind: 'file', projectId, ...file }
  const active = ui?.activeTab
  if (active && !file && isLiveSession(state, state.sessions[active])) return { kind: 'session', projectId, sessionId: active }
  return { kind: 'new', projectId }
}

/** Changes and saves a project's interface state. */
function patchUi(state: AppState, projectId: string, change: (ui: ProjectUiState) => ProjectUiState): Pick<AppState, 'ui'> {
  const next = change(state.ui[projectId] ?? emptyUi())
  persistUi(projectId, next)
  return { ui: { ...state.ui, [projectId]: next } }
}

/** Pages of the browser column: first the saved tabs, then those of the agents still alive and of this window. */
export function browserColumnTabs(state: Pick<AppState, 'ui' | 'agentBrowser' | 'agentForeign' | 'sessions'>, projectId: string): string[] {
  const saved = (state.ui[projectId]?.browserTabs ?? []).map((tab) => tab.id)
  const agents = Object.values(state.agentBrowser)
    .filter((agent) => agent.projectId === projectId && hasAgentTab(agent) && state.agentForeign[agent.sessionId] !== agent.tabId && Boolean(state.sessions[agent.sessionId]) && !state.sessions[agent.sessionId].archived)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((agent) => agent.tabId!)
  return [...saved, ...agents]
}

/** Page shown by the column: the one saved as active if it still exists, otherwise the first. */
export function browserColumnActive(state: Pick<AppState, 'ui' | 'agentBrowser' | 'agentForeign' | 'sessions'>, projectId: string): string | null {
  const tabs = browserColumnTabs(state, projectId)
  const active = state.ui[projectId]?.browserColumn?.active
  return active && tabs.includes(active) ? active : (tabs[0] ?? null)
}

/** The column is visible: it is open and has at least one page. */
export function isBrowserColumnOpen(state: Pick<AppState, 'ui' | 'agentBrowser' | 'agentForeign' | 'sessions'>, projectId: string): boolean {
  return Boolean(state.ui[projectId]?.browserColumn?.open) && browserColumnTabs(state, projectId).length > 0
}

/** State saved by a version that opened the browser as a full-screen tab: the active tab becomes the column's page and the chat goes back to being the selection. */
function migrateBrowserUi(ui: Record<string, ProjectUiState>): Record<string, ProjectUiState> {
  let out = ui
  for (const [projectId, state] of Object.entries(ui)) {
    if (!isBrowserTabId(state.activeTab)) continue
    if (out === ui) out = { ...ui }
    const known = state.browserTabs?.some((tab) => tab.id === state.activeTab)
    out[projectId] = { ...state, activeTab: state.tabs[state.tabs.length - 1] ?? null, ...(known && !state.browserColumn ? { browserColumn: { open: true, active: state.activeTab } } : {}) }
  }
  return out
}

/** After a change in the pages (an agent went away): if the column was open and nothing is left it closes, otherwise the vanished active page gives way to the first. */
function settleBrowserColumn(state: AppState, projectId: string): Partial<AppState> {
  const column = state.ui[projectId]?.browserColumn
  if (!column) return {}
  const tabs = browserColumnTabs(state, projectId)
  const next = tabs.length === 0 ? { ...column, open: false, active: null } : column.active && !tabs.includes(column.active) ? { ...column, active: tabs[0] } : column
  return next === column ? {} : patchUi(state, projectId, (ui) => ({ ...ui, browserColumn: next }))
}

let errorTimer: ReturnType<typeof setTimeout> | undefined

/** Shows an error of a sidebar command: dismissible banner that disappears after 6 s. */
function failSidebarNotice(error: unknown): void {
  clearTimeout(errorTimer)
  useApp.setState({ sidebarNotice: error instanceof Error ? error.message : String(error), sidebarNoticeTone: 'error' })
  errorTimer = setTimeout(() => useApp.setState({ sidebarNotice: null }), 6000)
}

/** Information in the same sidebar banner, in a dim tone; it stays 10 s. */
function infoSidebarNotice(text: string): void {
  clearTimeout(errorTimer)
  useApp.setState({ sidebarNotice: text, sidebarNoticeTone: 'info' })
  errorTimer = setTimeout(() => useApp.setState({ sidebarNotice: null }), 10_000)
}

/** Plan command: an error becomes a result, and with `toast` also a notice like the other sidebar commands. */
async function planRequest<T>(command: HostCommand, toast = true): Promise<PlanResult<T>> {
  try {
    return { ok: true, data: await request<T>(command) }
  } catch (error) {
    if (toast) failSidebarNotice(error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The PlanState in a command response: the store takes it right away, without waiting for `plan.updated`, but never over a newer one. */
function takePlan<T extends PlanState>(result: PlanResult<T>): PlanResult<T> {
  if (result.ok && result.data?.id) {
    const plan = result.data
    useApp.setState((state) => (state.plans[plan.id] && state.plans[plan.id].updatedAt > plan.updatedAt ? {} : { plans: { ...state.plans, [plan.id]: plan } }))
  }
  return result
}

/** Group operations sent to the host and not yet resolved, in order, and the last state confirmed by the host. */
const pendingGroupOps: { id: number; op: ProjectGroupOp }[] = []
let confirmedGroups: ProjectGroupsState | null = null
let groupOpId = 0

/** The confirmed state with the operations still in flight put on top again: what the user must see. */
function replayGroupOps(projects: Project[], base: ProjectGroupsState | null): ProjectGroupsState | null {
  if (pendingGroupOps.length === 0) return base
  return pendingGroupOps.reduce((state, { op }) => applyProjectGroupOp(state, op), normalizeProjectGroups(projects, base))
}

/**
 * Applies the change right away and sends it to the host, which answers with the true state (the same reaches all windows).
 * With several commands in flight each response, or rejection, starts again from the last confirmed state and puts back only the
 * operations still waiting: a late response does not erase the optimistic state of the next command, and a rejection removes
 * only its own. Without a host (web preview) the local state stays.
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
  branchMaps: {}, // branch maps per project
  branchMapError: {},
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
  handoffDialog: null,
  adviceDialog: null,
  planDocument: null,
  away: {},
  prefs: null,
  remote: null,
  connections: {},
  profileConnections: {},
  otherAgents: null,
  onboarding: 'idle',
  detectedAgentsHidden: false,
  githubVersion: 0,
  connectionFocus: null,
  reviews: {},
  plans: {},
  planTemplates: null,
  planDrafts: {},
  shortcuts: null,
  closedTabs: {},
  filesFilterFocus: null,
  applyShortcuts: (shortcuts) => {
    // Shared registry first, then the state: whoever re-reads the labels finds them already new.
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
          const loaded = { projects: event.projects, sessions, ui: migrateBrowserUi(event.ui) }
          // At launch it goes back to the last project looked at, on the tab it had.
          let patch: Partial<AppState> = {}
          if (state.selection.kind === 'new' && !state.selection.projectId) {
            const last = readLastProject()
            const projectId = event.projects.some((p) => p.id === last) ? last : (event.projects[0]?.id ?? null)
            patch = selectionPatch({ ...state, ...loaded }, projectId ? selectionForProject(loaded, projectId) : { kind: 'new', projectId })
          }
          // Without shortcuts in the snapshot (fixtures, old host) the ones already known stay.
          if (event.shortcuts) applyShortcutConfig({ preset: event.shortcuts.preset, overrides: event.shortcuts.overrides })
          return {
            connected: true,
            ...(event.shortcuts ? { shortcuts: event.shortcuts } : {}),
            // Without sections in the snapshot (fixtures, old host) the ones already known stay.
            projectGroups: event.projectGroups ?? state.projectGroups,
            drafts: event.drafts,
            ...splitAgents(event.agents),
            // Without profiles in the snapshot (fixtures, old host) the ones already known stay: if there are none, only the defaults.
            profiles: event.profiles ?? state.profiles,
            // Snapshots without connections (fixtures, old host) do not erase the ones already known.
            ...(event.connections ? splitConnections(event.connections) : {}),
            terminals,
            // Without plans in the snapshot (fixtures, older host) the already known ones stay.
            ...(event.plans ? { plans: Object.fromEntries(event.plans.map((p) => [p.id, p])) } : {}),
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
          branchMapWatched.delete(event.projectId)
          const branchMaps = { ...state.branchMaps }
          delete branchMaps[event.projectId]
          const branchMapError = { ...state.branchMapError }
          delete branchMapError[event.projectId]
          for (const s of Object.values(state.sessions)) if (s.projectId === event.projectId && gitWatched.delete(s.id)) queueMicrotask(() => dropGit(s.id))
          // The commands of the removed project's sessions are no longer needed.
          const commands = { ...state.commands }
          for (const s of Object.values(state.sessions)) if (s.projectId === event.projectId) delete commands[s.id]
          if (state.selection.projectId !== event.projectId) return { projects, commands, branchMaps, branchMapError }
          // The selection was in the removed project: it moves to the new chat of the first remaining project.
          const selection: Selection = { kind: 'new', projectId: projects[0]?.id ?? null }
          return { projects, commands, branchMaps, branchMapError, selection, ...pushHistory(state, selection) }
        }
        case 'sessions.autoArchived': {
          // Tabs close with the session.upsert of the archived sessions; here a notice is shown, once per round.
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
          // Archived by the host (for example when the PR is merged): the tab closes as for an archive from the UI.
          if (event.session.archived && before && !before.archived) {
            queueMicrotask(() => {
              const agent = useApp.getState().agentBrowser[event.session.id]
              if (agent) useApp.getState().applyAgentBrowser({ ...agent, tabId: null, closed: true, action: null })
              useApp.getState().closeTab(event.session.projectId, event.session.id)
            })
          }
          // The host removes the archived session's watch by itself: here the state is cleaned up.
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
          // A non-default profile has its own state: it does not touch the agent's.
          if (!isDefaultProfileId(event.status.profileId)) return { profileAgents: { ...state.profileAgents, [event.status.profileId!]: event.status } }
          // Stable order: Claude Code, Codex, then ACP agents in the order they arrive.
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
        case 'plan.updated': {
          // The plan is no longer in review: the draft is not needed anymore.
          let planDrafts = state.planDrafts
          if (event.plan.status !== 'review' && planDrafts[event.plan.id]) {
            planDrafts = { ...planDrafts }
            delete planDrafts[event.plan.id]
          }
          return { plans: { ...state.plans, [event.plan.id]: event.plan }, planDrafts }
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
          // Output goes straight to xterm: going through the store would re-render on every character.
          routeTerminalData(event.id, event.data)
          return {}
        case 'terminal.cleared':
          routeTerminalCleared(event.id)
          return {}
        case 'browser.agent':
          // Whole on every change: it goes outside the `set` because it opens the view and may change the selection.
          queueMicrotask(() => useApp.getState().applyAgentBrowser(event.state))
          return {}
        case 'browser.devserver': {
          // The same address already open in a project tab does not need to be suggested.
          let origin = event.url
          try {
            origin = new URL(event.url).origin
          } catch {
            // Invalid address: compared as it is.
          }
          const open = state.ui[event.projectId]?.browserTabs?.some((tab) => (state.browserStates[tab.id]?.url ?? tab.url).startsWith(origin))
          return open ? {} : { devServers: { ...state.devServers, [event.projectId]: { url: event.url, terminalId: event.terminalId } } }
        }
        case 'connection.update': {
          // A response sent before `profile.removed` does not bring the removed profile back to life.
          if (!isDefaultProfileId(event.status.profileId) && !state.profiles.some((p) => p.id === event.status.profileId)) return {}
          if (!isDefaultProfileId(event.status.profileId)) return { profileConnections: { ...state.profileConnections, [event.status.profileId!]: event.status } }
          const before = state.connections[event.status.id]
          const linked = (c: ConnectionStatus | undefined) => c?.state === 'connected' && !c.login
          // GitHub just connected (or disconnected): the views that read it refresh. The first state read at launch is not a transition.
          const github = event.status.id === 'github' && before !== undefined && linked(before) !== linked(event.status)
          return { connections: { ...state.connections, [event.status.id]: event.status }, ...(github ? { githubVersion: state.githubVersion + 1 } : {}) }
        }
        case 'agent.connection': {
          // Before the list is read there is nothing to update: the read already brings the latest state.
          if (!state.otherAgents) return {}
          const exists = state.otherAgents.some((a) => a.id === event.agent.id)
          return { otherAgents: exists ? state.otherAgents.map((a) => (a.id === event.agent.id ? event.agent : a)) : [...state.otherAgents, event.agent] }
        }
        case 'git.status': {
          // A late event, after the last `unwatchGit`, does not bring the state back to life.
          if (gitWatched.size === 0) return {}
          return { gitStatus: { ...state.gitStatus, [event.status.root]: event.status } }
        }
        case 'project.branchMap': {
          // A late event, after the last `unwatchBranchMap`, does not bring the map back to life.
          if (!branchMapWatched.has(event.projectId)) return {}
          const { [event.projectId]: _gone, ...branchMapError } = state.branchMapError
          return { branchMaps: { ...state.branchMaps, [event.projectId]: event.map }, branchMapError }
        }
        case 'remote.status':
          return { remote: event.status }
        case 'fs.changed':
          return { fsVersion: { ...state.fsVersion, [event.root]: (state.fsVersion[event.root] ?? 0) + 1 } }
      }
      return {}
    }),

  select: (selection, options) =>
    set((state) => {
      const patch = selectionPatch(state, selection)
      if (options?.history === false) {
        // The current history entry moves to the new selection: Back returns to before the group of columns.
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
      // ⌘⇧T reopens it, but only if the tab was really there.
      const closedTabs = ui.fileTabs?.some((f) => f.root === root && f.path === path) ? withClosedTab(state.closedTabs, projectId, { kind: 'file', root, path }) : state.closedTabs
      if (!wasActive) return { ui: next.ui, dirtyFiles, closingFile: null, closedTabs }
      // It goes to the file open before, then to the last open chat, then to the new chat.
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
    const active = browserColumnActive(state, projectId)
    // Only agent pages and no address to open: it is enough to show the column on the active one.
    if (!options.fresh && !options.url && tabs.length === 0 && active) {
      get().showBrowserColumn(projectId, active)
      return active
    }
    const existing = options.fresh ? undefined : (tabs.find((tab) => tab.id === active) ?? tabs[0])
    const tabId = existing?.id ?? newBrowserTabId()
    if (!existing) {
      // The page is born with its address: the view loads it on first open.
      set((current) => patchUi(current, projectId, (ui) => ({ ...ui, browserTabs: [...(ui.browserTabs ?? []), { id: tabId, url: storableUrl(options.url ?? '') }] })))
    } else if (options.url) {
      // Page already alive: it navigates there, the view updates by itself with the main event.
      void window.ladder?.browser.navigate(tabId, options.url)
      set((current) => patchUi(current, projectId, (ui) => ({ ...ui, browserTabs: (ui.browserTabs ?? []).map((tab) => (tab.id === tabId ? { ...tab, url: storableUrl(options.url!) } : tab)) })))
    }
    // The dev server notice has done its job.
    const { [projectId]: _used, ...devServers } = get().devServers
    set({ devServers })
    get().showBrowserColumn(projectId, tabId)
    return tabId
  },

  showBrowserColumn: (projectId, tabId) =>
    set((state) => {
      const active = tabId ?? browserColumnActive(state, projectId)
      const column = state.ui[projectId]?.browserColumn
      if (column?.open && column.active === active) return {}
      return patchUi(state, projectId, (ui) => ({ ...ui, browserColumn: { ...ui.browserColumn, open: true, active } }))
    }),

  closeBrowserColumn: (projectId) =>
    set((state) => {
      const column = state.ui[projectId]?.browserColumn
      if (!column?.open) return {}
      return patchUi(state, projectId, (ui) => ({ ...ui, browserColumn: { ...column, open: false } }))
    }),

  toggleBrowserColumn: (projectId) => {
    if (isBrowserColumnOpen(get(), projectId)) get().closeBrowserColumn(projectId)
    // Without pages an empty one is created; with pages it reopens where it was.
    else if (browserColumnTabs(get(), projectId).length === 0) get().openBrowser(projectId, { fresh: true })
    else get().showBrowserColumn(projectId)
  },

  setBrowserColumnWidth: (projectId, width) =>
    set((state) =>
      patchUi(state, projectId, (ui) => {
        const { width: _old, ...column } = ui.browserColumn ?? { open: false, active: null }
        return { ...ui, browserColumn: width === undefined ? column : { ...column, width: Math.round(width) } }
      })
    ),

  closeBrowser: (projectId, tabId) => {
    // Closing the agent's tab is a stop, not a close like the others.
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
      const before = browserColumnTabs(state, projectId)
      const wasActive = browserColumnActive(state, projectId) === tabId
      const browserTabs = (ui.browserTabs ?? []).filter((tab) => tab.id !== tabId)
      let nextUi: ProjectUiState = { ...ui, browserTabs, activeTab: ui.activeTab === tabId ? null : ui.activeTab }
      const rest = browserColumnTabs({ ...state, ui: { ...state.ui, [projectId]: nextUi } }, projectId)
      const column = ui.browserColumn
      // When the last page is closed the column closes; when the active one is closed it moves to the neighbor (the previous one, if any).
      if (column && rest.length === 0) nextUi = { ...nextUi, browserColumn: { ...column, open: false, active: null } }
      else if (column && wasActive) nextUi = { ...nextUi, browserColumn: { ...column, active: rest[Math.max(0, before.indexOf(tabId) - 1)] ?? rest[0] } }
      persistUi(projectId, nextUi)
      const browserStates = { ...state.browserStates }
      const last = browserStates[tabId]?.url || closing.url
      delete browserStates[tabId]
      // ⌘⇧T reopens it on the same address.
      const closedTabs = withClosedTab(state.closedTabs, projectId, { kind: 'browser', tabId, url: last })
      return { ui: { ...state.ui, [projectId]: nextUi }, browserStates, closedTabs }
    })
  },

  setBrowserState: (incoming) => {
    const browser = { ...incoming, title: clipTitle(incoming.title) }
    // Agent tab: it exists as long as the host declares it; neither the address nor the title is saved.
    const agentTab = isAgentTabId(browser.tabId)
    const exists = (state: AppState) =>
      agentTab ? state.agentBrowser[agentTabSession(browser.tabId)]?.tabId === browser.tabId : state.ui[browser.projectId]?.browserTabs?.some((tab) => tab.id === browser.tabId)
    // An event arriving after the tab is closed does not put it back in `browserStates`.
    if (!exists(get())) return
    set((state) => ({ browserStates: { ...state.browserStates, [browser.tabId]: browser } }))
    if (agentTab) return
    // Only origin and path are saved (no query or fragment: they may carry tokens) and the truncated title; a just-created tab, without a page, does not erase the saved ones.
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
      // Another tab or no tab: belonging to another window no longer applies.
      const agentForeign = state.agentForeign[sessionId] && state.agentForeign[sessionId] !== incoming.tabId ? omitKey(state.agentForeign, sessionId) : state.agentForeign
      const browserStates = { ...state.browserStates }
      if (lostTab) delete browserStates[lostTab]
      const next = { ...state, agentBrowser, agentForeign, browserStates }
      // The agent page that was there is gone: the column moves to another page or, if nothing is left, closes. The selection does not change.
      return { agentBrowser, agentForeign, browserStates, ...(lostTab ? settleBrowserColumn(next, incoming.projectId) : {}) }
    })
    if (gone || !incoming.tabId || incoming.stopped) return
    // Same tab: only if it belonged to another window is it retried (the window that owns it may have changed).
    if (incoming.tabId === before?.tabId) {
      if (get().agentForeign[sessionId] === incoming.tabId) void get().probeAgentBrowser(sessionId)
      return
    }
    // New view: it is opened from main (which returns it already created) and, if the project's browser column is already open, shown right away.
    // Otherwise a "Show" notice stays next to the tabs: neither the chat being typed in nor the column is touched.
    void get().probeAgentBrowser(sessionId, true)
  },

  probeAgentBrowser: (sessionId, force) => {
    const api = window.ladder?.browser
    const state = get().agentBrowser[sessionId]
    // Even when stopped the view may exist (user stop): whoever opens a window must find it again or know it belongs to another one.
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
          // New view and the project's column is already open: it is shown right away.
          if (force && isBrowserColumnOpen(get(), latest.projectId)) get().showAgentBrowser(sessionId)
          return
        }
        // No view here but the state is active: it belongs to another window. It is not shown and disappears from the column.
        set((s) => {
          const agentForeign = { ...s.agentForeign, [sessionId]: tabId }
          return { agentForeign, ...settleBrowserColumn({ ...s, agentForeign }, latest.projectId) }
        })
      },
      () => {
        agentProbing.delete(sessionId)
      }
    )
  },

  loadAgentBrowser: (states) => {
    // With the window just opened the view is already in main: the UI finds it again without changing what is being looked at.
    // The list is complete: whatever is gone (host restarted) closes as for a `closed` event.
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
    // Requested again: it retries first; if it still belongs to another window it is not opened.
    if (get().agentForeign[sessionId] === state.tabId) {
      void get()
        .probeAgentBrowser(sessionId, true)
        .then(() => {
          const latest = get().agentBrowser[sessionId]
          if (hasAgentTab(latest) && get().agentForeign[sessionId] !== latest.tabId) get().showBrowserColumn(latest.projectId, latest.tabId)
        })
      return
    }
    get().showBrowserColumn(state.projectId, state.tabId)
  },

  closeAgentBrowser: (sessionId) => {
    const before = get().agentBrowser[sessionId]
    if (!before) return
    // The view is destroyed (main notifies the host) and the stop is sent anyway: so it works even if the view was gone.
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
  // Removing a group does not touch the chats: they go back to the project's list.
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
      // The new section is the last of the returned state.
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
    // A closed section that receives a project opens, like chat groups.
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
      // An empty response does not erase a list already arrived with the event (race between request and event).
      .then((commands) => set((state) => (commands.length === 0 && state.commands[sessionId]?.length ? state : { commands: { ...state.commands, [sessionId]: commands } })))
      // Without a list only Ladder's own commands remain: no errors in front of the user.
      .catch(() => undefined)
  },
  setUi: (projectId, uiState) => set((state) => ({ ui: { ...state.ui, [projectId]: uiState } })),

  closeTab: (projectId, sessionId) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const index = ui.tabs.indexOf(sessionId)
      // The tabs of archived or vanished sessions are removed together with this one.
      const tabs = ui.tabs.filter((id) => id !== sessionId && isLiveSession(state, state.sessions[id]))
      const wasActive = state.selection.kind === 'session' && state.selection.sessionId === sessionId
      // With split columns it moves to the neighboring column, not the neighboring tab.
      const before = cleanSplit(state, projectId)
      const column = before?.sessions.includes(sessionId) ? withoutColumn(before, sessionId) : null
      const fallback = column ? column.neighbor : (tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null)
      const nextActive = wasActive ? (fallback ?? tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null) : ui.activeTab === sessionId ? null : ui.activeTab
      // Closing a tab that is not a column leaves the split (and the proportions) as it is.
      const nextUi = withSplit({ ...ui, tabs, activeTab: nextActive }, column ? column.split : before)
      persistUi(projectId, nextUi)
      const next = { ...state, ui: { ...state.ui, [projectId]: nextUi } }
      // Archived sessions are not reopened: ⌘⇧T only concerns tabs closed by hand.
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
      // Archived sessions are not visible: the position only counts among the visible ones.
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
    if (selection.kind === 'file') return move((ui.fileTabs ?? []).map((f) => fileTabId(f.root, f.path)), fileTabId(selection.root, selection.path))
    return move(ui.tabs.filter((id) => isLiveSession(state, state.sessions[id])), selection.sessionId)
  },

  cycleTab: (projectId, delta) => {
    const state = get()
    const ui = state.ui[projectId] ?? emptyUi()
    // Same order as the bar: visible chats, then files.
    const order: Selection[] = [
      ...ui.tabs.filter((id) => isLiveSession(state, state.sessions[id])).map((sessionId): Selection => ({ kind: 'session', projectId, sessionId })),
      ...(ui.fileTabs ?? []).map((file): Selection => ({ kind: 'file', projectId, root: file.root, path: file.path })),
    ]
    if (order.length === 0) return false
    const at = state.selection.projectId === projectId ? order.findIndex((entry) => sameSelection(entry, state.selection)) : -1
    // From "new chat" (no active tab) you enter from the first or the last.
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
        // The reopened tab restarts from the same address, with a new view.
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
    // The stack shrinks even if no entry could be reopened any more.
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
    // Optimistic: the row disappears right away, the host confirms with session.upsert.
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...session, archived: true } } }))
    get().closeTab(session.projectId, sessionId)
    request({ type: 'session.archive', sessionId }).catch(() => {
      set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], archived: false } } }))
    })
  },

  removeProject: async (projectId) => {
    // Without a project the sessions are no longer reachable: they are archived, so the host closes the processes.
    for (const session of Object.values(get().sessions)) {
      if (session.projectId === projectId && !session.archived) send({ type: 'session.archive', sessionId: session.id })
    }
    await request({ type: 'project.remove', projectId })
  },

  goToNextWaiting: () => {
    const state = get()
    // In order of arrival: the oldest request first, in any project.
    const waiting = sidebarOrder(state)
      .filter(needsYou)
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
    seedGitRoot(sessionId)
    send({ type: 'git.watch', sessionId, on: true })
    loadGitStatus(sessionId)
  },

  unwatchGit: (sessionId) => {
    if (!gitWatched.delete(sessionId)) return
    send({ type: 'git.watch', sessionId, on: false })
    dropGit(sessionId)
  },

  // ── Branch maps ──
  watchBranchMap: (projectId) => {
    if (branchMapWatched.has(projectId)) return
    branchMapWatched.add(projectId)
    send({ type: 'project.branchMap.watch', projectId, on: true })
    loadBranchMap(projectId)
  },

  retryBranchMap: (projectId) => {
    if (branchMapWatched.has(projectId)) loadBranchMap(projectId)
  },

  unwatchBranchMap: (projectId) => {
    if (!branchMapWatched.delete(projectId)) return
    send({ type: 'project.branchMap.watch', projectId, on: false })
  },
  // ── end of branch maps ──

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
    // Already in a column: it is enough to activate it.
    if (split?.sessions.includes(sessionId)) {
      select()
      return false
    }
    const current = state.selection.kind === 'session' && state.selection.projectId === projectId ? state.selection.sessionId : null
    const base = split?.active ?? current
    // Nothing to split from (or the same session): it just opens. Columns full: it takes the place of the active one.
    if (!base || base === sessionId || (split && split.sessions.length >= MAX_COLUMNS)) {
      select()
      return false
    }
    set((current) => patchUi(current, projectId, (ui) => withSplit(ui, { sessions: withColumn(split?.sessions ?? [base], base, sessionId, options?.at === 'end'), active: sessionId })))
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
    // Always a new chat next to the open one: predictable. An already open chat is split from the Split menu or with ⌘click on its tab.
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
      patchUi(current, projectId, (ui) => withSplit(ui, next))
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
    // The column's composer gets focus: shortcuts and typing continue there.
    window.requestAnimationFrame(() => document.getElementById(`composer-${target}`)?.focus())
    return true
  },

  setSplitDrop: (on) => set((state) => (state.splitDrop === on ? {} : { splitDrop: on })),
  setColumnWidths: (projectId, widths) =>
    set((state) =>
      patchUi(state, projectId, (ui) => {
        const next = { ...ui }
        if (widths) next.columnWidths = widths
        else delete next.columnWidths
        return next
      })
    ),
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
  setHandoffDialog: (value) => set({ handoffDialog: value }),
  setAdviceDialog: (value) => set({ adviceDialog: value }),
  setPlanDocument: (value) => set({ planDocument: value }),

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
      const list = Object.values(state.sessions).filter((s) => s.projectId === projectId && isListedSession(state, s))
      const summary: AwaySummary = {
        since: seen,
        replies: list.filter((s) => s.unread && s.run !== 'error' && s.activityAt > seen).length,
        requests: list.filter(needsYou).length,
        errors: list.filter((s) => s.run === 'error' && s.activityAt > seen).length,
        // Dropped to "Done" while you were away: the last activity went past 3 days after your last visit.
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
  setPlanDraft: (planId, draft) =>
    set((state) => {
      const planDrafts = { ...state.planDrafts }
      if (draft) planDrafts[planId] = draft
      else delete planDrafts[planId]
      return { planDrafts }
    }),
  planEdit: async (planId, revision, plan) => takePlan(await planRequest<PlanState>({ type: 'plan.edit', planId, revision, plan }, false)),
  planApprove: async (planId, revision, workspace) => takePlan(await planRequest<PlanState>({ type: 'plan.approve', planId, revision, workspace }, false)),
  planReject: (planId, message) => planRequest({ type: 'plan.reject', planId, ...(message?.trim() ? { message: message.trim() } : {}) }),
  planChoose: async (planId, choice, taskId, reassign) => takePlan(await planRequest<PlanState>({ type: 'plan.choose', planId, choice, ...(taskId ? { taskId } : {}), ...(reassign ? { reassign } : {}) })),
  planConfirmUpdate: async (planId, accept) => takePlan(await planRequest<PlanState>({ type: 'plan.confirmUpdate', planId, accept })),
  planStop: async (planId) => takePlan(await planRequest<PlanState>({ type: 'plan.stop', planId })),
  loadPlanTemplates: async () => {
    const result = await planRequest<PlanTemplate[]>({ type: 'plan.templates' })
    if (result.ok) set({ planTemplates: result.data })
    return result
  },
  savePlanTemplate: async (planId, name) => {
    const result = await planRequest<PlanTemplate>({ type: 'plan.saveTemplate', planId, name })
    if (result.ok) set((state) => ({ planTemplates: [...(state.planTemplates ?? []).filter((x) => x.id !== result.data.id), result.data] }))
    return result
  },
  deletePlanTemplate: async (templateId) => {
    const result = await planRequest({ type: 'plan.deleteTemplate', templateId })
    if (result.ok) set((state) => ({ planTemplates: (state.planTemplates ?? []).filter((x) => x.id !== templateId) }))
    return result
  },
  startPlanFromTemplate: async (sessionId, templateId, goal) => takePlan(await planRequest<PlanState>({ type: 'plan.useTemplate', sessionId, templateId, goal }, false)),
  setOtherAgents: (otherAgents) => set({ otherAgents }),
  setOnboarding: (onboarding) => set({ onboarding }),
  hideDetectedAgents: () => set({ detectedAgentsHidden: true }),
  focusConnection: (id, profileId, options) => {
    set({ connectionFocus: { id, ...(profileId ? { profileId } : {}), ...(options?.highlight ? { highlight: true } : {}), nonce: ++nonce } })
    useSettings.getState().openSection('subscriptions')
  },
  consumeConnectionFocus: (value) => set((state) => (state.connectionFocus?.nonce === value ? { connectionFocus: null } : {}))
}))
