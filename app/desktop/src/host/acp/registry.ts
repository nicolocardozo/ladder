// Registro ufficiale degli agenti ACP: il catalogo di "Aggiungi un agente". Dal registro a una voce da avviare,
// senza codice per agente. Ladder avvia le voci npx e uvx, le CLI già installate e i binari scaricati (solo darwin-aarch64).
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentChecksumSource } from '@shared/protocol'
import { safeRelativePath } from '../downloads'

// LADDER_ACP_REGISTRY è solo per sviluppo: il main non la passa all'host nelle build pacchettizzate.
const REGISTRY_URL = process.env.LADDER_ACP_REGISTRY || 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

interface PackageDist {
  package: string
  args?: string[]
  env?: Record<string, string>
}

/** Binario per una piattaforma, come lo scrive il registro. */
interface BinaryDist {
  archive: string
  /** Percorso del programma relativo alla radice dell'archivio. */
  cmd: string
  args?: string[]
  env?: Record<string, string>
  sha256?: string
}

export interface RegistryEntry {
  id: string
  name: string
  version: string
  description: string
  icon?: string
  website?: string
  repository?: string
  distribution: { npx?: PackageDist; uvx?: PackageDist; binary?: Record<string, BinaryDist> }
}

/** Piattaforma dei binari: Ladder si rilascia solo per Mac Apple silicon. */
export const BINARY_PLATFORM = 'darwin-aarch64'

let cache: { at: number; entries: RegistryEntry[] } | null = null

export async function loadRegistry(): Promise<RegistryEntry[]> {
  if (cache && Date.now() - cache.at < 60 * 60_000) return cache.entries
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(t('the ACP registry responded with {status}', { status: response.status }))
  const data = (await response.json()) as { agents?: unknown }
  // Le voci malformate si scartano una per una: una sola non deve far saltare il catalogo.
  cache = { at: Date.now(), entries: Array.isArray(data.agents) ? data.agents.flatMap((raw) => normalizeEntry(raw) ?? []) : [] }
  return cache.entries
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const optionalText = (value: unknown): string | undefined => (text(value) ? value : undefined)

/** Voce del registro nella forma attesa, o null: nome, versione e distribuzione obbligatori, e ogni distribuzione deve avere i campi della sua forma. */
function normalizeEntry(raw: unknown): RegistryEntry | null {
  if (!isObject(raw) || !text(raw.id, 128) || !text(raw.name, 256) || !text(raw.version, 128) || !isObject(raw.distribution)) return null
  const d = raw.distribution
  for (const kind of ['npx', 'uvx'] as const) {
    if (d[kind] !== undefined && (!isObject(d[kind]) || !text(d[kind].package, 512))) return null
  }
  if (d.binary !== undefined) {
    if (!isObject(d.binary)) return null
    for (const platform of Object.values(d.binary)) if (!isObject(platform) || !text(platform.archive, 2048) || !text(platform.cmd, 512)) return null
  }
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: typeof raw.description === 'string' ? raw.description : '',
    icon: optionalText(raw.icon),
    website: optionalText(raw.website),
    repository: optionalText(raw.repository),
    distribution: d as RegistryEntry['distribution']
  }
}

/** Variabili d'ambiente che una voce del registro può impostare (le altre rendono la voce non disponibile): solo interruttori di funzione (…_ACP, …_AUTO_UPDATE…), mai caricamento di librerie o opzioni di runtime. */
const ENV_NAME = /^(?:[A-Z][A-Z0-9]*_)*(?:ACP|EXPERIMENTAL_ACP|ACP_ENABLED|ACP_ZED_ENABLED|DISABLE_AUTO_UPDATE|AUTO_UPDATE_ENABLED)$/
const ENV_DENIED = /^(?:DYLD|LD|NODE|NPM|PYTHON|PATH|HOME|ANTHROPIC|CLAUDE|ELECTRON|LADDER)/
const ENV_VALUE = /^[A-Za-z0-9._-]{1,64}$/

export function safeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ENV_NAME.test(key) && !ENV_DENIED.test(key) && typeof value === 'string' && ENV_VALUE.test(value)) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

/** Vero se tutte le variabili sono accettabili: una scartata in silenzio farebbe partire l'agente in un'altra configurazione. */
function envOk(env: unknown): boolean {
  if (env === undefined) return true
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false
  return Object.keys(env).length === Object.keys(safeEnv(env as Record<string, string>) ?? {}).length
}

/**
 * Argomenti dal registro: stringhe semplici, poche e corte. Vanno a spawn senza shell. Assenti: []. Se uno non è accettabile
 * null, e la voce non parte: senza i suoi flag ACP la CLI si avvierebbe in un'altra modalità.
 */
function safeArgs(args: unknown, binary = false): string[] | null {
  if (args === undefined) return []
  if (!Array.isArray(args) || args.length > 16) return null
  if (!args.every((a) => typeof a === 'string' && a.length <= 256 && !a.includes('\0'))) return null
  return binary && (args as string[]).some((a) => RUNTIME_ARGS.test(a)) ? null : (args as string[])
}

/**
 * Argomenti che un runtime Java (o un altro) esegue come codice: solo per i binari scaricati, dove il programma può essere un `java` firmato dal
 * vendor. `-XX:OnOutOfMemoryError=…`, agenti, classpath e moduli, proprietà `java.*`, file di argomenti (`@file`). Gli argomenti dei 24 binari del registro
 * reale (`acp`, `serve`, `--acp`, `--acp=true`, `--mode acp`, `--agent-engine=v3`…) non li toccano.
 */
const RUNTIME_ARGS = /^(?:-XX:|-javaagent|-agentlib|-agentpath|-Xbootclasspath|-Xrun|-Xdebug|-Xnoagent|-Djava\.|-Djdk\.|-Djavax\.|-Dsun\.|--add-opens|--add-exports|--add-modules|--add-reads|--patch-module|--upgrade-module-path|--module-path|--class-path|-classpath$|-cp$|-J|@)/

/** Vero se una distribuzione della voce (di qualsiasi piattaforma) ha argomenti o ambiente che Ladder rifiuta (la voce si segna `unavailable`). */
export function hasUnsafeArgs(entry: RegistryEntry): boolean {
  const d = entry.distribution
  const all = [d.npx, d.uvx, ...Object.values(d.binary ?? {})]
  return all.some((x) => x && (safeArgs(x.args, x !== d.npx && x !== d.uvx) === null || !envOk(x.env)))
}

/**
 * Il binario darwin-aarch64 di una voce, se c'è e la forma è valida: `cmd` relativo e sicuro, `archive` un URL con schema.
 * L'archivio non https si restituisce comunque (la voce esiste per questo Mac): lo rifiuta `downloadHostOk` con il codice `host`
 * e un testo che dice l'indirizzo, invece di far dire "nessuna build per i Mac Apple silicon".
 */
export function binaryTarget(entry: RegistryEntry): (BinaryDist & { args: string[]; cmd: string }) | null {
  const b = entry.distribution.binary?.[BINARY_PLATFORM]
  if (!b || typeof b.archive !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(b.archive)) return null
  const cmd = safeRelativePath(b.cmd)
  if (!cmd) return null
  const args = safeArgs(b.args, true)
  if (!args) return null
  const sha256 = typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(b.sha256) ? b.sha256.toLowerCase() : undefined
  return { archive: b.archive, cmd, args, env: safeEnv(b.env), sha256 }
}

/** Da dove verrebbe il checksum: dalla voce, dalla release GitHub dell'archivio, o da nessuna parte (nessun download). */
export function checksumSource(target: { archive: string; sha256?: string }): AgentChecksumSource {
  if (target.sha256) return 'registry'
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//.test(target.archive) ? 'github-release' : 'missing'
}

/** Voce con il binario scaricato in `root` (la cartella dell'agente): `command` è il percorso assoluto. */
export function binarySpec(entry: RegistryEntry, root: string): AcpAgentSpec | null {
  const b = binaryTarget(entry)
  if (!b) return null
  return {
    id: entry.id,
    name: entry.name,
    command: join(root, b.cmd),
    args: b.args,
    env: b.env,
    source: 'registry',
    distribution: 'binary',
    version: entry.version,
    description: entry.description,
    icon: entry.icon ?? null
  }
}

/** Voce che usa una CLI già installata (`exe`, percorso assoluto): argomenti e ambiente dal registro, mai inventati. */
export function pathSpec(entry: RegistryEntry, exe: string): AcpAgentSpec | null {
  const d = entry.distribution
  const from = d.npx ?? d.uvx
  const args = from ? safeArgs(from.args) : (binaryTarget(entry)?.args ?? [])
  if (!args) return null
  const env = safeEnv(from ? from.env : binaryTarget(entry)?.env)
  return { id: entry.id, name: entry.name, command: exe, args, env, source: 'registry', distribution: 'path', version: null, description: entry.description, icon: entry.icon ?? null }
}

/** Voce avviabile: npx prima, poi uvx; argomenti e ambiente passano dagli stessi filtri dei binari. null per i soli binari (vedi binarySpec) o con argomenti rifiutati. */
export function specFromEntry(entry: RegistryEntry): AcpAgentSpec | null {
  const d = entry.distribution
  const base = { id: entry.id, name: entry.name, source: 'registry' as const, version: entry.version, description: entry.description, icon: entry.icon ?? null }
  if (d.npx) {
    const args = safeArgs(d.npx.args)
    return args ? { ...base, distribution: 'npx' as const, command: 'npx', args: ['-y', d.npx.package, ...args], env: safeEnv(d.npx.env) } : null
  }
  if (d.uvx) {
    const args = safeArgs(d.uvx.args)
    return args ? { ...base, distribution: 'uvx' as const, command: 'uvx', args: [d.uvx.package, ...args], env: safeEnv(d.uvx.env) } : null
  }
  return null
}

export async function registrySpec(id: string): Promise<AcpAgentSpec | null> {
  const entry = (await loadRegistry()).find((e) => e.id === id)
  const spec = entry ? specFromEntry(entry) : null
  if (spec) spec.icon = await iconData(spec.icon ?? null)
  return spec
}

/** Icona SVG del registro come data URL: si mostra con una maschera, quindi nessuno script può girare. */
export async function iconData(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\//.test(url)) return null
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const text = await response.text()
    if (!response.ok || text.length > 64_000 || !/<svg[\s>]/i.test(text)) return null
    return `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`
  } catch {
    return null
  }
}

export async function registryEntry(id: string): Promise<RegistryEntry | null> {
  return (await loadRegistry()).find((e) => e.id === id) ?? null
}
