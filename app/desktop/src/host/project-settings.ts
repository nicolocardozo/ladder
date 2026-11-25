// Project configuration: .ladder/settings.toml (to be committed) plus .ladder/settings.local.toml (personal).
// The personal file wins field by field; [[run]] actions with the same name replace each other.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { t } from '@shared/i18n'
import type { AgentDelegate, AgentId, Effort, PermissionLevel, ProjectSettings, RunAction, WorktreeSettingsPatch } from '@shared/protocol'

export const SETTINGS_FILES = ['.ladder/settings.toml', '.ladder/settings.local.toml']
/** Esclusi da git tramite .git/info/exclude. */
export const PERSONAL_PATTERNS = ['.ladder/settings.local.toml', '.ladder/context/']

export function emptySettings(): ProjectSettings {
  return { worktree: { setup: null, setupWait: true, copy: [], ports: 10, archive: null, services: [], personalServices: [] }, run: [], prompts: {}, agents: { allowed: [], default: null, permissionsMax: null, delegates: [], autoSwitch: null, crossReview: null }, sources: [], errors: [] }
}

type Table = Record<string, unknown>

const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && !Array.isArray(value)

export async function loadProjectSettings(root: string): Promise<ProjectSettings> {
  const settings = emptySettings()
  // Services per file (project, personal): merged at the end, to know where each one comes from.
  const byFile: Map<string, { name: string; command: string; port: boolean }>[] = SETTINGS_FILES.map(() => new Map())
  // Delegates per file: merged by name at the end (personal wins).
  const delegatesByFile: Map<string, AgentDelegate>[] = SETTINGS_FILES.map(() => new Map())
  for (const [fileIndex, file] of SETTINGS_FILES.entries()) {
    let raw: string
    try {
      raw = await readFile(join(root, file), 'utf8')
    } catch {
      continue
    }
    settings.sources.push(file)
    let data: Table
    try {
      data = parse(raw) as Table
    } catch (error) {
      settings.errors.push(`${file}: ${(error as Error).message.split('\n')[0]}`)
      continue
    }
    apply(settings, data, file, byFile[fileIndex], fileIndex === 0, delegatesByFile[fileIndex])
  }
  // An empty script in a personal file removes the project one: for readers it means "none".
  settings.worktree.setup ||= null
  settings.worktree.archive ||= null
  // Merge: project services first, then the personal-only ones. A personal service with an empty command disables the project one
  // with the same name (it stays in the list with `disabled`); without a same-name project service it says nothing and stays out of the merged list.
  const [project, personal] = byFile
  settings.worktree.personalServices = [...personal.values()]
  for (const base of project.values()) {
    const mine = personal.get(base.name)
    if (!mine) settings.worktree.services.push({ ...base, source: 'project', disabled: false })
    else if (!mine.command) settings.worktree.services.push({ ...base, source: 'both', disabled: true, projectCommand: base.command })
    else settings.worktree.services.push({ ...mine, source: 'both', disabled: false, projectCommand: base.command })
  }
  for (const mine of personal.values()) if (mine.command && !project.has(mine.name)) settings.worktree.services.push({ ...mine, source: 'personal', disabled: false })
  // Delegates: project ones first (replaced by a personal one with the same name), then the personal-only ones. Agent not allowed: error and entry dropped.
  const merged = new Map<string, AgentDelegate>()
  for (const map of delegatesByFile) for (const [name, delegate] of map) merged.set(name, delegate)
  for (const delegate of merged.values()) {
    if (settings.agents.allowed.length && !settings.agents.allowed.includes(delegate.agent)) {
      settings.errors.push(t('[[agents.delegates]] “{name}”: agent {agent} is not in agents.allowed', { name: delegate.name, agent: delegate.agent }))
      continue
    }
    settings.agents.delegates.push({ ...delegate, permission: clampPermission(delegate.permission, settings.agents.permissionsMax) })
  }
  // The base stays at setup, shell and [[run]]: with a single port, services with a port would have nowhere to start.
  if (settings.worktree.ports < 2 && settings.worktree.services.some((s) => !s.disabled && s.port)) {
    settings.errors.push(t('worktree.ports must be at least 2 when a service needs a port: the first port is kept for setup and [[run]] actions'))
  }
  return settings
}

function apply(settings: ProjectSettings, data: Table, file: string, services: Map<string, { name: string; command: string; port: boolean }>, isProjectFile: boolean, delegates: Map<string, AgentDelegate>): void {
  const problem = (text: string) => settings.errors.push(`${file}: ${text}`)

  if (data.worktree !== undefined) {
    if (!isTable(data.worktree)) problem(t('[worktree] must be a table'))
    else {
      const w = data.worktree
      if (w.setup !== undefined) typeof w.setup === 'string' ? (settings.worktree.setup = w.setup) : problem(t('worktree.setup must be a string'))
      if (w.setup_wait !== undefined) typeof w.setup_wait === 'boolean' ? (settings.worktree.setupWait = w.setup_wait) : problem(t('worktree.setup_wait must be true or false'))
      if (w.archive !== undefined) typeof w.archive === 'string' ? (settings.worktree.archive = w.archive) : problem(t('worktree.archive must be a string'))
      if (w.copy !== undefined) {
        if (Array.isArray(w.copy) && w.copy.every((c) => typeof c === 'string')) settings.worktree.copy = w.copy as string[]
        else problem(t('worktree.copy must be a list of paths'))
      }
      if (w.ports !== undefined) {
        if (Number.isInteger(w.ports) && (w.ports as number) >= 1 && (w.ports as number) <= 100) settings.worktree.ports = w.ports as number
        else problem(t('worktree.ports must be an integer between 1 and 100'))
      }
      if (w.services !== undefined) {
        if (!Array.isArray(w.services)) problem(t('services must be written as [[worktree.services]]'))
        else {
          for (const [index, entry] of w.services.entries()) {
            if (!isTable(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name.trim()) {
              problem(t('[[worktree.services]] #{n}: name and command are required', { n: index + 1 }))
              continue
            }
            if (entry.port !== undefined && typeof entry.port !== 'boolean') {
              problem(t('[[worktree.services]] #{n}: port must be true or false', { n: index + 1 }))
              continue
            }
            // Repeated name in the same file: the last wins.
            const name = entry.name.trim()
            const command = entry.command.trim()
            // In the project file an empty command makes no sense (it would open a shell as a "service"); in the personal one it disables the service.
            if (!command && isProjectFile) {
              problem(t('[[worktree.services]] #{n}: the command can’t be empty (a personal file can turn a service off with an empty command)', { n: index + 1 }))
              continue
            }
            services.set(name, { name, command, port: entry.port !== false })
          }
        }
      }
    }
  }

  if (data.run !== undefined) {
    if (!Array.isArray(data.run)) problem(t('actions must be written as [[run]]'))
    else {
      for (const [index, entry] of data.run.entries()) {
        if (!isTable(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name.trim()) {
          problem(t('[[run]] #{n}: name and command are required', { n: index + 1 }))
          continue
        }
        const action: RunAction = {
          name: entry.name.trim(),
          command: entry.command,
          default: entry.default === true,
          concurrent: entry.concurrent !== false
        }
        const existing = settings.run.findIndex((r) => r.name === action.name)
        if (existing >= 0) settings.run[existing] = action
        else settings.run.push(action)
      }
    }
  }

  if (data.prompts !== undefined) {
    if (!isTable(data.prompts)) problem(t('[prompts] must be a table'))
    else for (const [key, value] of Object.entries(data.prompts)) if (typeof value === 'string') settings.prompts[key] = value
  }

  if (data.agents !== undefined) {
    if (!isTable(data.agents)) problem(t('[agents] must be a table'))
    else {
      const a = data.agents
      if (a.allowed !== undefined) {
        if (Array.isArray(a.allowed) && a.allowed.every((x) => typeof x === 'string')) settings.agents.allowed = (a.allowed as string[]).map(agentKey)
        else problem(t('agents.allowed must be a list of agents, for example ["claude-code", "codex"]'))
      }
      if (a.default !== undefined) typeof a.default === 'string' ? (settings.agents.default = agentKey(a.default)) : problem(t('agents.default must be a string'))
      if (a.permissions_max !== undefined) {
        if (typeof a.permissions_max === 'string' && LEVELS.includes(a.permissions_max as PermissionLevel)) settings.agents.permissionsMax = a.permissions_max as PermissionLevel
        else problem(t('agents.permissions_max must be plan, ask, edit or full'))
      }
      // Empty string = off (so a personal file can turn off the project value).
      for (const [key, field] of [['auto_switch', 'autoSwitch'], ['cross_review', 'crossReview']] as const) {
        if (a[key] === undefined) continue
        if (typeof a[key] === 'string') settings.agents[field] = (a[key] as string).trim() ? (agentKey(a[key] as string) as AgentId) : null
        else problem(t('agents.{key} must be an agent, for example "codex"', { key }))
      }
      if (a.delegates !== undefined) {
        if (!Array.isArray(a.delegates)) problem(t('delegates must be written as [[agents.delegates]]'))
        else {
          for (const [index, entry] of a.delegates.entries()) {
            const n = index + 1
            if (!isTable(entry) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.agent !== 'string' || !entry.agent.trim()) {
              problem(t('[[agents.delegates]] #{n}: name and agent are required', { n }))
              continue
            }
            if (entry.model !== undefined && typeof entry.model !== 'string') {
              problem(t('[[agents.delegates]] #{n}: model must be a string', { n }))
              continue
            }
            if (entry.effort !== undefined && !(typeof entry.effort === 'string' && EFFORTS.includes(entry.effort as Effort))) {
              problem(t('[[agents.delegates]] #{n}: effort must be low, medium, high, xhigh or max', { n }))
              continue
            }
            if (entry.permission !== undefined && !(typeof entry.permission === 'string' && LEVELS.includes(entry.permission as PermissionLevel))) {
              problem(t('[[agents.delegates]] #{n}: permission must be plan, ask, edit or full', { n }))
              continue
            }
            if (entry.note !== undefined && typeof entry.note !== 'string') {
              problem(t('[[agents.delegates]] #{n}: note must be a string', { n }))
              continue
            }
            // Repeated name in the same file: the last wins. Short texts: they end up in the model context.
            const name = entry.name.trim().slice(0, 40)
            delegates.set(name, {
              name,
              agent: agentKey(entry.agent) as AgentDelegate['agent'],
              model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim().slice(0, 80) : null,
              effort: (entry.effort as Effort | undefined) ?? null,
              permission: (entry.permission as PermissionLevel | undefined) ?? 'plan',
              note: typeof entry.note === 'string' ? entry.note.trim().slice(0, 300) : ''
            })
          }
        }
      }
    }
  }

  // Only one default action: the last declared wins.
  const defaults = settings.run.filter((r) => r.default)
  if (defaults.length > 1) for (const r of defaults.slice(0, -1)) r.default = false
}

/**
 * Writes the [worktree] fields to .ladder/settings.local.toml (the personal file wins over the project one).
 * The file is rewritten from the content read: comments are lost. A removed script becomes "" to
 * also override the one in the project file.
 */
export function saveWorktreeSettings(root: string, patch: WorktreeSettingsPatch): Promise<void> {
  // One queue per file: two close saves don't trample each other (read-modify-rewrite).
  const file = join(root, SETTINGS_FILES[1])
  const run = (saves.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => writeWorktreeSettings(root, patch))
  saves.set(file, run)
  void run.catch(() => undefined).then(() => {
    if (saves.get(file) === run) saves.delete(file)
  })
  return run
}

const saves = new Map<string, Promise<void>>()

async function writeWorktreeSettings(root: string, patch: WorktreeSettingsPatch): Promise<void> {
  await updatePersonalFile(root, (data) => {
    const worktree: Table = isTable(data.worktree) ? { ...data.worktree } : {}
    if (patch.setup !== undefined) worktree.setup = patch.setup?.trim() ?? ''
    if (patch.archive !== undefined) worktree.archive = patch.archive?.trim() ?? ''
    if (patch.setupWait !== undefined) worktree.setup_wait = patch.setupWait
    if (patch.copy !== undefined) worktree.copy = patch.copy.map((c) => c.trim()).filter(Boolean)
    if (patch.services !== undefined) {
      // Invalid entries in the personal file are not read and would be lost on rewrite: refuse, and the user fixes the file.
      const current = data.worktree !== undefined && isTable(data.worktree) ? data.worktree.services : undefined
      if (current !== undefined && !Array.isArray(current)) throw new Error(`${SETTINGS_FILES[1]}: ${t('services must be written as [[worktree.services]]')}. ${t('Fix the file first: saving would delete it.')}`)
      for (const [index, entry] of (Array.isArray(current) ? current : []).entries()) {
        const reason = invalidService(entry)
        if (reason) throw new Error(t('{file}: [[worktree.services]] #{n} is not valid ({reason}). Fix the file first: saving would delete it.', { file: SETTINGS_FILES[1], n: index + 1, reason }))
      }
      // Empty name: refused. Unique names (the last wins); an empty `command` is kept: it disables the project service with the same name.
      const byName = new Map<string, { name: string; command: string; port: boolean }>()
      for (const s of patch.services) {
        if (!s.name.trim()) throw new Error(t('A worktree service needs a name.'))
        byName.set(s.name.trim(), { name: s.name.trim(), command: s.command.trim(), port: s.port !== false })
      }
      worktree.services = [...byName.values()]
    }
    return { ...data, worktree }
  })
}

/**
  * Writes [agents] auto_switch and cross_review in the personal file. null turns off: "" is written (TOML has no null), so it
  * also wins over the project file value. The other [agents] fields (allowed, delegates…) are left as they are.
 */
export function saveAgentsSettings(root: string, patch: { autoSwitch?: string | null; crossReview?: string | null }): Promise<void> {
  const file = join(root, SETTINGS_FILES[1])
  const run = (saves.get(file) ?? Promise.resolve()).catch(() => undefined).then(() =>
    updatePersonalFile(root, (data) => {
      const agents: Table = isTable(data.agents) ? { ...data.agents } : {}
      if (patch.autoSwitch !== undefined) agents.auto_switch = patch.autoSwitch ? agentKey(patch.autoSwitch) : ''
      if (patch.crossReview !== undefined) agents.cross_review = patch.crossReview ? agentKey(patch.crossReview) : ''
      return { ...data, agents }
    })
  )
  saves.set(file, run)
  void run.catch(() => undefined).then(() => {
    if (saves.get(file) === run) saves.delete(file)
  })
  return run
}

/** Reads the personal file, applies `change` and rewrites it atomically (comments are lost). */
async function updatePersonalFile(root: string, change: (data: Table) => Table): Promise<void> {
  const file = join(root, SETTINGS_FILES[1])
  let data: Table = {}
  let raw: string | null = null
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new Error(t('Cannot read {file} ({code}).', { file: SETTINGS_FILES[1], code: code ?? 'unknown' }))
  }
  if (raw !== null) {
    try {
      data = parse(raw) as Table
    } catch {
      throw new Error(t('{file} has a syntax error: fix it first.', { file: SETTINGS_FILES[1] }))
    }
  }
  const next = change(data)
  await mkdir(join(root, '.ladder'), { recursive: true })
  const temp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(temp, stringify(next))
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Why a [[worktree.services]] entry wouldn't survive a rewrite (null if valid): name and command are text, port is boolean, no extra keys. */
function invalidService(entry: unknown): string | null {
  if (!isTable(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name.trim()) return t('name and command are required')
  if (entry.port !== undefined && typeof entry.port !== 'boolean') return t('port must be true or false')
  const extra = Object.keys(entry).find((key) => !['name', 'command', 'port'].includes(key))
  return extra ? t('unknown key “{key}”', { key: extra }) : null
}

export const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** "gemini" and "acp:gemini" mean the same ACP agent; native ones stay as they are. */
export function agentKey(name: string): string {
  const id = name.trim()
  return id === 'claude-code' || id === 'codex' || id.startsWith('acp:') ? id : `acp:${id}`
}

/** The highest level the project allows. */
export function clampPermission(level: PermissionLevel, max: PermissionLevel | null): PermissionLevel {
  // An unknown level never passes: the project's maximum applies, or the cautious level if there is none.
  if (!LEVELS.includes(level)) return max ?? 'ask'
  if (!max) return level
  return LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level
}
