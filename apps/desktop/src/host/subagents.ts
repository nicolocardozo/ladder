// Sotto-agenti per sessione: gli adapter mandano aggiornamenti parziali, qui si uniscono in una lista per la mappa.
// Restano in memoria: dopo un riavvio dell'app i sotto-agenti di prima non sono più vivi.
import { t } from '@shared/i18n'
import type { SubagentInfo } from '@shared/protocol'

export type SubagentUpdate = Partial<Omit<SubagentInfo, 'id'>> & { id: string }

const LIMIT = 60

export class SubagentBoard {
  private bySession = new Map<string, Map<string, SubagentInfo>>()

  list(sessionId: string): SubagentInfo[] | undefined {
    const agents = this.bySession.get(sessionId)
    return agents?.size ? [...agents.values()] : undefined
  }

  /** Unisce un aggiornamento; true se qualcosa è cambiato. */
  update(sessionId: string, update: SubagentUpdate): boolean {
    let agents = this.bySession.get(sessionId)
    if (!agents) {
      agents = new Map()
      this.bySession.set(sessionId, agents)
    }
    const now = Date.now()
    const before = agents.get(update.id)
    const next: SubagentInfo = {
      parentId: null,
      title: t('Subagent'),
      kind: null,
      model: null,
      status: 'running',
      startedAt: now,
      endedAt: null,
      activity: null,
      tokens: null,
      toolUses: null,
      background: false,
      ...before,
      ...defined(update),
      id: update.id
    }
    if (before && before.status !== 'running' && update.status === undefined) next.status = before.status
    if (next.status !== 'running') {
      next.endedAt ??= now
      next.activity = null
    } else {
      next.endedAt = null
    }
    if (before && same(before, next)) return false
    agents.set(update.id, next)
    if (agents.size > LIMIT) {
      const oldest = [...agents.values()].filter((a) => a.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) agents.delete(oldest.id)
    }
    return true
  }

  /** Nuovo turno: via i sotto-agenti finiti, restano quelli ancora al lavoro. */
  turnStarted(sessionId: string): boolean {
    const agents = this.bySession.get(sessionId)
    if (!agents) return false
    let changed = false
    for (const [id, agent] of agents) {
      if (agent.status !== 'running') {
        agents.delete(id)
        changed = true
      }
    }
    return changed
  }

  /** L'agente si è fermato (interruzione, processo chiuso): chi era al lavoro risulta fermato. */
  stopRunning(sessionId: string, { foregroundOnly = false } = {}): boolean {
    const agents = this.bySession.get(sessionId)
    if (!agents) return false
    let changed = false
    const now = Date.now()
    for (const agent of agents.values()) {
      if (agent.status !== 'running' || (foregroundOnly && agent.background)) continue
      agent.status = 'stopped'
      agent.endedAt = now
      agent.activity = null
      changed = true
    }
    return changed
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}

function defined(update: SubagentUpdate): Partial<SubagentInfo> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(update)) if (value !== undefined) out[key] = value
  return out as Partial<SubagentInfo>
}

function same(a: SubagentInfo, b: SubagentInfo): boolean {
  return (Object.keys(b) as (keyof SubagentInfo)[]).every((key) => a[key] === b[key])
}
