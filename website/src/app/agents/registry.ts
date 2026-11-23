// Registro ACP pubblico, letto in fase di build e rinfrescato ogni giorno (cache di Next).
// Se il registro non risponde la pagina esce lo stesso, senza l'elenco completo.
import { cacheLife } from "next/cache"

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"

export type RegistryAgent = {
  id: string
  name: string
  description: string
  website: string | null
  via: string[]
}

type RawEntry = {
  id?: unknown
  name?: unknown
  description?: unknown
  website?: unknown
  repository?: unknown
  distribution?: Record<string, unknown>
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
// Solo link http(s): il registro è di terzi
const safeUrl = (v: unknown) => {
  const s = str(v)
  return /^https?:\/\//.test(s) ? s : null
}

export async function getRegistryAgents(): Promise<RegistryAgent[]> {
  "use cache"
  cacheLife("days")
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const data = (await res.json()) as { agents?: RawEntry[] }
    return (data.agents ?? [])
      .map((e) => ({
        id: str(e.id),
        name: str(e.name),
        description: str(e.description),
        website: safeUrl(e.website) ?? safeUrl(e.repository),
        via: Object.keys(e.distribution ?? {}),
      }))
      .filter((a) => a.id && a.name)
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
  } catch {
    return []
  }
}
