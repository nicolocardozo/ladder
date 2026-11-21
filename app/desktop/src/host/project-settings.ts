// Configurazione del progetto: .ladder/settings.toml (da committare) più .ladder/settings.local.toml (personale).
// Il file personale vince campo per campo; le azioni [[run]] con lo stesso nome si sostituiscono.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { t } from '@shared/i18n'
import type { PermissionLevel, ProjectSettings, RunAction, WorktreeSettingsPatch } from '@shared/protocol'

export const SETTINGS_FILES = ['.ladder/settings.toml', '.ladder/settings.local.toml']
/** Esclusi da git tramite .git/info/exclude. */
export const PERSONAL_PATTERNS = ['.ladder/settings.local.toml', '.ladder/context/']

export function emptySettings(): ProjectSettings {
  return { worktree: { setup: null, setupWait: true, copy: [], ports: 10, archive: null, services: [], personalServices: [] }, run: [], prompts: {}, agents: { allowed: [], default: null, permissionsMax: null }, sources: [], errors: [] }
}

type Table = Record<string, unknown>

const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && !Array.isArray(value)

export async function loadProjectSettings(root: string): Promise<ProjectSettings> {
  const settings = emptySettings()
  // Servizi per file (progetto, personale): si fondono alla fine, per sapere da dove viene ciascuno.
  const byFile: Map<string, { name: string; command: string; port: boolean }>[] = SETTINGS_FILES.map(() => new Map())
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
    apply(settings, data, file, byFile[fileIndex], fileIndex === 0)
  }
  // Uno script vuoto in un file personale serve a togliere quello del progetto: per chi legge è "nessuno".
  settings.worktree.setup ||= null
  settings.worktree.archive ||= null
  // Fusione: prima i servizi del progetto, poi i soli-personali. Un servizio personale con comando vuoto disattiva quello del progetto
  // omonimo (resta in elenco con `disabled`); senza omonimo non dice nulla e non entra nell'elenco fuso.
  const [project, personal] = byFile
  settings.worktree.personalServices = [...personal.values()]
  for (const base of project.values()) {
    const mine = personal.get(base.name)
    if (!mine) settings.worktree.services.push({ ...base, source: 'project', disabled: false })
    else if (!mine.command) settings.worktree.services.push({ ...base, source: 'both', disabled: true, projectCommand: base.command })
    else settings.worktree.services.push({ ...mine, source: 'both', disabled: false, projectCommand: base.command })
  }
  for (const mine of personal.values()) if (mine.command && !project.has(mine.name)) settings.worktree.services.push({ ...mine, source: 'personal', disabled: false })
  // La base resta a setup, shell e [[run]]: con una sola porta i servizi con porta non avrebbero dove partire.
  if (settings.worktree.ports < 2 && settings.worktree.services.some((s) => !s.disabled && s.port)) {
    settings.errors.push(t('worktree.ports must be at least 2 when a service needs a port: the first port is kept for setup and [[run]] actions'))
  }
  return settings
}

function apply(settings: ProjectSettings, data: Table, file: string, services: Map<string, { name: string; command: string; port: boolean }>, isProjectFile: boolean): void {
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
            // Nome ripetuto nello stesso file: vince l'ultimo.
            const name = entry.name.trim()
            const command = entry.command.trim()
            // Nel file del progetto un comando vuoto non ha senso (aprirebbe una shell come «servizio»); in quello personale disattiva il servizio.
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
    }
  }

  // Una sola azione predefinita: vince l'ultima dichiarata.
  const defaults = settings.run.filter((r) => r.default)
  if (defaults.length > 1) for (const r of defaults.slice(0, -1)) r.default = false
}

/**
 * Scrive i campi di [worktree] in .ladder/settings.local.toml (il file personale vince su quello del progetto).
 * Il file si riscrive dal suo contenuto letto: i commenti si perdono. Uno script tolto diventa "" per
 * sovrascrivere anche quello del file del progetto.
 */
export function saveWorktreeSettings(root: string, patch: WorktreeSettingsPatch): Promise<void> {
  // Una coda per file: due salvataggi vicini non si pestano (leggi-modifica-riscrivi).
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
  const worktree: Table = isTable(data.worktree) ? { ...data.worktree } : {}
  if (patch.setup !== undefined) worktree.setup = patch.setup?.trim() ?? ''
  if (patch.archive !== undefined) worktree.archive = patch.archive?.trim() ?? ''
  if (patch.setupWait !== undefined) worktree.setup_wait = patch.setupWait
  if (patch.copy !== undefined) worktree.copy = patch.copy.map((c) => c.trim()).filter(Boolean)
  if (patch.services !== undefined) {
    // Le voci non valide del file personale non si leggono e andrebbero perse alla riscrittura: si rifiuta e l'utente corregge il file.
    const current = data.worktree !== undefined && isTable(data.worktree) ? data.worktree.services : undefined
    if (current !== undefined && !Array.isArray(current)) throw new Error(`${SETTINGS_FILES[1]}: ${t('services must be written as [[worktree.services]]')}. ${t('Fix the file first: saving would delete it.')}`)
    for (const [index, entry] of (Array.isArray(current) ? current : []).entries()) {
      const reason = invalidService(entry)
      if (reason) throw new Error(t('{file}: [[worktree.services]] #{n} is not valid ({reason}). Fix the file first: saving would delete it.', { file: SETTINGS_FILES[1], n: index + 1, reason }))
    }
    // Nome vuoto: rifiuto. Nomi unici (vince l'ultimo); `command` vuoto resta: disattiva il servizio omonimo del progetto.
    const byName = new Map<string, { name: string; command: string; port: boolean }>()
    for (const s of patch.services) {
      if (!s.name.trim()) throw new Error(t('A worktree service needs a name.'))
      byName.set(s.name.trim(), { name: s.name.trim(), command: s.command.trim(), port: s.port !== false })
    }
    worktree.services = [...byName.values()]
  }
  await mkdir(join(root, '.ladder'), { recursive: true })
  const temp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(temp, stringify({ ...data, worktree }))
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Perché una voce di [[worktree.services]] non sopravvivrebbe a una riscrittura (null se è valida): nome e comando testi, port booleano, nessuna chiave in più. */
function invalidService(entry: unknown): string | null {
  if (!isTable(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name.trim()) return t('name and command are required')
  if (entry.port !== undefined && typeof entry.port !== 'boolean') return t('port must be true or false')
  const extra = Object.keys(entry).find((key) => !['name', 'command', 'port'].includes(key))
  return extra ? t('unknown key “{key}”', { key: extra }) : null
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
