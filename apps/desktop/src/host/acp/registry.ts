// Registro ufficiale degli agenti ACP: il catalogo di "Aggiungi un agente". Dal registro a una voce da avviare,
// senza codice per agente. Ladder avvia le voci npx e uvx; i binari da scaricare arriveranno dopo.
import type { AcpAgentSpec, RegistryAgent } from '@shared/protocol'

const REGISTRY_URL = process.env.LADDER_ACP_REGISTRY || 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

interface PackageDist {
  package: string
  args?: string[]
  env?: Record<string, string>
}

interface RegistryEntry {
  id: string
  name: string
  version: string
  description: string
  distribution: { npx?: PackageDist; uvx?: PackageDist; binary?: Record<string, unknown> }
}

let cache: { at: number; entries: RegistryEntry[] } | null = null

export async function loadRegistry(): Promise<RegistryEntry[]> {
  if (cache && Date.now() - cache.at < 60 * 60_000) return cache.entries
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`il registro ACP ha risposto ${response.status}`)
  const data = (await response.json()) as { agents?: RegistryEntry[] }
  cache = { at: Date.now(), entries: data.agents ?? [] }
  return cache.entries
}

/** Voce avviabile: npx prima, poi uvx. null per gli agenti distribuiti solo come binari. */
export function specFromEntry(entry: RegistryEntry): AcpAgentSpec | null {
  const d = entry.distribution
  const base = { id: entry.id, name: entry.name, source: 'registry' as const, version: entry.version, description: entry.description }
  if (d.npx) return { ...base, command: 'npx', args: ['-y', d.npx.package, ...(d.npx.args ?? [])], env: d.npx.env }
  if (d.uvx) return { ...base, command: 'uvx', args: [d.uvx.package, ...(d.uvx.args ?? [])], env: d.uvx.env }
  return null
}

export async function registryAgents(added: Set<string>): Promise<RegistryAgent[]> {
  const entries = await loadRegistry()
  const out: RegistryAgent[] = []
  for (const entry of entries) {
    const spec = specFromEntry(entry)
    if (!spec) continue
    out.push({ id: entry.id, name: entry.name, version: entry.version, description: entry.description, command: spec.command, args: spec.args, added: added.has(entry.id) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function registrySpec(id: string): Promise<AcpAgentSpec | null> {
  const entry = (await loadRegistry()).find((e) => e.id === id)
  return entry ? specFromEntry(entry) : null
}
