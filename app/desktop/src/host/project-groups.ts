// Gruppi di progetti della sidebar: stato globale in kv, coerente con i progetti esistenti.
import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import type { ProjectGroup, ProjectGroupsState } from '@shared/protocol'
import type { Db } from './db'

const KEY = 'project-groups'

export class ProjectGroups {
  constructor(
    private readonly db: Db,
    /** Id dei progetti esistenti: lo stato salvato si allinea a questi a ogni lettura. */
    private readonly knownIds: () => string[],
    private readonly changed: (state: ProjectGroupsState) => void
  ) {}

  /** Stato attuale, già ripulito: niente orfani, niente doppioni, i progetti nuovi in coda a `ungrouped`. */
  get(): ProjectGroupsState {
    return this.normalize(this.read())
  }

  /** Dopo che un progetto è stato aggiunto o rimosso: riallinea, salva e avvisa se è cambiato qualcosa. */
  sync(): void {
    const raw = this.read()
    const state = this.normalize(raw)
    if (JSON.stringify(state) === JSON.stringify(raw)) return
    this.save(state)
    this.changed(state)
  }

  create(name: string, projectIds: string[] = []): ProjectGroupsState {
    const state = this.get()
    const group: ProjectGroup = { id: randomUUID(), name: this.cleanName(name), collapsed: false, projectIds: [] }
    const known = new Set([...state.ungrouped, ...state.groups.flatMap((g) => g.projectIds)])
    for (const id of new Set(projectIds)) if (known.has(id)) group.projectIds.push(id)
    // I progetti scelti escono dal loro posto di prima.
    state.groups.forEach((g) => (g.projectIds = g.projectIds.filter((id) => !group.projectIds.includes(id))))
    state.ungrouped = state.ungrouped.filter((id) => !group.projectIds.includes(id))
    state.groups.push(group)
    return this.commit(state)
  }

  rename(groupId: string, name: string): ProjectGroupsState {
    const state = this.get()
    this.mustGroup(state, groupId).name = this.cleanName(name)
    return this.commit(state)
  }

  delete(groupId: string): ProjectGroupsState {
    const state = this.get()
    const group = this.mustGroup(state, groupId)
    state.groups = state.groups.filter((g) => g !== group)
    state.ungrouped.push(...group.projectIds)
    return this.commit(state)
  }

  collapse(groupId: string, collapsed: boolean): ProjectGroupsState {
    const state = this.get()
    this.mustGroup(state, groupId).collapsed = collapsed
    return this.commit(state)
  }

  reorder(groupIds: string[]): ProjectGroupsState {
    const state = this.get()
    const byId = new Map(state.groups.map((g) => [g.id, g]))
    const ordered: ProjectGroup[] = []
    for (const id of groupIds) {
      const group = byId.get(id)
      if (group) {
        ordered.push(group)
        byId.delete(id)
      }
    }
    state.groups = [...ordered, ...byId.values()]
    return this.commit(state)
  }

  move(projectId: string, groupId: string | null, index?: number): ProjectGroupsState {
    if (!this.knownIds().includes(projectId)) throw new Error(t('Project not found.'))
    const state = this.get()
    const target = groupId === null ? null : this.mustGroup(state, groupId)
    state.groups.forEach((g) => (g.projectIds = g.projectIds.filter((id) => id !== projectId)))
    state.ungrouped = state.ungrouped.filter((id) => id !== projectId)
    const list = target ? target.projectIds : state.ungrouped
    const at = index === undefined || !Number.isFinite(index) ? list.length : Math.min(Math.max(Math.trunc(index), 0), list.length)
    list.splice(at, 0, projectId)
    return this.commit(state)
  }

  // ── Interni ──────────────────────────────────────────────────────────────

  private cleanName(name: string): string {
    const clean = name.trim()
    if (!clean) throw new Error(t('A group needs a name.'))
    return clean
  }

  private mustGroup(state: ProjectGroupsState, id: string): ProjectGroup {
    const group = state.groups.find((g) => g.id === id)
    if (!group) throw new Error(t('Group not found.'))
    return group
  }

  private commit(state: ProjectGroupsState): ProjectGroupsState {
    this.save(state)
    this.changed(state)
    return state
  }

  /** Legge il JSON salvato; se manca o è rovinato riparte da zero senza fallire. */
  private read(): ProjectGroupsState {
    const row = this.db.prepare('select value from kv where key = ?').get(KEY) as { value: string } | undefined
    try {
      const data = JSON.parse(row?.value ?? '{}') as Partial<ProjectGroupsState>
      const groups = (Array.isArray(data.groups) ? data.groups : []).filter((g) => g && typeof g.id === 'string')
      return {
        groups: groups.map((g) => ({
          id: g.id,
          name: typeof g.name === 'string' ? g.name : '',
          collapsed: g.collapsed === true,
          projectIds: Array.isArray(g.projectIds) ? g.projectIds.filter((id) => typeof id === 'string') : []
        })),
        ungrouped: Array.isArray(data.ungrouped) ? data.ungrouped.filter((id) => typeof id === 'string') : []
      }
    } catch {
      return { groups: [], ungrouped: [] }
    }
  }

  private save(state: ProjectGroupsState): void {
    this.db
      .prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(KEY, JSON.stringify(state))
  }

  /** Toglie ciò che non esiste più e i doppioni (vale il primo posto); i progetti non elencati vanno in coda a `ungrouped`. */
  private normalize(state: ProjectGroupsState): ProjectGroupsState {
    const known = this.knownIds()
    const alive = new Set(known)
    const seen = new Set<string>()
    const keep = (ids: string[]) =>
      ids.filter((id) => {
        if (!alive.has(id) || seen.has(id)) return false
        seen.add(id)
        return true
      })
    const groups = state.groups.map((g) => ({ ...g, projectIds: keep(g.projectIds) }))
    const ungrouped = keep(state.ungrouped)
    for (const id of known) if (!seen.has(id)) ungrouped.push(id)
    return { groups, ungrouped }
  }
}
