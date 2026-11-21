// Profili (LAD-23): più account per agente. Ogni profilo non predefinito ha una cartella di configurazione sotto la cartella dati
// di Ladder (CLAUDE_CONFIG_DIR / CODEX_HOME) con le sue credenziali; il predefinito non ha cartella e usa quella della CLI.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { Profile, ProfileAgent } from '@shared/protocol'
import type { Db } from './db'
import { dataDir } from './downloads'

export const PROFILE_AGENTS: ProfileAgent[] = ['claude-code', 'codex']

export const isProfileAgent = (agent: string): agent is ProfileAgent => agent === 'claude-code' || agent === 'codex'

export const defaultProfileId = (agent: ProfileAgent): string => `default:${agent}`

export const isDefaultProfileId = (id: string): boolean => id.startsWith('default:')

/** `undefined` per il predefinito (assente o `default:<agent>`), altrimenti l'id del profilo. */
export function customProfileId(id: string | null | undefined): string | undefined {
  return id && !isDefaultProfileId(id) ? id : undefined
}

interface ProfileRow {
  id: string
  agent: string
  name: string
  config_dir: string
  added_at: number
}

export class Profiles {
  /** Solo i profili creati dall'utente: i predefiniti si ricavano. */
  private custom = new Map<string, Profile>()

  constructor(private readonly db: Db) {
    for (const row of this.db.prepare('select * from profiles order by added_at').all() as unknown as ProfileRow[]) {
      if (isProfileAgent(row.agent)) this.custom.set(row.id, { id: row.id, agent: row.agent, name: row.name, configDir: row.config_dir, isDefault: false, addedAt: row.added_at })
    }
  }

  private defaultOf(agent: ProfileAgent): Profile {
    return { id: defaultProfileId(agent), agent, name: t('Default'), configDir: null, isDefault: true, addedAt: 0 }
  }

  /** Predefiniti compresi, in ordine: per agente, poi per data. */
  all(): Profile[] {
    return PROFILE_AGENTS.flatMap((agent) => [this.defaultOf(agent), ...this.customOf(agent)])
  }

  customOf(agent: ProfileAgent): Profile[] {
    return [...this.custom.values()].filter((p) => p.agent === agent)
  }

  get(id: string): Profile | null {
    const agent = PROFILE_AGENTS.find((a) => defaultProfileId(a) === id)
    return agent ? this.defaultOf(agent) : (this.custom.get(id) ?? null)
  }

  mustGet(id: string): Profile {
    const profile = this.get(id)
    if (!profile) throw new Error(t('Account not found.'))
    return profile
  }

  private cleanName(agent: ProfileAgent, raw: string, self?: string): string {
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!name) throw new Error(t('An account needs a name.'))
    const taken = this.all().some((p) => p.agent === agent && p.id !== self && p.name.toLowerCase() === name.toLowerCase())
    if (taken) throw new Error(t('An account named “{name}” already exists.', { name }))
    return name
  }

  create(agent: ProfileAgent, rawName: string): Profile {
    if (!isProfileAgent(agent)) throw new Error(t('This agent does not have accounts.'))
    const name = this.cleanName(agent, rawName)
    const id = randomUUID()
    // La cartella contiene le credenziali dell'account: solo per l'utente.
    const configDir = join(dataDir(), 'profiles', agent, id)
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    const profile: Profile = { id, agent, name, configDir, isDefault: false, addedAt: Date.now() }
    this.db.prepare('insert into profiles (id, agent, name, config_dir, added_at) values (?, ?, ?, ?, ?)').run(id, agent, name, configDir, profile.addedAt)
    this.custom.set(id, profile)
    return profile
  }

  rename(id: string, rawName: string): Profile {
    const profile = this.mustGet(id)
    if (profile.isDefault) throw new Error(t('The default account cannot be renamed.'))
    const next = { ...profile, name: this.cleanName(profile.agent, rawName, id) }
    this.db.prepare('update profiles set name = ? where id = ?').run(next.name, id)
    this.custom.set(id, next)
    return next
  }

  /** Toglie il profilo e le scelte dei progetti; la cartella di configurazione resta (ci sono le credenziali). */
  remove(id: string): Profile {
    const profile = this.mustGet(id)
    if (profile.isDefault) throw new Error(t('The default account cannot be removed.'))
    this.db.prepare('delete from profiles where id = ?').run(id)
    this.db.prepare('delete from project_profiles where profile_id = ?').run(id)
    this.custom.delete(id)
    return profile
  }

  /** Scelte per agente di un progetto; assente se non ce n'è nessuna. */
  forProject(projectId: string): Partial<Record<ProfileAgent, string>> | undefined {
    const rows = this.db.prepare('select agent, profile_id from project_profiles where project_id = ?').all(projectId) as { agent: string; profile_id: string }[]
    const out: Partial<Record<ProfileAgent, string>> = {}
    for (const row of rows) if (isProfileAgent(row.agent) && this.custom.has(row.profile_id)) out[row.agent] = row.profile_id
    return Object.keys(out).length ? out : undefined
  }

  setForProject(projectId: string, agent: ProfileAgent, profileId: string | null): void {
    if (!isProfileAgent(agent)) throw new Error(t('This agent does not have accounts.'))
    const id = customProfileId(profileId)
    if (id) {
      if (this.mustGet(id).agent !== agent) throw new Error(t('This account belongs to another agent.'))
      this.db
        .prepare('insert into project_profiles (project_id, agent, profile_id) values (?, ?, ?) on conflict(project_id, agent) do update set profile_id = excluded.profile_id')
        .run(projectId, agent, id)
    } else {
      this.db.prepare('delete from project_profiles where project_id = ? and agent = ?').run(projectId, agent)
    }
  }

  dropProject(projectId: string): void {
    this.db.prepare('delete from project_profiles where project_id = ?').run(projectId)
  }

  /**
   * Profilo con cui parte una nuova sessione: quello chiesto, poi quello del progetto, poi il predefinito.
   * Torna l'id del profilo non predefinito, o null. Agenti senza profili (ACP): sempre null.
   */
  resolve(agent: string, projectId: string, requested?: string | null): string | null {
    if (!isProfileAgent(agent)) return null
    if (requested) {
      const profile = this.mustGet(requested)
      if (profile.agent !== agent) throw new Error(t('This account belongs to another agent.'))
      return profile.isDefault ? null : profile.id
    }
    return this.forProject(projectId)?.[agent] ?? null
  }

  /** Cartella di configurazione del profilo di una sessione; null per il predefinito o un profilo che non c'è più. */
  configDir(profileId: string | null | undefined): string | null {
    const id = customProfileId(profileId)
    return id ? (this.custom.get(id)?.configDir ?? null) : null
  }
}
