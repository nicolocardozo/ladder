// "Altri agenti" (LAD-79): CLI come Gemini, Copilot o Cursor, con stato di accesso e login dal loro terminale.
// L'elenco vive in app-store (`otherAgents`); le righe si aggiornano con gli eventi `agent.connection`.
import type { OtherAgentConnection, TerminalInfo } from '@shared/protocol'
import { t } from '@shared/i18n'
import { useSettings } from '@/hooks/use-theme'
import { onHostConnect, request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

// Ordine degli aggiornamenti per riga: la risposta di `agents.others` partita prima di un evento non lo sovrascrive.
let sequence = 0
const stamp: Record<string, number> = {}
useApp.subscribe((state, prev) => {
  if (state.otherAgents === prev.otherAgents) return
  for (const row of state.otherAgents ?? []) if (row !== prev.otherAgents?.find((p) => p.id === row.id)) stamp[row.id] = ++sequence
})

/** Un agente è collegato a Ladder se la CLI c'è e la prova ha aperto una sessione senza chiedere l'accesso. */
export function isOtherLinked(agent: OtherAgentConnection): boolean {
  return agent.installed && agent.auth === 'connected'
}

let loaded = false
let loading: Promise<void> | null = null

/**
 * Legge l'elenco una sola volta (poi lo tengono aggiornato gli eventi `agent.connection` e «Check again»): l'host risponde subito con
 * quanto sa e manda le prove come eventi. Richiamarla mentre è in corso o dopo un successo non rilancia nulla; si riprova solo dopo
 * un errore o con `force` (nuova connessione con l'host).
 */
export function loadOtherAgents(force = false): Promise<void> {
  if (!force) {
    if (loading) return loading
    if (loaded) return Promise.resolve()
  }
  const startedAt = sequence
  const run = request<OtherAgentConnection[]>({ type: 'agents.others' })
    .then((list) => {
      const current = useApp.getState().otherAgents ?? []
      useApp.getState().setOtherAgents(list.map((row) => ((stamp[row.id] ?? 0) > startedAt ? (current.find((c) => c.id === row.id) ?? row) : row)))
      loaded = true
    })
    .finally(() => {
      if (loading === run) loading = null
    })
  loading = run
  return run
}
// Una nuova connessione con l'host (anche la prima) rilegge l'elenco; l'host ha il suo stato.
onHostConnect(() => void loadOtherAgents(true).catch(() => undefined))

function upsert(agent: OtherAgentConnection): void {
  useApp.getState().applyEvent({ type: 'agent.connection', agent })
}

/** Ripete la prova di un agente. */
export async function refreshOtherAgent(id: string): Promise<void> {
  upsert(await request<OtherAgentConnection>({ type: 'agents.others.refresh', id }))
}

/** Progetto in cui si apre il terminale: quello in vista, altrimenti il primo. */
function terminalProject(): string | null {
  const state = useApp.getState()
  return state.selection.projectId ?? state.projects[0]?.id ?? null
}

/** Porta in vista un terminale di Ladder: seleziona il suo progetto, apre il pannello e chiude le Impostazioni che lo coprirebbero. */
export function showTerminal(terminal: Pick<TerminalInfo, 'id' | 'projectId'>): void {
  const state = useApp.getState()
  if (state.selection.projectId !== terminal.projectId) state.selectProject(terminal.projectId)
  state.setTerminalPanel(terminal.projectId, { open: true, active: terminal.id })
  useSettings.getState().setSettingsOpen(false)
}

/** Apre l'accesso o l'uscita dell'agente nel terminale del progetto. Rifiuta con un messaggio chiaro se non c'è un progetto. */
async function openInTerminal(kind: 'login' | 'logout', id: string): Promise<void> {
  const projectId = terminalProject()
  if (!projectId) throw new Error(t('Open a project first: the sign-in runs in one of its terminals.'))
  const terminal = await request<TerminalInfo>({ type: kind === 'login' ? 'agents.others.login' : 'agents.others.logout', id, projectId })
  useApp.getState().applyEvent({ type: 'terminal.upsert', terminal })
  showTerminal(terminal)
}

export const loginOtherAgent = (id: string) => openInTerminal('login', id)
export const logoutOtherAgent = (id: string) => openInTerminal('logout', id)

/** Il terminale di un accesso in corso, per "Show terminal". */
export function showOtherAgentTerminal(terminalId: string): boolean {
  const terminal = useApp.getState().terminals[terminalId]
  if (!terminal) return false
  showTerminal(terminal)
  return true
}
