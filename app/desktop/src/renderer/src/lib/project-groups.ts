// Project sections in the sidebar: layout, visible order (⌘1…9) and the same model as the host, for local state
// when there is no host (web preview) and for optimistic command updates.
import type { Project, ProjectGroup, ProjectGroupsState } from '@shared/protocol'

export interface ProjectLayout {
  /** Projects outside any section, at the top. */
  ungrouped: Project[]
  sections: { group: ProjectGroup; projects: Project[] }[]
}

/** State consistent with known projects: no orphans or duplicates, unlisted projects at the end of `ungrouped`. Without state: no sections. */
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
 * Projects in the order they appear in the sidebar, top to bottom. Those in a closed section don't count,
 * except the selected project, which the sidebar keeps visible.
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

/** How the host applies a command. Unknown ids: no change (the host would reply with an error). */
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
