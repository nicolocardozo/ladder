// Browser per l'agente (LAD-57 parte 2): identità della tab, testi di azioni e strumenti, interruttore effettivo.
// La tab dell'agente è effimera: non sta in ProjectUiState.browserTabs e il suo indirizzo non si salva.
import { t } from '@shared/i18n'
import type { AgentBrowserAction, AgentBrowserState, AgentBrowserTool, AppPrefs, ProjectUiState } from '@shared/protocol'

const PREFIX = 'agent:'

export const agentTabId = (sessionId: string): string => `${PREFIX}${sessionId}`
export const isAgentTabId = (id: string | null | undefined): id is string => Boolean(id?.startsWith(PREFIX))
export const agentTabSession = (tabId: string): string => tabId.slice(PREFIX.length)

/** La vista dell'agente esiste e si può mostrare come tab. */
export const hasAgentTab = (state: AgentBrowserState | undefined): state is AgentBrowserState & { tabId: string } => Boolean(state && state.tabId && !state.closed)

/** Azione in corso, in forma progressiva: "Opening localhost:5173", "Clicking e3 · "Save"". `target` non contiene mai il testo digitato. */
export function describeAgentAction(action: Pick<AgentBrowserAction, 'tool' | 'target'>): string {
  const target = action.target
  switch (action.tool) {
    case 'browser_navigate':
      return target ? t('Opening {target}', { target }) : t('Opening a page')
    case 'browser_read_page':
      return t('Reading the page')
    case 'browser_screenshot':
      return t('Taking a screenshot')
    case 'browser_click':
      return target ? t('Clicking {target}', { target }) : t('Clicking')
    case 'browser_type':
      return target ? t('Typing into {target}', { target }) : t('Typing')
    case 'browser_console':
      return t('Reading the console')
  }
}

/** Azione conclusa, al passato. */
export function describeAgentDone(action: Pick<AgentBrowserAction, 'tool' | 'target'>): string {
  const target = action.target
  switch (action.tool) {
    case 'browser_navigate':
      return target ? t('Opened {target}', { target }) : t('Opened a page')
    case 'browser_read_page':
      return t('Read the page')
    case 'browser_screenshot':
      return t('Took a screenshot')
    case 'browser_click':
      return target ? t('Clicked {target}', { target }) : t('Clicked')
    case 'browser_type':
      return target ? t('Typed into {target}', { target }) : t('Typed')
    case 'browser_console':
      return t('Read the console')
  }
}

/** Frase di stato della tab dell'agente, anche per gli annunci vocali. */
export function agentStatusText(state: AgentBrowserState | undefined): string {
  if (!state || state.closed) return t('The agent isn’t using the browser')
  if (state.stopped) return t('Stopped. The agent can’t use the browser until you resume it.')
  if (!state.enabled) return t('The browser is off for this session')
  if (state.action) {
    const text = describeAgentAction(state.action)
    return state.action.waitingForYou ? t('Waiting for you: {action}', { action: text }) : text
  }
  return t('Ready. The agent can use this browser.')
}

const TOOL_RE = /^(?:mcp__ladder-browser__|ladder-browser\.)?(browser_(?:navigate|read_page|screenshot|click|type|console))$/

/** Il nome dello strumento (anche con il prefisso MCP) se è uno dei browser dell'agente. */
export function browserToolOf(name: string): AgentBrowserTool | null {
  const match = TOOL_RE.exec(name)
  return match ? (match[1] as AgentBrowserTool) : null
}

/** Nome breve per le card di approvazione: "Browser · Click". */
export function browserToolName(tool: AgentBrowserTool): string {
  switch (tool) {
    case 'browser_navigate':
      return t('Browser · Open page')
    case 'browser_read_page':
      return t('Browser · Read page')
    case 'browser_screenshot':
      return t('Browser · Screenshot')
    case 'browser_click':
      return t('Browser · Click')
    case 'browser_type':
      return t('Browser · Type')
    case 'browser_console':
      return t('Browser · Console')
  }
}

/** Solo host e porta: query e frammento possono portare token. */
function hostOf(raw: string | null): string | null {
  if (!raw) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`).host || null
  } catch {
    return null
  }
}

/**
 * Cosa mostrare di una chiamata agli strumenti browser nella chat: un'etichetta leggibile al posto del titolo grezzo e,
 * del dettaglio, solo ciò che non può contenere testo digitato né token (host per l'apertura, riferimento per il click).
 */
export function browserToolView(tool: AgentBrowserTool, detail: string | null): { title: string; detail: string | null; hideOutput: boolean } {
  const host = hostOf(detail)
  const ref = detail && /^e\d+\b/.test(detail.trim()) ? /^e\d+/.exec(detail.trim())![0] : null
  switch (tool) {
    case 'browser_navigate':
      return { title: host ? t('Browser · opens {address}', { address: host }) : t('Browser · opens a page'), detail: host, hideOutput: false }
    case 'browser_read_page':
      return { title: t('Browser · reads the page'), detail: null, hideOutput: false }
    case 'browser_screenshot':
      return { title: t('Browser · takes a screenshot'), detail: null, hideOutput: false }
    case 'browser_click':
      return { title: ref ? t('Browser · clicks {target}', { target: ref }) : t('Browser · clicks an element'), detail: ref, hideOutput: false }
    case 'browser_type':
      // Il testo digitato non si mostra mai, né nel titolo né nel dettaglio né nell'esito.
      return { title: ref ? t('Browser · types into {target}', { target: ref }) : t('Browser · types into a field'), detail: null, hideOutput: true }
    case 'browser_console':
      return { title: t('Browser · reads the console'), detail: null, hideOutput: false }
  }
}

/** Browser dell'agente acceso per un progetto: l'impostazione del progetto scavalca quella globale. Predefinito spento. */
export function agentBrowserEnabled(prefs: Pick<AppPrefs, 'agentBrowser'> | null | undefined, ui: Pick<ProjectUiState, 'agentBrowser'> | undefined): boolean {
  return ui?.agentBrowser ?? prefs?.agentBrowser ?? false
}
