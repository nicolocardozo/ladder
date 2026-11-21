// Catalogo degli agenti ACP (LAD-56): comandi verso l'host e stato di una lista letta una volta.
// Il catalogo si chiede all'apertura di Impostazioni → Agenti (fa un giro della shell di login per CLI), mai a ogni render.
// L'installazione di un binario avanza con eventi `agent.install`: la lista li applica alla voce, e a fine corsa si rilegge.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentBlockCode, AgentCatalogEntry, AgentChecksumSource, AgentInstall, AgentLogin, AgentSignature } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { onHostEvent, request } from '@/lib/host-client'

/** Comandi del catalogo. Come `ConnectionActions`: la stessa lista vale per l'app e per l'anteprima web con un host finto. */
export interface AgentCatalogActions {
  catalog: () => Promise<AgentCatalogEntry[]>
  /** Solo le CLI già installate (primo avvio): più leggero del catalogo. */
  detect: () => Promise<AgentCatalogEntry[]>
  /** CLI rilevata, binario già scaricato o pacchetto npx/uvx: l'host sceglie la voce dal registro. */
  add: (entry: AgentCatalogEntry) => Promise<void>
  /** Chiamare solo dopo la conferma dell'utente (`confirmed: true`): versione fissata dal registro. */
  install: (entry: AgentCatalogEntry) => Promise<AgentInstall | void>
  /** Accesso con un metodo dichiarato dall'agente (solo `agent`): Ladder non vede mai le credenziali. Può durare minuti; risponde il login aggiornato. */
  authenticate: (id: string, methodId: string, projectId?: string) => Promise<AgentLogin>
  /** "Stop waiting": l'host ferma l'accesso in corso e libera l'id; la richiesta `authenticate` pendente risponde con il login com'era. */
  cancelAuthenticate: (id: string) => Promise<void>
  /** Cambi del login di un agente (id del registro); restituisce la funzione per smettere di ascoltare. */
  onLogin: (listener: (id: string, login: AgentLogin) => void) => () => void
  cancel: (id: string) => Promise<void>
  /** Passi dell'installazione; restituisce la funzione per smettere di ascoltare. */
  onInstall: (listener: (install: AgentInstall) => void) => () => void
  /** Un agente tolto da "I tuoi agenti" (id del registro, senza `acp:`); restituisce la funzione per smettere di ascoltare. */
  onRemoved: (listener: (id: string) => void) => () => void
}

export const liveAgentCatalogActions: AgentCatalogActions = {
  catalog: () => request<AgentCatalogEntry[]>({ type: 'agents.catalog' }),
  detect: () => request<AgentCatalogEntry[]>({ type: 'agents.detect' }),
  add: async (entry) => {
    // Per `source: 'registry'` l'host ricava comando e argomenti dalla voce del registro: conta solo l'id.
    await request({ type: 'agents.add', spec: { id: entry.id, name: entry.name, command: '', args: [], source: 'registry' } })
  },
  install: (entry) => {
    // Versione, checksum e host mostrati nella conferma viaggiano con il comando: se il registro ne dà un altro l'host rifiuta.
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
  /** null: non ancora letto. Le installazioni vengono dalla mappa degli eventi, non dalla risposta del catalogo. */
  entries: AgentCatalogEntry[] | null
  loading: boolean
  error: string | null
  /**
   * `onRead` riceve la lista letta dall'ultima lettura (anche se la sua è stata superata): serve a confrontarla con ciò che l'utente ha confermato.
   * `manual: true` per una lettura voluta dall'utente (Rescan, Try again): solo allora un errore non definitivo si considera superato
   * dalla voce senza blocchi. Una lettura nata dal rifiuto stesso, o da un altro evento, toglie un errore solo se la versione del registro è cambiata.
   */
  reload: (onRead?: (list: AgentCatalogEntry[]) => void, options?: { manual?: boolean }) => void
  /** Registra un login nuovo (evento o risposta di `authenticate`). */
  setLogin: (id: string, login: AgentLogin) => void
  /** Cambia una voce in locale (es. "aggiunta"). */
  patch: (id: string, change: Partial<AgentCatalogEntry>) => void
  /** Registra lo stato di un'installazione (evento, risposta o rifiuto del comando). Restituisce il numero d'ordine di arrivo. */
  setInstall: (install: AgentInstall) => number
  /** Applica la risposta di `agents.install` solo se nel frattempo non è arrivato niente di più recente (`seq` è quello di `setInstall`). */
  setInstallIfCurrent: (install: AgentInstall, seq: number) => void
}

type Tracked = { install: AgentInstall; seq: number }

/**
 * Legge il catalogo e tiene le installazioni allineate agli eventi dell'host.
 * Le installazioni stanno in una mappa a parte, nutrita solo da eventi e risposte di `agents.install`, in ordine di arrivo;
 * si sovrappone al risultato di `catalog()`, che può essere stato costruito prima di un evento più recente.
 */
export function useAgentCatalog(actions: AgentCatalogActions): CatalogState {
  const [list, setList] = useState<AgentCatalogEntry[] | null>(null)
  const [installs, setInstalls] = useState<Record<string, Tracked>>({})
  const [logins, setLogins] = useState<Record<string, AgentLogin>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Ordine delle risposte: una lettura vecchia non sovrascrive una più nuova.
  const reads = useRef(0)
  // Chi ha chiesto una lettura che poi è stata superata (es. un `done` di un'altra installazione) la riceve dalla lettura che vince: mai persa.
  const waiting = useRef<Array<(list: AgentCatalogEntry[]) => void>>([])
  // Una lettura manuale poi superata da una più nuova passa il suo carattere manuale a quella che vince.
  const manualRead = useRef(false)
  // Ordine d'arrivo degli stati di installazione.
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
        // Un `done` visto prima di questa lettura è ormai nel catalogo (aggiunto, versione); uno successivo resta finché non arriva la sua lettura.
        setInstalls((map) => {
          // Un "running" visto prima della lettura, che ora dice install: null, è finito o annullato senza evento.
          const absent = new Set(next.filter((entry) => entry.install === null).map((entry) => entry.id))
          const stale = Object.keys(map).filter((id) => {
            const { install, seq } = map[id]
            if (seq > startedAt) return false
            if (install.state === 'error') {
              // Un errore superato dal catalogo non resta fino al riavvio: con una versione nuova del registro sempre; per un codice non definitivo
              // (404 momentaneo, redirect) solo dopo una lettura manuale. Quella nata dal rifiuto non lo toglie: il catalogo non vede ciò che l'host ha visto al download.
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
        // Finita bene: stato, versione e "added" sono cambiati sull'host.
        if (install.state === 'done') reload()
      }),
    [actions, setInstall, reload]
  )

  const setLogin = useCallback((id: string, login: AgentLogin) => {
    setLogins((map) => (map[id] && (map[id].checkedAt ?? -1) > (login.checkedAt ?? -1) ? map : { ...map, [id]: login }))
  }, [])
  useEffect(() => actions.onLogin(setLogin), [actions, setLogin])

  // Agente tolto da "I tuoi agenti": la riga torna Add subito, poi la lettura conferma (copre anche una rimozione durante il download).
  useEffect(
    () =>
      actions.onRemoved((id) => {
        patch(id, { added: false })
        reload()
      }),
    [actions, patch, reload]
  )

  // Il login più recente vince, che arrivi da un evento, dalla risposta di `authenticate` o dalla lettura del catalogo.
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

/** Da dove viene il checksum, per la conferma prima del download. */
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

/** Link aperti solo se https, come fa il main (`ladder:open-external`); mai `window.open` con un URL qualunque. */
export function openSecure(url: string): void {
  // Come il main: URL analizzato (schema e host senza distinzione di maiuscole), solo https con un host.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname) return
  } catch {
    return
  }
  if (window.ladder) void window.ladder.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/** Perché Ladder non scarica questa voce: il codice dell'host, oppure ciò che si deduce dai dati (un checksum assente è `no-checksum`). */
export function blockOf(entry: AgentCatalogEntry): AgentBlockCode | null {
  if (entry.reasonCode) return entry.reasonCode
  if (entry.download?.blocked) return entry.download.blocked
  if (entry.download?.checksum === 'missing' && entry.state === 'unavailable') return 'no-checksum'
  // Senza checksum noto (e senza un blocco dichiarato) non c'è conferma: si dice che ora non è leggibile.
  if (entry.download && entry.download.sha256 === null) return entry.download.checksum === 'missing' ? 'no-checksum' : 'checksum-unavailable'
  return null
}

/** Esiti dell'installazione che nessuna nuova lettura cambia: niente "Try again" e il catalogo non è obsoleto. */
export function isFinalFailure(code: AgentBlockCode | null): boolean {
  return code === 'signature' || code === 'team' || code === 'quarantine' || code === 'too-large'
}

/** Come `isFinalFailure`, più il conflitto di checksum: un avviso che una nuova lettura non cancella (solo una versione nuova del registro). */
export function isDefinitiveFailure(code: AgentBlockCode | null): boolean {
  return isFinalFailure(code) || code === 'checksum-conflict'
}

/**
 * Un errore di installazione con codice che il catalogo riletto ha superato: la versione del registro è un'altra (l'errore riguarda quella vecchia),
 * oppure il codice non è definitivo (es. un 404 momentaneo = `no-checksum`, un redirect cambiato = `host`)
 * e la voce ora non ha blocchi. Per un codice non definitivo la riga offre "Try again"; per uno definitivo, finché la versione è la stessa, resta la nota.
 * Chi la usa decide quando applicarla: la lista solo dopo una lettura manuale (o con la versione cambiata), la riga per offrire "Try again" subito.
 * `checksum-changed` e gli errori senza codice restano: hanno già il loro "Try again" e la riapertura della conferma.
 */
export function supersededError(install: AgentInstall, entry: AgentCatalogEntry): boolean {
  if (install.state !== 'error' || !install.errorCode || install.errorCode === 'checksum-changed') return false
  if (install.version !== entry.registryVersion) return true
  return !isDefinitiveFailure(install.errorCode) && blockOf(entry) === null
}

/** Titolo breve del blocco (la riga che si legge per prima). */
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

/** Spiegazione del blocco, in chiaro: descrive cosa è successo, non dice mai che qualcosa è "sicuro". */
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

/** Firma del binario installato, solo come stato: chi l'ha firmato o che non si sa. */
export function signatureText(signature: AgentSignature): string {
  if (signature.state === 'signed') {
    const who = signature.signer ?? (signature.team ? t('team {team}', { team: signature.team }) : null)
    return who ? t('Signed by {signer}', { signer: who }) : t('Signed, signer not read')
  }
  if (signature.state === 'unverified') return t('Signature intact, signer not verified')
  return signature.state === 'adhoc' ? t('Ad hoc signature, signer unknown') : t('Not signed')
}

/** Dimensione dell'archivio per la conferma; null se l'host non l'ha saputa. */
export function sizeLabel(size: number | null): string {
  return size === null ? t('Unknown') : formatBinaryBytes(size, localeTag())
}

/** Byte in unità binarie con la loro etichetta (KiB, MiB, GiB), come i limiti del blocco "too large" (600 MiB). */
export function formatBinaryBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  const digits = (value: number, unit: number) => (unit === 0 || value >= 10 ? 0 : 1)
  let value = bytes
  let unit = 0
  // Si sale d'unità anche quando il valore ARROTONDATO arriva a 1024 (1048575 B è "1 MiB", non "1.024 KiB").
  while (unit < units.length - 1 && Number(value.toFixed(digits(value, unit))) >= 1024) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits(value, unit) }).format(value)} ${units[unit]}`
}

/** "a1b2c3d4 … 9f8e7d6c": abbastanza per riconoscerlo, il resto si apre. */
export function shortChecksum(sha256: string): string {
  return sha256.length > 20 ? `${sha256.slice(0, 8)} … ${sha256.slice(-8)}` : sha256
}

/** Il checksum intero in gruppi di 8, per leggerlo e confrontarlo a pezzi. */
export function groupedChecksum(sha256: string): string {
  return sha256.replace(/(.{8})(?=.)/g, '$1 ')
}
