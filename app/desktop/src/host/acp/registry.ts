// Official registry of ACP agents: the catalog behind "Add an agent". From the registry to an entry to launch,
// with no per-agent code. Ladder launches npx and uvx entries, already installed CLIs and downloaded binaries (darwin-aarch64 only).
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentChecksumSource } from '@shared/protocol'
import { safeRelativePath } from '../downloads'

// LADDER_ACP_REGISTRY is for development only: main doesn't pass it to the host in packaged builds.
const REGISTRY_URL = process.env.LADDER_ACP_REGISTRY || 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

interface PackageDist {
  package: string
  args?: string[]
  env?: Record<string, string>
}

/** Binary for a platform, as the registry writes it. */
interface BinaryDist {
  archive: string
  /** Path of the program relative to the archive root. */
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

/** Platform of the binaries: Ladder ships only for Apple silicon Macs. */
export const BINARY_PLATFORM = 'darwin-aarch64'

let cache: { at: number; entries: RegistryEntry[] } | null = null

export async function loadRegistry(): Promise<RegistryEntry[]> {
  if (cache && Date.now() - cache.at < 60 * 60_000) return cache.entries
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(t('the ACP registry responded with {status}', { status: response.status }))
  const data = (await response.json()) as { agents?: unknown }
  // Malformed entries are dropped one by one: a single one must not break the catalog.
  cache = { at: Date.now(), entries: Array.isArray(data.agents) ? data.agents.flatMap((raw) => normalizeEntry(raw) ?? []) : [] }
  return cache.entries
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const optionalText = (value: unknown): string | undefined => (text(value) ? value : undefined)

/** Registry entry in the expected shape, or null: name, version and distribution required, and each distribution must have the fields of its shape. */
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

/** Environment variables a registry entry may set (others make the entry unavailable): only feature switches (…_ACP, …_AUTO_UPDATE…), never library loading or runtime options. */
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

/** True if all variables are acceptable: one silently dropped would start the agent in a different configuration. */
function envOk(env: unknown): boolean {
  if (env === undefined) return true
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false
  return Object.keys(env).length === Object.keys(safeEnv(env as Record<string, string>) ?? {}).length
}

/**
 * Arguments from the registry: plain strings, few and short. They go to spawn without a shell. Missing: []. If one is not acceptable
 * null, and the entry doesn't start: without its ACP flags the CLI would start in another mode.
 */
function safeArgs(args: unknown, binary = false): string[] | null {
  if (args === undefined) return []
  if (!Array.isArray(args) || args.length > 16) return null
  if (!args.every((a) => typeof a === 'string' && a.length <= 256 && !a.includes('\0'))) return null
  return binary && (args as string[]).some((a) => RUNTIME_ARGS.test(a)) ? null : (args as string[])
}

/**
 * Arguments that a Java (or other) runtime executes as code: only for downloaded binaries, where the program may be a `java` signed by the
 * vendor. `-XX:OnOutOfMemoryError=…`, agents, classpath and modules, `java.*` properties, argument files (`@file`). The arguments of the 24 binaries in the real
 * registry (`acp`, `serve`, `--acp`, `--acp=true`, `--mode acp`, `--agent-engine=v3`…) don't touch them.
 */
const RUNTIME_ARGS = /^(?:-XX:|-javaagent|-agentlib|-agentpath|-Xbootclasspath|-Xrun|-Xdebug|-Xnoagent|-Djava\.|-Djdk\.|-Djavax\.|-Dsun\.|--add-opens|--add-exports|--add-modules|--add-reads|--patch-module|--upgrade-module-path|--module-path|--class-path|-classpath$|-cp$|-J|@)/

/** True if a distribution of the entry (on any platform) has arguments or environment that Ladder rejects (the entry is marked `unavailable`). */
export function hasUnsafeArgs(entry: RegistryEntry): boolean {
  const d = entry.distribution
  const all = [d.npx, d.uvx, ...Object.values(d.binary ?? {})]
  return all.some((x) => x && (safeArgs(x.args, x !== d.npx && x !== d.uvx) === null || !envOk(x.env)))
}

/**
 * The darwin-aarch64 binary of an entry, if present and the shape is valid: relative and safe `cmd`, `archive` a URL with a scheme.
 * A non-https archive is returned anyway (the entry exists for this Mac): `downloadHostOk` rejects it with the `host` code
 * and a text that states the address, instead of saying "no build for Apple silicon Macs".
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

/** Where the checksum would come from: from the entry, from the archive's GitHub release, or from nowhere (no download). */
export function checksumSource(target: { archive: string; sha256?: string }): AgentChecksumSource {
  if (target.sha256) return 'registry'
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//.test(target.archive) ? 'github-release' : 'missing'
}

/** Entry with the binary downloaded into `root` (the agent's folder): `command` is the absolute path. */
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

/** Entry that uses an already installed CLI (`exe`, absolute path): arguments and environment from the registry, never invented. */
export function pathSpec(entry: RegistryEntry, exe: string): AcpAgentSpec | null {
  const d = entry.distribution
  const from = d.npx ?? d.uvx
  const args = from ? safeArgs(from.args) : (binaryTarget(entry)?.args ?? [])
  if (!args) return null
  const env = safeEnv(from ? from.env : binaryTarget(entry)?.env)
  return { id: entry.id, name: entry.name, command: exe, args, env, source: 'registry', distribution: 'path', version: null, description: entry.description, icon: entry.icon ?? null }
}

/** Launchable entry: npx first, then uvx; arguments and environment go through the same filters as the binaries. null for binary-only entries (see binarySpec) or with rejected arguments. */
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

/** Registry SVG icon as a data URL: shown with a mask, so no script can run. */
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
