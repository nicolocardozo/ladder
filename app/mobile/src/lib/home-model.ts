// Modello della Home: "adesso" (sessioni vive di tutti i progetti) e "sfoglia" (le sezioni del Mac).
// Solo logica pura, provata con node --test. L'ordine di sezioni e progetti è quello del Mac (projectGroups);
// layoutProjects/normalizeProjectGroups sono la stessa logica di app/desktop/src/renderer/src/lib/project-groups.ts, ridotta.
import type { Project, ProjectGroupsState, SessionSummary } from '@shared/protocol'
import { byUrgency, hasSignals, isLive, sessionState, signalsOf, type Signals } from './session-state.ts'

export const UNGROUPED_ID = '__ungrouped'

export interface ProjectRow {
  project: Project
  sessions: SessionSummary[]
  signals: Signals
  /** Ultima attività tra le sessioni; null senza sessioni. */
  lastActivity: number | null
}

export interface SectionModel {
  /** Id del gruppo del Mac, o UNGROUPED_ID. */
  id: string
  name: string
  /** Solo le sezioni vere hanno un titolo; i progetti fuori da ogni sezione stanno in cima, senza intestazione. */
  titled: boolean
  projects: ProjectRow[]
  signals: Signals
  expanded: boolean
}

export interface HomeModel {
  /** Richieste aperte, dalla più vecchia. */
  waiting: SessionSummary[]
  waitingCount: number
  now: SessionSummary[]
  /** Con un solo progetto la Home mostra direttamente le sue sessioni. */
  singleProject: ProjectRow | null
  /** Senza sezioni: una lista piatta (un'unica sezione senza titolo). */
  sections: SectionModel[]
}

function normalize(projects: Project[], state: ProjectGroupsState | null | undefined): ProjectGroupsState {
  const alive = new Set(projects.map((p) => p.id))
  const seen = new Set<string>()
  const keep = (ids: string[]) =>
    ids.filter((id) => {
      if (!alive.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
  const groups = (state?.groups ?? []).map((g) => ({ ...g, projectIds: keep(g.projectIds) }))
  const ungrouped = keep(state?.ungrouped ?? [])
  for (const p of projects) if (!seen.has(p.id)) ungrouped.push(p.id)
  return { groups, ungrouped }
}

function sumSignals(rows: ProjectRow[]): Signals {
  const out: Signals = { running: 0, waiting: 0, unread: 0, error: 0 }
  for (const r of rows) {
    out.running += r.signals.running
    out.waiting += r.signals.waiting
    out.unread += r.signals.unread
    out.error += r.signals.error
  }
  return out
}

export function buildHome(input: {
  projects: Project[]
  sessions: SessionSummary[]
  projectGroups: ProjectGroupsState | null | undefined
  /** Preferenza salvata sul telefono: sezione → chiusa o aperta. Assente = decide "ha qualcosa di vivo". */
  collapsed: Record<string, boolean>
}): HomeModel {
  const live = input.sessions.filter((s) => !s.archived)
  const bySession = new Map<string, SessionSummary[]>()
  for (const s of live) bySession.set(s.projectId, [...(bySession.get(s.projectId) ?? []), s])

  const rowOf = (project: Project): ProjectRow => {
    const sessions = bySession.get(project.id) ?? []
    return { project, sessions, signals: signalsOf(sessions), lastActivity: sessions.length ? Math.max(...sessions.map((s) => Math.max(s.activityAt, s.createdAt))) : null }
  }
  const byId = new Map(input.projects.map((p) => [p.id, p]))
  const norm = normalize(input.projects, input.projectGroups)
  const rows = (ids: string[]) =>
    ids
      .flatMap((id) => byId.get(id) ?? [])
      .map(rowOf)
      // Progetti senza sessioni in fondo alla loro sezione; a parità l'ordine del Mac (sort stabile).
      .sort((a, b) => Number(a.sessions.length === 0) - Number(b.sessions.length === 0))

  const sections: SectionModel[] = []
  const ungrouped = rows(norm.ungrouped)
  if (ungrouped.length) {
    const signals = sumSignals(ungrouped)
    sections.push({ id: UNGROUPED_ID, name: '', titled: false, projects: ungrouped, signals, expanded: true })
  }
  for (const g of norm.groups) {
    const list = rows(g.projectIds)
    if (!list.length) continue
    const signals = sumSignals(list)
    const pref = input.collapsed[g.id]
    sections.push({ id: g.id, name: g.name, titled: true, projects: list, signals, expanded: pref === undefined ? hasSignals(signals) : !pref })
  }

  const waiting = live.filter((s) => s.run === 'waiting').sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
  const now = live.filter((s) => isLive(sessionState(s))).sort(byUrgency)
  const all = sections.flatMap((s) => s.projects)
  return {
    waiting,
    waitingCount: waiting.reduce((n, s) => n + Math.max(1, s.openRequests), 0),
    now,
    singleProject: all.length === 1 ? all[0] : null,
    sections
  }
}

export interface SessionGroupModel {
  id: string | null
  name: string | null
  sessions: SessionSummary[]
}

/** Sessioni di un progetto divise per i gruppi del Mac, più le senza gruppo in cima e le archiviate (a parte). */
export function groupProjectSessions(
  sessions: SessionSummary[],
  ui: { groups?: { id: string; name: string }[]; groupOf?: Record<string, string> } | undefined
): SessionGroupModel[] {
  const ordered = [...sessions].sort((a, b) => Math.max(b.activityAt, b.createdAt) - Math.max(a.activityAt, a.createdAt))
  const groups = ui?.groups ?? []
  const groupOf = ui?.groupOf ?? {}
  const ids = new Set(groups.map((g) => g.id))
  const loose = ordered.filter((s) => !groupOf[s.id] || !ids.has(groupOf[s.id]))
  const out: SessionGroupModel[] = []
  if (loose.length) out.push({ id: null, name: null, sessions: loose })
  for (const g of groups) {
    const members = ordered.filter((s) => groupOf[s.id] === g.id)
    if (members.length) out.push({ id: g.id, name: g.name, sessions: members })
  }
  return out
}
