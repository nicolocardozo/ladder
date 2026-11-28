// Home model: "now" (live sessions of all projects) and "browse" (the Mac's sections).
// Pure logic only, tested with node --test. The order of sections and projects is the Mac's (projectGroups);
// layoutProjects/normalizeProjectGroups are the same logic as app/desktop/src/renderer/src/lib/project-groups.ts, reduced.
import type { Project, ProjectGroupsState, SessionSummary } from '@shared/protocol'
import { byUrgency, hasSignals, isLive, sessionState, signalsOf, type Signals } from './session-state.ts'

export const UNGROUPED_ID = '__ungrouped'

export interface ProjectRow {
  project: Project
  sessions: SessionSummary[]
  signals: Signals
  /** Latest activity across the sessions; null with no sessions. */
  lastActivity: number | null
}

export interface SectionModel {
  /** Id of the Mac's group, or UNGROUPED_ID. */
  id: string
  name: string
  /** Only real sections have a title; projects outside any section go on top, with no heading. */
  titled: boolean
  projects: ProjectRow[]
  signals: Signals
  expanded: boolean
}

export interface HomeModel {
  /** Open requests, oldest first. */
  waiting: SessionSummary[]
  waitingCount: number
  now: SessionSummary[]
  /** With a single project the Home shows its sessions directly. */
  singleProject: ProjectRow | null
  /** Without sections: a flat list (a single section with no title). */
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
  /** Preference saved on the phone: section → collapsed or open. Absent = decided by "has something live". */
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
      // Projects without sessions go at the bottom of their section; ties keep the Mac's order (stable sort).
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

/** Sessions of a project split by the Mac's groups, plus the ungrouped ones on top and the archived ones (separate). */
export function groupProjectSessions(
  sessions: SessionSummary[],
  ui: { groups?: { id: string; name: string; order?: string[] }[]; groupOf?: Record<string, string> } | undefined
): SessionGroupModel[] {
  const ordered = [...sessions].sort((a, b) => Math.max(b.activityAt, b.createdAt) - Math.max(a.activityAt, a.createdAt))
  const groups = ui?.groups ?? []
  const groupOf = ui?.groupOf ?? {}
  const ids = new Set(groups.map((g) => g.id))
  const loose = ordered.filter((s) => !groupOf[s.id] || !ids.has(groupOf[s.id]))
  const out: SessionGroupModel[] = []
  if (loose.length) out.push({ id: null, name: null, sessions: loose })
  for (const g of groups) {
    // Same order as the Mac: sessions not placed by hand first, then the order arranged in the sidebar.
    const at = new Map((g.order ?? []).map((id, i) => [id, i]))
    const inGroup = ordered.filter((s) => groupOf[s.id] === g.id)
    const members = [...inGroup.filter((s) => !at.has(s.id)), ...inGroup.filter((s) => at.has(s.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)]
    if (members.length) out.push({ id: g.id, name: g.name, sessions: members })
  }
  return out
}
