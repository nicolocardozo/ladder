// ACP agent catalog: commands to the host and state of a list read once.
// The catalog is requested when Settings → Agents opens (it does a login-shell pass for CLIs), never on every render.
// The installation of a binary advances through `agent.install` events: the list applies them to the entry, and at the end it rereads.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentBlockCode, AgentCatalogEntry, AgentChecksumSource, AgentInstall, AgentLogin, AgentSignature } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { onHostEvent, request } from '@/lib/host-client'

/** Catalog commands. Like `ConnectionActions`: the same list serves the app and the web preview with a fake host. */
export interface AgentCatalogActions {
  catalog: () => Promise<AgentCatalogEntry[]>
  /** Only the CLIs already installed (first launch): lighter than the catalog. */
  detect: () => Promise<AgentCatalogEntry[]>
  /** Detected CLI, already downloaded binary or npx/uvx package: the host picks the entry from the registry. */
  add: (entry: AgentCatalogEntry) => Promise<void>
  /** Call only after the user's confirmation (`confirmed: true`): version pinned by the registry. */
  install: (entry: AgentCatalogEntry) => Promise<AgentInstall | void>
  /** Sign-in with a method declared by the agent (`agent` only): Ladder never sees the credentials. It can take minutes; the updated login is returned. */
  authenticate: (id: string, methodId: string, projectId?: string) => Promise<AgentLogin>
  /** "Stop waiting": the host stops the sign-in in progress and frees the id; the pending `authenticate` request answers with the login as it was. */
  cancelAuthenticate: (id: string) => Promise<void>
  /** Changes to an agent's login (registry id); returns the function to stop listening. */
  onLogin: (listener: (id: string, login: AgentLogin) => void) => () => void
  cancel: (id: string) => Promise<void>
  /** Installation steps; returns the function to stop listening. */
  onInstall: (listener: (install: AgentInstall) => void) => () => void
  /** An agent removed from "Your agents" (registry id, without `acp:`); returns the function to stop listening. */
  onRemoved: (listener: (id: string) => void) => () => void
}

export const liveAgentCatalogActions: AgentCatalogActions = {
  catalog: () => request<AgentCatalogEntry[]>({ type: 'agents.catalog' }),
  detect: () => request<AgentCatalogEntry[]>({ type: 'agents.detect' }),
  add: async (entry) => {
    // For `source: 'registry'` the host derives command and arguments from the registry entry: only the id matters.
    await request({ type: 'agents.add', spec: { id: entry.id, name: entry.name, command: '', args: [], source: 'registry' } })
  },
  install: (entry) => {
    // Version, checksum and host shown in the confirmation travel with the command: if the registry gives different ones, the host rejects.
    const download = entry.download
    if (!download || !download.sha256) return Promise.reject(new Error(t('The checksum is not available now. Try again later.')))
    return request<AgentInstall>({ type: 'agents.install', id: entry.id, version: entry.registryVersion, confirmed: true, sha256: download.sha256, host: download.host })
  },
  authenticate: (id, methodId, projectId) => request<AgentLogin>({ type: 'agents.authenticate', id, methodId, ...(projectId ? { projectId } : {}) }),
  cancelAuthenticate: async (id) => {
    await request({ type: 'agents.authenticate.cancel', id })
  },
  onLogin: (listener) => onHostEvent((event) => event.type === 'agent.login' && listener(event.id, event.login)),
  cancel: async (id) => {
    await request({ type: 'agents.install.cancel', id })
  },
  onInstall: (listener) => onHostEvent((event) => event.type === 'agent.install' && listener(event.install)),
  onRemoved: (listener) => onHostEvent((event) => event.type === 'agent.removed' && listener(event.agent.replace(/^acp:/, '')))
}

export interface CatalogState {
  /** null: not read yet. Installations come from the events map, not from the catalog response. */
  entries: AgentCatalogEntry[] | null
  loading: boolean
  error: string | null
  /**
   * `onRead` receives the list read by the latest read (even if its own was superseded): used to compare it with what the user confirmed.
   * `manual: true` for a read requested by the user (Rescan, Try again): only then is a non-final error considered superseded
   * by an entry without blocks. A read caused by the rejection itself, or by another event, removes an error only if the registry version has changed.
   */
  reload: (onRead?: (list: AgentCatalogEntry[]) => void, options?: { manual?: boolean }) => void
  /** Records a new login (event or `authenticate` response). */
  setLogin: (id: string, login: AgentLogin) => void
  /** Changes an entry locally (e.g. "added"). */
  patch: (id: string, change: Partial<AgentCatalogEntry>) => void
  /** Records the state of an installation (event, response or command rejection). Returns the arrival sequence number. */
  setInstall: (install: AgentInstall) => number
  /** Applies the `agents.install` response only if nothing more recent has arrived in the meantime (`seq` is the one from `setInstall`). */
  setInstallIfCurrent: (install: AgentInstall, seq: number) => void
}

type Tracked = { install: AgentInstall; seq: number }

/**
 * Reads the catalog and keeps installations aligned with the host's events.
 * Installations live in a separate map, fed only by events and `agents.install` responses, in arrival order;
 * it is overlaid on the `catalog()` result, which may have been built before a more recent event.
 */
export function useAgentCatalog(actions: AgentCatalogActions): CatalogState {
  const [list, setList] = useState<AgentCatalogEntry[] | null>(null)
  const [installs, setInstalls] = useState<Record<string, Tracked>>({})
  const [logins, setLogins] = useState<Record<string, AgentLogin>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Response order: an old read does not overwrite a newer one.
  const reads = useRef(0)
  // Whoever requested a read that was then superseded (e.g. a `done` from another installation) receives it from the winning read: never lost.
  const waiting = useRef<Array<(list: AgentCatalogEntry[]) => void>>([])
  // A manual read later superseded by a newer one passes its manual flag to the winning one.
  const manualRead = useRef(false)
  // Arrival order of installation states.
  const arrivals = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reload = useCallback((onRead?: (list: AgentCatalogEntry[]) => void, options?: { manual?: boolean }) => {
    const read = ++reads.current
    if (onRead) waiting.current.push(onRead)
    if (options?.manual) manualRead.current = true
    const startedAt = arrivals.current
    setLoading(true)
    setError(null)
    actions
      .catalog()
      .then((next) => {
        if (!mounted.current || read !== reads.current) return
        setList(next)
        const manual = manualRead.current
        manualRead.current = false
        const callbacks = waiting.current
        waiting.current = []
        for (const callback of callbacks) callback(next)
        // A `done` seen before this read is by now in the catalog (added, version); a later one stays until its read arrives.
        setInstalls((map) => {
          // A "running" seen before the read, which now says install: null, finished or was cancelled without an event.
          const absent = new Set(next.filter((entry) => entry.install === null).map((entry) => entry.id))
          const stale = Object.keys(map).filter((id) => {
            const { install, seq } = map[id]
            if (seq > startedAt) return false
            if (install.state === 'error') {
              // An error superseded by the catalog does not stay until restart: with a new registry version always; for a non-final code
              // (transient 404, redirect) only after a manual read. One caused by the rejection does not remove it: the catalog does not see what the host saw at download.
              const fresh = next.find((entry) => entry.id === id)
              return fresh !== undefined && supersededError(install, fresh) && (manual || install.version !== fresh.registryVersion)
            }
            return install.state === 'done' || (install.state === 'running' && absent.has(id))
          })
          if (stale.length === 0) return map
          const copy = { ...map }
          for (const id of stale) delete copy[id]
          return copy
        })
      })
      .catch((e: Error) => {
        if (mounted.current && read === reads.current) {
          waiting.current = []
          manualRead.current = false
        }
        if (mounted.current && read === reads.current) setError(t('ACP registry unreachable: {error}', { error: e.message }))
      })
      .finally(() => {
        if (mounted.current && read === reads.current) setLoading(false)
      })
  }, [actions])

  useEffect(() => {
    reload()
  }, [reload])

  const patch = useCallback((id: string, change: Partial<AgentCatalogEntry>) => {
    setList((current) => current?.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)) ?? current)
  }, [])

  const setInstall = useCallback((install: AgentInstall) => {
    const seq = ++arrivals.current
    setInstalls((map) => ({ ...map, [install.id]: { install, seq } }))
    return seq
  }, [])

  const setInstallIfCurrent = useCallback((install: AgentInstall, seq: number) => {
    setInstalls((map) => {
      if (map[install.id]?.seq !== seq) return map
      return { ...map, [install.id]: { install, seq: ++arrivals.current } }
    })
  }, [])

  useEffect(
    () =>
      actions.onInstall((install) => {
        setInstall(install)
        // Finished successfully: state, version and "added" have changed on the host.
        if (install.state === 'done') reload()
      }),
    [actions, setInstall, reload]
  )

  const setLogin = useCallback((id: string, login: AgentLogin) => {
    setLogins((map) => (map[id] && (map[id].checkedAt ?? -1) > (login.checkedAt ?? -1) ? map : { ...map, [id]: login }))
  }, [])
  useEffect(() => actions.onLogin(setLogin), [actions, setLogin])

  // Agent removed from "Your agents": the row goes back to Add immediately, then the read confirms (it also covers a removal during the download).
  useEffect(
    () =>
      actions.onRemoved((id) => {
        patch(id, { added: false })
        reload()
      }),
    [actions, patch, reload]
  )

  // The most recent login wins, whether it comes from an event, from the `authenticate` response or from the catalog read.
  const entries = useMemo(
    () =>
      list?.map((entry) => {
        const login = logins[entry.id]
        const next = login && (login.checkedAt ?? -1) > (entry.login.checkedAt ?? -1) ? { ...entry, login } : entry
        return installs[entry.id] ? { ...next, install: installs[entry.id].install } : next
      }) ?? null,
    [list, installs, logins]
  )

  return { entries, loading, error, reload, setLogin, patch, setInstall, setInstallIfCurrent }
}

/** Where the checksum comes from, for the confirmation before the download. */
export function checksumLabel(source: AgentChecksumSource): string {
  switch (source) {
    case 'registry':
      return t('The ACP registry')
    case 'github-release':
      return t('The GitHub release')
    default:
      return t('None')
  }
}

/** Links opened only if https, as the main process does (`ladder:open-external`); never `window.open` with an arbitrary URL. */
export function openSecure(url: string): void {
  // Like the main process: parsed URL (scheme and host case-insensitive), https only with a host.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname) return
  } catch {
    return
  }
  if (window.ladder) void window.ladder.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/** Why Ladder does not download this entry: the host's code, or what is inferred from the data (a missing checksum is `no-checksum`). */
export function blockOf(entry: AgentCatalogEntry): AgentBlockCode | null {
  if (entry.reasonCode) return entry.reasonCode
  if (entry.download?.blocked) return entry.download.blocked
  if (entry.download?.checksum === 'missing' && entry.state === 'unavailable') return 'no-checksum'
  // Without a known checksum (and without a declared block) there is no confirmation: we say it is not readable right now.
  if (entry.download && entry.download.sha256 === null) return entry.download.checksum === 'missing' ? 'no-checksum' : 'checksum-unavailable'
  return null
}

/** Installation outcomes that no new read changes: no "Try again" and the catalog is not stale. */
export function isFinalFailure(code: AgentBlockCode | null): boolean {
  return code === 'signature' || code === 'team' || code === 'quarantine' || code === 'too-large'
}

/** Like `isFinalFailure`, plus the checksum conflict: a warning that a new read does not clear (only a new registry version). */
export function isDefinitiveFailure(code: AgentBlockCode | null): boolean {
  return isFinalFailure(code) || code === 'checksum-conflict'
}

/**
 * An installation error with a code that the reread catalog has superseded: the registry version is different (the error concerns the old one),
 * or the code is not final (e.g. a transient 404 = `no-checksum`, a changed redirect = `host`)
 * and the entry now has no blocks. For a non-final code the row offers "Try again"; for a final one, as long as the version is the same, the note stays.
 * The caller decides when to apply it: the list only after a manual read (or with a changed version), the row to offer "Try again" right away.
 * `checksum-changed` and errors without a code stay: they already have their "Try again" and the confirmation reopening.
 */
export function supersededError(install: AgentInstall, entry: AgentCatalogEntry): boolean {
  if (install.state !== 'error' || !install.errorCode || install.errorCode === 'checksum-changed') return false
  if (install.version !== entry.registryVersion) return true
  return !isDefinitiveFailure(install.errorCode) && blockOf(entry) === null
}

/** Short title of the block (the line read first). */
export function blockTitle(code: AgentBlockCode): string {
  switch (code) {
    case 'no-checksum':
      return t('Install from the official site')
    case 'checksum-unavailable':
      return t('Checksum not available now')
    case 'host':
      return t('Download address not expected')
    case 'checksum-conflict':
      return t('The checksum of this version has changed')
    case 'too-large':
      return t('Download too large')
    case 'signature':
      return t('The signature does not hold')
    case 'team':
      return t('Not signed by the developer Ladder expects')
    case 'checksum-changed':
      return t('The download changed after you checked it')
    default:
      return t('macOS put the download in quarantine')
  }
}

/** Plain explanation of the block: describes what happened, never says that something is "safe". */
export function blockText(code: AgentBlockCode, name: string): string {
  switch (code) {
    case 'no-checksum':
      return t('{name} has no checksum Ladder can verify, so Ladder does not download it.', { name })
    case 'checksum-unavailable':
      return t('Ladder cannot read the checksum of {name} right now. Try again later.', { name })
    case 'host':
      return t('The archive of {name} is not on the address Ladder expects for it (not https, another domain, or a redirect elsewhere), so Ladder does not download it.', { name })
    case 'checksum-conflict':
      return t('Ladder already downloaded this version of {name} with a different checksum. The same version now comes with another one, so Ladder did not download it. Do not install it until the vendor explains the change.', { name })
    case 'too-large':
      return t('The download of {name} is larger than Ladder allows (600 MiB archive, 2 GiB unpacked), so Ladder does not download it.', { name })
    case 'signature':
      return t('The program of {name} is signed, but its signature does not hold, so Ladder did not install it.', { name })
    case 'team':
      return t('Ladder expects {name} to be signed by its official developer, and this download is not, so Ladder did not install it.', { name })
    case 'checksum-changed':
      return t('The registry changed this download after you checked it, so Ladder did not install it.')
    default:
      return t('macOS put the file of {name} in quarantine, so it would not start. Ladder does not remove the quarantine.', { name })
  }
}

/** Signature of the installed binary, as a state only: who signed it, or that it is unknown. */
export function signatureText(signature: AgentSignature): string {
  if (signature.state === 'signed') {
    const who = signature.signer ?? (signature.team ? t('team {team}', { team: signature.team }) : null)
    return who ? t('Signed by {signer}', { signer: who }) : t('Signed, signer not read')
  }
  if (signature.state === 'unverified') return t('Signature intact, signer not verified')
  return signature.state === 'adhoc' ? t('Ad hoc signature, signer unknown') : t('Not signed')
}

/** Archive size for the confirmation; null if the host could not determine it. */
export function sizeLabel(size: number | null): string {
  return size === null ? t('Unknown') : formatBinaryBytes(size, localeTag())
}

/** Bytes in binary units with their label (KiB, MiB, GiB), like the limits of the "too large" block (600 MiB). */
export function formatBinaryBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  const digits = (value: number, unit: number) => (unit === 0 || value >= 10 ? 0 : 1)
  let value = bytes
  let unit = 0
  // Move up a unit also when the ROUNDED value reaches 1024 (1048575 B is "1 MiB", not "1.024 KiB").
  while (unit < units.length - 1 && Number(value.toFixed(digits(value, unit))) >= 1024) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits(value, unit) }).format(value)} ${units[unit]}`
}

/** "a1b2c3d4 … 9f8e7d6c": enough to recognize it, the rest can be expanded. */
export function shortChecksum(sha256: string): string {
  return sha256.length > 20 ? `${sha256.slice(0, 8)} … ${sha256.slice(-8)}` : sha256
}

/** The whole checksum in groups of 8, to read and compare it piece by piece. */
export function groupedChecksum(sha256: string): string {
  return sha256.replace(/(.{8})(?=.)/g, '$1 ')
}
