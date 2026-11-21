// Configurazione del progetto: .ladder/settings.toml (da committare) più .ladder/settings.local.toml (personale).
// Il file personale vince campo per campo; le azioni [[run]] con lo stesso nome si sostituiscono.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { t } from '@shared/i18n'
import type { PermissionLevel, ProjectSettings, RunAction } from '@shared/protocol'

export const SETTINGS_FILES = ['.ladder/settings.toml', '.ladder/settings.local.toml']
/** Esclusi da git tramite .git/info/exclude. */
export const PERSONAL_PATTERNS = ['.ladder/settings.local.toml', '.ladder/context/']

export function emptySettings(): ProjectSettings {
  return { worktree: { setup: null, copy: [], ports: 10, archive: null }, run: [], prompts: {}, agents: { allowed: [], default: null, permissionsMax: null }, sources: [], errors: [] }
}

type Table = Record<string, unknown>

const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && !Array.isArray(value)

export async function loadProjectSettings(root: string): Promise<ProjectSettings> {
  const settings = emptySettings()
  for (const file of SETTINGS_FILES) {
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
    apply(settings, data, file)
  }
  return settings
}

function apply(settings: ProjectSettings, data: Table, file: string): void {
  const problem = (text: string) => settings.errors.push(`${file}: ${text}`)

  if (data.worktree !== undefined) {
    if (!isTable(data.worktree)) problem(t('[worktree] must be a table'))
    else {
      const w = data.worktree
      if (w.setup !== undefined) typeof w.setup === 'string' ? (settings.worktree.setup = w.setup) : problem(t('worktree.setup must be a string'))
      if (w.archive !== undefined) typeof w.archive === 'string' ? (settings.worktree.archive = w.archive) : problem(t('worktree.archive must be a string'))
      if (w.copy !== undefined) {
        if (Array.isArray(w.copy) && w.copy.every((c) => typeof c === 'string')) settings.worktree.copy = w.copy as string[]
        else problem(t('worktree.copy must be a list of paths'))
      }
      if (w.ports !== undefined) {
        if (Number.isInteger(w.ports) && (w.ports as number) >= 1 && (w.ports as number) <= 100) settings.worktree.ports = w.ports as number
        else problem(t('worktree.ports must be an integer between 1 and 100'))
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
    }
  }

  // Una sola azione predefinita: vince l'ultima dichiarata.
  const defaults = settings.run.filter((r) => r.default)
  if (defaults.length > 1) for (const r of defaults.slice(0, -1)) r.default = false
}

export const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']

/** "gemini" e "acp:gemini" indicano lo stesso agente ACP; i nativi restano come sono. */
export function agentKey(name: string): string {
  const id = name.trim()
  return id === 'claude-code' || id === 'codex' || id.startsWith('acp:') ? id : `acp:${id}`
}

/** Il livello più alto ammesso dal progetto. */
export function clampPermission(level: PermissionLevel, max: PermissionLevel | null): PermissionLevel {
  if (!max) return level
  return LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level
}
