// Collegamenti (Claude, Codex, GitHub): nomi, stati e comandi verso l'host. Lo stato vive in app-store (`connections`).
import type { AgentId, ConnectionId, ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { request } from '@/lib/host-client'
import { hostProfileId, isDefaultProfileId } from '@/lib/profiles'
import { useApp } from '@/store/app-store'

/** Ordine delle righe, in Impostazioni e nel primo avvio. */
export const CONNECTION_ORDER: ConnectionId[] = ['claude-code', 'codex', 'github']

export const CONNECTION_NAME: Record<ConnectionId, string> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT / Codex',
  github: 'GitHub'
}

/** Collegamento che un agente nativo richiede; gli agenti ACP gestiscono da sé il login. */
export function connectionOfAgent(agent: AgentId): ConnectionId | null {
  return agent === 'claude-code' || agent === 'codex' ? agent : null
}

/** Collegato e non nel mezzo di un cambio di account. */
export function isLinked(status: ConnectionStatus | null | undefined): boolean {
  return status?.state === 'connected'
}

/** Manca il login (o lo strumento): una sessione con questo agente fallirebbe al primo messaggio. `error` non blocca: lo stato non si è potuto leggere. */
export function needsSignIn(status: ConnectionStatus | null | undefined): boolean {
  return status?.state === 'missing' || status?.state === 'unauthenticated'
}

/** Almeno un agente può rispondere: un collegamento nativo attivo o un agente ACP disponibile. */
export function hasLinkedAgent(): boolean {
  const { connections, profileConnections, agents } = useApp.getState()
  return isLinked(connections['claude-code']) || isLinked(connections.codex) || Object.values(profileConnections).some(isLinked) || agents.some((a) => a.kind === 'acp' && a.available)
}

/** I comandi possono restituire una promessa: la riga disattiva i bottoni finché non si risolve. */
export interface ConnectionActions {
  /** `profileId` (Claude Code e Codex): assente = profilo predefinito. */
  login: (id: ConnectionId, switchAccount?: boolean, profileId?: string) => void | Promise<void>
  cancel: (id: ConnectionId, profileId?: string) => void | Promise<void>
  logout: (id: ConnectionId, profileId?: string) => void | Promise<void>
  /** Gestione dei profili (LAD-23). Assenti dove non si gestiscono (primo avvio). Rifiutano con il messaggio dell'host (nome già usato, profilo in uso…). */
  createProfile?: (agent: ProfileAgent, name: string) => Promise<Profile>
  renameProfile?: (profileId: string, name: string) => Promise<Profile>
  removeProfile?: (profileId: string) => Promise<void>
}

/** Chiave di una riga: collegamento più profilo (assente = predefinito). */
export function connectionKey(id: ConnectionId, profileId?: string | null): string {
  return isDefaultProfileId(profileId) ? id : `${id}:${profileId}`
}

// Ordine degli aggiornamenti per riga: una risposta di `connection.list` partita prima di un evento non lo sovrascrive.
let sequence = 0
const stamp: Record<string, number> = {}
useApp.subscribe((state, prev) => {
  for (const id of CONNECTION_ORDER) if (state.connections[id] !== prev.connections[id]) stamp[id] = ++sequence
  if (state.profileConnections !== prev.profileConnections) {
    for (const [profileId, status] of Object.entries(state.profileConnections)) if (status !== prev.profileConnections[profileId]) stamp[connectionKey(status.id, profileId)] = ++sequence
  }
})

function apply(status: ConnectionStatus): void {
  useApp.getState().applyEvent({ type: 'connection.update', status })
}

/** Comando con risposta di stato: il resto arriva con gli eventi `connection.update`. Un errore di canale diventa l'errore della riga. */
function run(id: ConnectionId, command: Parameters<typeof request>[0], useResponse = true, profileId?: string): Promise<void> {
  // `connection.cancel` non promette una risposta di stato: l'evento che segue basta.
  return request<ConnectionStatus | undefined>(command)
    .then((status) => {
      if (useResponse && status) apply(status)
    })
    .catch((e: Error) => {
      const state = useApp.getState()
      const current = isDefaultProfileId(profileId) ? state.connections[id] : state.profileConnections[profileId!]
      // Un annullamento voluto non è un errore.
      if (current && !/cancell?ed|annullat/i.test(e.message)) apply({ ...current, login: null, error: e.message })
    })
}

export const liveConnectionActions: ConnectionActions = {
  // La risposta di login (fase iniziale) può essere più vecchia degli eventi già arrivati, come il codice di GitHub: bastano gli eventi.
  login: (id, switchAccount, profileId) => run(id, { type: 'connection.login', id, ...(switchAccount ? { switchAccount: true } : {}), ...withProfile(profileId) }, false, profileId),
  cancel: (id, profileId) => run(id, { type: 'connection.cancel', id, ...withProfile(profileId) }, true, profileId),
  logout: (id, profileId) => run(id, { type: 'connection.logout', id, ...withProfile(profileId) }, true, profileId),
  createProfile: async (agent, name) => {
    const profile = await request<Profile>({ type: 'profile.create', agent, name })
    useApp.getState().applyEvent({ type: 'profile.upsert', profile })
    // Il nuovo profilo non ha ancora un collegamento nello store: si legge, così la riga mostra "Sign in".
    void run(agent, { type: 'connection.refresh', id: agent, profileId: profile.id }, true, profile.id)
    return profile
  },
  renameProfile: async (profileId, name) => {
    const profile = await request<Profile>({ type: 'profile.rename', profileId, name })
    useApp.getState().applyEvent({ type: 'profile.upsert', profile })
    return profile
  },
  removeProfile: async (profileId) => {
    await request({ type: 'profile.remove', profileId })
    useApp.getState().applyEvent({ type: 'profile.removed', profileId })
  }
}

function withProfile(profileId?: string): { profileId?: string } {
  const id = hostProfileId(profileId)
  return id ? { profileId: id } : {}
}

/** Rilegge lo stato di tutti i collegamenti, senza avviare nulla (host senza snapshot.connections, apertura di Impostazioni → Abbonamenti). Le righe già aggiornate da un evento dopo la richiesta restano come sono. */
export function refreshConnections(): void {
  const startedAt = sequence
  request<ConnectionStatus[]>({ type: 'connection.list' })
    .then((list) => list.forEach((status) => (stamp[connectionKey(status.id, status.profileId)] ?? 0) <= startedAt && apply(status)))
    .catch(() => undefined)
}
