// Sotto-agenti per sessione: gli adapter mandano aggiornamenti parziali, qui si uniscono in una lista per la mappa.
// Restano in memoria: dopo un riavvio dell'app i sotto-agenti di prima non sono più vivi.
import { t } from '@shared/i18n'
import type { SubagentDetail, SubagentInfo } from '@shared/protocol'

/** Strumento del sotto-agente: id per aggiornarne lo stato quando arriva il risultato. */
export type SubagentTool = SubagentDetail['tools'][number] & { id: string }

/** I campi pesanti (prompt, report, strumenti) non finiscono in SubagentInfo: restano nella board e viaggiano solo con subagent.detail. */
export type SubagentUpdate = Partial<Omit<SubagentInfo, 'id'>> & {
  id: string
  prompt?: string | null
  report?: string | null
  /** File con l'output di un sotto-agente in background. */
  outputFile?: string | null
  /** Testo completo del tool_result dell'Agent: il report vero di un sotto-agente in primo piano. */
  result?: string | null
  tool?: SubagentTool
}

export interface SubagentExtra {
  prompt: string | null
  report: string | null
  outputFile: string | null
  result: string | null
  tools: SubagentTool[]
}

const TOOLS_LIMIT = 200
// Rete di sicurezza: nel turno nessun agente sparisce, i finiti dei turni passati li toglie turnStarted.
const HARD_LIMIT = 1000
/** Finiti tolti dall'elenco: ultimo SubagentInfo e dati pesanti restano consultabili (find, subagent.detail). */
const CACHE_LIMIT = 300

export class SubagentBoard {
  private bySession = new Map<string, Map<string, SubagentInfo>>()
  private extras = new Map<string, Map<string, SubagentExtra>>()
  private cache = new Map<string, Map<string, { info: SubagentInfo; extra: SubagentExtra | null }>>()
  /** Inizio dell'ultimo turno aperto dall'host: i finiti prima di quel momento escono dall'elenco al turno dopo. */
  private lastTurnStart = new Map<string, number>()
  /** Ultimo aggiornamento ricevuto per ogni voce: serve a riconoscere quelle rimaste "in corso" senza lavorare. */
  private touched = new Map<string, Map<string, number>>()
  /** Voci chiuse dalla rete di sicurezza e non da un esito vero: un aggiornamento le riporta in corso, o la loro fine conta. */
  private expired = new Map<string, Set<string>>()

  /** Un sotto-agente per id o per id della riga tool che l'ha lanciato; se non è più in elenco, dalla cache dei finiti. */
  find(sessionId: string, id: string): { info: SubagentInfo; extra: SubagentExtra | null } | null {
    const agents = this.bySession.get(sessionId)
    const info = agents?.get(id) ?? (agents ? [...agents.values()].find((a) => a.toolId === id) : undefined)
    if (info) return { info, extra: this.extras.get(sessionId)?.get(info.id) ?? null }
    const cached = this.cache.get(sessionId)
    return cached?.get(id) ?? (cached ? [...cached.values()].find((c) => c.info.toolId === id) : undefined) ?? null
  }

  list(sessionId: string): SubagentInfo[] | undefined {
    const agents = this.bySession.get(sessionId)
    return agents?.size ? [...agents.values()] : undefined
  }

  /** Conteggi leggeri per il summary. */
  /** `turnActive`: fuori da un turno nessun agente è "in primo piano" (quelli che continuano, come in Codex, contano come background). */
  counts(sessionId: string, turnActive: boolean): { total: number; running: number; runningForeground: number; error: number } | undefined {
    const list = this.list(sessionId)
    if (!list) return undefined
    return {
      total: list.length,
      running: list.filter((a) => a.status === 'running').length,
      runningForeground: turnActive ? list.filter((a) => a.status === 'running' && !a.background).length : 0,
      error: list.filter((a) => a.status === 'error').length
    }
  }

  /** Unisce un aggiornamento; true se qualcosa è cambiato. */
  update(sessionId: string, update: SubagentUpdate): boolean {
    let agents = this.bySession.get(sessionId)
    if (!agents) {
      agents = new Map()
      this.bySession.set(sessionId, agents)
    }
    const { prompt, report, outputFile, result, tool, ...light } = update
    update = light
    const before = agents.get(update.id)
    const lightKeys = Object.keys(defined(update)).filter((k) => k !== 'id')
    if (!before) {
      // Un agente già finito e tolto dall'elenco: i dati pesanti in ritardo vanno nella cache, il resto si ignora.
      const cached = this.cache.get(sessionId)?.get(update.id)
      if (cached && lightKeys.length === 0) {
        cached.extra ??= { prompt: null, report: null, outputFile: null, result: null, tools: [] }
        applyExtra(cached.extra, { prompt, report, outputFile, result, tool })
        return false
      }
      // Campi leggeri su un agente in cache (torna a lavorare): rientra nell'elenco con i suoi dati pesanti.
      if (cached) {
        this.cache.get(sessionId)!.delete(update.id)
        agents.set(update.id, cached.info)
        if (cached.extra) {
          let all = this.extras.get(sessionId)
          if (!all) this.extras.set(sessionId, (all = new Map()))
          all.set(update.id, cached.extra)
        }
        return this.update(sessionId, { ...update, prompt, report, outputFile, result, tool }) || true
      }
      // Una voce nasce solo da una fonte affidabile (lancio, task_started, spawn): status 'running' esplicito e un titolo.
      // Un id sconosciuto con un campo qualunque (attività, strumento, esito in ritardo) non crea agenti fantasma.
      if (update.status !== 'running' || !update.title) return false
    }
    this.touch(sessionId, update.id)
    const heavyChanged = this.mergeExtra(sessionId, update.id, { prompt, report, outputFile, result, tool })
    const now = Date.now()
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
    const wasExpired = this.expired.get(sessionId)?.delete(update.id) ?? false
    // Un titolo vero resta: solo quello generico si lascia sostituire.
    if (before && before.title !== t('Subagent') && update.title !== undefined) next.title = before.title
    if (before && before.status !== 'running' && update.status === undefined) next.status = wasExpired && lightKeys.length > 0 ? 'running' : before.status
    if (next.status !== 'running') {
      next.endedAt ??= now
      next.activity = null
    } else {
      next.endedAt = null
    }
    if (before && same(before, next)) return heavyChanged
    agents.set(update.id, next)
    if (agents.size > HARD_LIMIT) {
      const oldest = [...agents.values()].filter((a) => a.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) this.drop(sessionId, oldest.id, true)
    }
    return true
  }

  /**
   * Turno aperto dall'host: via dall'elenco i finiti prima dell'inizio del turno precedente (restano nella cache),
   * restano quelli al lavoro e quelli finiti nel turno che si chiude. Non va chiamato per i turni impliciti aperti dall'adapter.
   */
  turnStarted(sessionId: string): boolean {
    const cutoff = this.lastTurnStart.get(sessionId) ?? 0
    this.lastTurnStart.set(sessionId, Date.now())
    const agents = this.bySession.get(sessionId)
    if (!agents) return false
    let changed = false
    for (const [id, agent] of agents) {
      if (agent.status !== 'running' && (agent.endedAt ?? 0) < cutoff) {
        this.drop(sessionId, id, true)
        changed = true
      }
    }
    return changed
  }

  /** Qualche sotto-agente della sessione sta ancora lavorando (anche in background, a turno chiuso). */
  hasRunning(sessionId: string): boolean {
    for (const agent of this.bySession.get(sessionId)?.values() ?? []) if (agent.status === 'running') return true
    return false
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
      for (const tool of this.extras.get(sessionId)?.get(agent.id)?.tools ?? []) if (tool.status === 'running') tool.status = 'error'
      changed = true
    }
    return changed
  }

  /**
   * Rete di sicurezza: le voci in corso senza aggiornamenti da oltre `maxAgeMs` risultano fermate.
   * Ritorna le voci com'erano prima (vuoto se non è cambiato nulla).
   */
  expireStale(sessionId: string, maxAgeMs: number, live: Set<string> | null = null): SubagentInfo[] {
    const agents = this.bySession.get(sessionId)
    if (!agents) return []
    const now = Date.now()
    const expired: SubagentInfo[] = []
    for (const agent of agents.values()) {
      if (agent.status !== 'running' || live?.has(agent.id)) continue
      if (now - (this.touched.get(sessionId)?.get(agent.id) ?? agent.startedAt) < maxAgeMs) continue
      expired.push({ ...agent })
      let ids = this.expired.get(sessionId)
      if (!ids) this.expired.set(sessionId, (ids = new Set()))
      ids.add(agent.id)
      agent.status = 'stopped'
      agent.endedAt = now
      agent.activity = null
      for (const tool of this.extras.get(sessionId)?.get(agent.id)?.tools ?? []) if (tool.status === 'running') tool.status = 'error'
    }
    return expired
  }

  /** La voce è stata chiusa dalla rete di sicurezza e nessun aggiornamento l'ha ancora toccata. */
  wasExpired(sessionId: string, id: string): boolean {
    return this.expired.get(sessionId)?.has(id) ?? false
  }

  private touch(sessionId: string, id: string): void {
    let all = this.touched.get(sessionId)
    if (!all) this.touched.set(sessionId, (all = new Map()))
    all.set(id, Date.now())
  }

  forget(sessionId: string): void {
    this.touched.delete(sessionId)
    this.expired.delete(sessionId)
    this.bySession.delete(sessionId)
    this.extras.delete(sessionId)
    this.cache.delete(sessionId)
    this.lastTurnStart.delete(sessionId)
  }

  private drop(sessionId: string, id: string, keep = false): void {
    const info = this.bySession.get(sessionId)?.get(id)
    const extra = this.extras.get(sessionId)?.get(id) ?? null
    this.bySession.get(sessionId)?.delete(id)
    this.extras.get(sessionId)?.delete(id)
    this.touched.get(sessionId)?.delete(id)
    this.expired.get(sessionId)?.delete(id)
    if (!keep || !info) return
    let cached = this.cache.get(sessionId)
    if (!cached) this.cache.set(sessionId, (cached = new Map()))
    cached.set(id, { info, extra })
    if (cached.size > CACHE_LIMIT) cached.delete(cached.keys().next().value!)
  }

  /** true se sono cambiati report, risultato o file di output (il dettaglio aperto si ricarica). */
  private mergeExtra(sessionId: string, id: string, patch: Pick<SubagentUpdate, 'prompt' | 'report' | 'outputFile' | 'result' | 'tool'>): boolean {
    let all = this.extras.get(sessionId)
    if (!all) {
      all = new Map()
      this.extras.set(sessionId, all)
    }
    let extra = all.get(id)
    if (!extra) {
      extra = { prompt: null, report: null, outputFile: null, result: null, tools: [] }
      all.set(id, extra)
    }
    return applyExtra(extra, patch)
  }
}

function applyExtra(extra: SubagentExtra, patch: Pick<SubagentUpdate, 'prompt' | 'report' | 'outputFile' | 'result' | 'tool'>): boolean {
  const before = [extra.report, extra.result, extra.outputFile]
  if (patch.prompt !== undefined) extra.prompt = patch.prompt
  if (patch.report !== undefined) extra.report = patch.report
  if (patch.outputFile !== undefined) extra.outputFile = patch.outputFile
  if (patch.result !== undefined) extra.result = patch.result
  if (patch.tool) {
    const known = extra.tools.find((x) => x.id === patch.tool!.id)
    if (known) Object.assign(known, patch.tool, { at: known.at })
    else {
      extra.tools.push(patch.tool)
      if (extra.tools.length > TOOLS_LIMIT) extra.tools.shift()
    }
  }
  return before[0] !== extra.report || before[1] !== extra.result || before[2] !== extra.outputFile
}

function defined(update: SubagentUpdate): Partial<SubagentInfo> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(update)) if (value !== undefined) out[key] = value
  return out as Partial<SubagentInfo>
}

function same(a: SubagentInfo, b: SubagentInfo): boolean {
  return (Object.keys(b) as (keyof SubagentInfo)[]).every((key) => a[key] === b[key])
}
