// Sezioni di progetti nella sidebar: disposizione, ordine visibile (⌘1…9) e lo stesso modello dell'host, per lo stato locale
// quando l'host non c'è (anteprima web) e per l'aggiornamento ottimistico dei comandi.
import type { Project, ProjectGroup, ProjectGroupsState } from '@shared/protocol'

export interface ProjectLayout {
  /** Progetti fuori da ogni sezione, in alto. */
  ungrouped: Project[]
  sections: { group: ProjectGroup; projects: Project[] }[]
}

/** Stato coerente con i progetti noti: niente orfani né doppioni, i progetti non elencati in coda a `ungrouped`. Senza stato: nessuna sezione. */
export function normalizeProjectGroups(projects: Project[], state: ProjectGroupsState | null | undefined): ProjectGroupsState {
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
  for (const project of projects) if (!seen.has(project.id)) ungrouped.push(project.id)
  return { groups, ungrouped }
}

export function layoutProjects(projects: Project[], state: ProjectGroupsState | null | undefined): ProjectLayout {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const normal = normalizeProjectGroups(projects, state)
  const pick = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? [])
  return { ungrouped: pick(normal.ungrouped), sections: normal.groups.map((group) => ({ group, projects: pick(group.projectIds) })) }
}

/**
 * Progetti nell'ordine in cui si vedono nella sidebar, dall'alto in basso. Quelli di una sezione chiusa non contano,
 * tranne il progetto selezionato, che la sidebar tiene visibile.
 */
export function visibleProjects(projects: Project[], state: ProjectGroupsState | null | undefined, selectedId: string | null): Project[] {
  const { ungrouped, sections } = layoutProjects(projects, state)
  return [...ungrouped, ...sections.flatMap(({ group, projects: list }) => (group.collapsed ? list.filter((p) => p.id === selectedId) : list))]
}

export type ProjectGroupOp =
  | { type: 'create'; id: string; name: string; projectIds?: string[] }
  | { type: 'rename'; groupId: string; name: string }
  | { type: 'delete'; groupId: string }
  | { type: 'collapse'; groupId: string; collapsed: boolean }
  | { type: 'reorder'; groupIds: string[] }
  | { type: 'move'; projectId: string; groupId: string | null; index?: number }

/** Come l'host applica un comando. Id sconosciuti: nessuna modifica (l'host risponderebbe con un errore). */
export function applyProjectGroupOp(state: ProjectGroupsState, op: ProjectGroupOp): ProjectGroupsState {
  const groups = state.groups.map((g) => ({ ...g, projectIds: [...g.projectIds] }))
  let ungrouped = [...state.ungrouped]
  const find = (id: string) => groups.find((g) => g.id === id)
  switch (op.type) {
    case 'create': {
      const known = new Set([...ungrouped, ...groups.flatMap((g) => g.projectIds)])
      const ids = [...new Set(op.projectIds ?? [])].filter((id) => known.has(id))
      for (const g of groups) g.projectIds = g.projectIds.filter((id) => !ids.includes(id))
      ungrouped = ungrouped.filter((id) => !ids.includes(id))
      groups.push({ id: op.id, name: op.name, collapsed: false, projectIds: ids })
      break
    }
    case 'rename': {
      const group = find(op.groupId)
      if (group) group.name = op.name
      break
    }
    case 'delete': {
      const group = find(op.groupId)
      if (!group) break
      groups.splice(groups.indexOf(group), 1)
      ungrouped.push(...group.projectIds)
      break
    }
    case 'collapse': {
      const group = find(op.groupId)
      if (group) group.collapsed = op.collapsed
      break
    }
    case 'reorder': {
      const ordered = op.groupIds.flatMap((id) => find(id) ?? [])
      return { groups: [...new Set([...ordered, ...groups])], ungrouped }
    }
    case 'move': {
      const target = op.groupId === null ? null : find(op.groupId)
      if (target === undefined) break
      for (const g of groups) g.projectIds = g.projectIds.filter((id) => id !== op.projectId)
      ungrouped = ungrouped.filter((id) => id !== op.projectId)
      const list = target ? target.projectIds : ungrouped
      const at = op.index === undefined || !Number.isFinite(op.index) ? list.length : Math.min(Math.max(Math.trunc(op.index), 0), list.length)
      list.splice(at, 0, op.projectId)
      break
    }
  }
  return { groups, ungrouped }
}
