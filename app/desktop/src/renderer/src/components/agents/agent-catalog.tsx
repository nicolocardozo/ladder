// "Aggiungi un agente" (Impostazioni → Agenti): il catalogo ACP con i curati in cima, poi il resto del registro.
// Ogni voce dice cosa è (rilevata, scaricabile, non disponibile e perché), lo stato del login e dove leggere la procedura.
// Un binario si scarica solo dopo una conferma che mostra nome, versione, host, dimensione e checksum; niente si aggiorna da solo.
// Le voci che Ladder non scarica dicono perché e rimandano alla procedura del vendor. La firma si mostra dopo l'installazione.
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { Check, ChevronRight, CircleAlert, CircleDashed, CircleHelp, Download, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import type { AgentBlockCode, AgentCatalogEntry, AgentInstall, AgentLogin } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { BlockNotice, ChecksumField, ExternalLinkButton, LoginPanel, SignatureLine, UpdateNote } from '@/components/agents/agent-parts'
import { DownloadBar } from '@/components/connections/connection-row'
import { Button } from '@/components/ui/button'
import { blockOf, checksumLabel, formatBinaryBytes, isDefinitiveFailure, isFinalFailure, sizeLabel, supersededError, useAgentCatalog, type AgentCatalogActions } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** La conferma si offre SOLO con un checksum noto e nessun blocco: senza, `agents.install` non esiste. */
function confirmable(entry: AgentCatalogEntry): boolean {
  return entry.download !== null && entry.download.sha256 !== null && entry.download.blocked === null && blockOf(entry) === null
}

/** Si scarica con una conferma solo un binario con checksum noto e non bloccato: altrimenti la voce resta visibile col motivo. */
function isDownload(entry: AgentCatalogEntry): boolean {
  return entry.state === 'downloadable' && entry.distribution === 'binary' && confirmable(entry)
}

/** Gli agenti scaricati contano in KiB/MiB/GiB, come la conferma e i limiti; i collegamenti restano in MB decimali. */
const binaryBytes = (bytes: number): string => formatBinaryBytes(bytes, localeTag())

function stageLabel(entry: AgentCatalogEntry, install: AgentInstall): string {
  switch (install.stage) {
    case 'downloading':
      return t('Downloading {tool}…', { tool: entry.name })
    case 'verifying':
      return t('Verifying the download…')
    case 'installing':
      return t('Installing…')
    case 'finishing':
      return t('Finishing…')
    default:
      return t('Starting…')
  }
}

/** Stato in una parola, con forma oltre al colore (come "Connected" dei collegamenti). */
function StateLabel({ entry }: { entry: AgentCatalogEntry }) {
  if (entry.added)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check aria-hidden className="size-3" />
        {t('Added')}
      </span>
    )
  if (entry.state === 'detected')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check aria-hidden className="size-3" />
        {entry.detected ? t('Found on your Mac') : t('Installed by Ladder')}
      </span>
    )
  if (entry.state === 'downloadable')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CircleDashed aria-hidden className="size-3" />
        {isDownload(entry) ? t('Available to download') : t('Not installed')}
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleAlert aria-hidden className="size-3" />
      {t('Not available')}
    </span>
  )
}

/** Login secondo ciò che il protocollo ha detto: "unknown" non è "non collegato". */
function LoginLine({ entry }: { entry: AgentCatalogEntry }) {
  const { state, methods } = entry.login
  if (state === 'ready')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Check aria-hidden className="size-3" />
        {t('Signed in')}
      </span>
    )
  if (state === 'required') {
    const names = methods.map((m) => m.name).filter(Boolean)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <KeyRound aria-hidden className="size-3" />
        {names.length && !entry.added ? t('Sign-in required: {methods}', { methods: names.join(', ') }) : t('Sign-in required')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleHelp aria-hidden className="size-3" />
      {t('Sign-in not checked yet')}
    </span>
  )
}

/** Dove sta l'agente o come parte, in 12 px tenue. */
function whereLine(entry: AgentCatalogEntry): string | null {
  if (entry.detected) return [entry.detected.path, entry.detected.version ? `v${entry.detected.version}` : null].filter(Boolean).join(' · ')
  if (entry.installed) return t('Downloaded by Ladder · v{version}', { version: entry.installed.version })
  if (isDownload(entry)) return t('Binary from {host} · v{version}', { host: entry.download!.host, version: entry.registryVersion })
  if (entry.state === 'downloadable' && entry.distribution !== 'binary') return entry.distribution === 'uvx' ? t('Starts with uvx on first use') : t('Starts with npx on first use')
  return null
}

type Confirm = 'download' | 'update' | null
/** Dopo un rifiuto dell'host per versione o checksum cambiati: la riga riapre la conferma con i dati nuovi. Una per agente, così due rifiuti vicini non si cancellano. */
export type Reviews = Record<string, 'download' | 'update'>

interface RowProps {
  entry: AgentCatalogEntry
  actions: AgentCatalogActions
  projectId?: string
  reviews: Reviews
  /** La riga ha preso in carico la conferma pendente (o è stata scartata): si toglie dalla mappa alla prima lettura. */
  onReviewed: (id: string) => void
  /** Rilegge il catalogo (per "Try again" quando il checksum non è leggibile ora). */
  onRefresh: () => void
  loading: boolean
  /** Agenti la cui rilettura dopo un rifiuto è in corso: il testo grezzo dell'errore aspetta l'esito invece di lampeggiare. */
  checking: ReadonlySet<string>
  onInstall: (entry: AgentCatalogEntry) => void
  onAdded: (id: string) => void
  onLogin: (id: string, login: AgentLogin) => void
}

function CatalogRow({ entry, actions, projectId, reviews, onReviewed, onRefresh, loading, checking, onInstall, onAdded, onLogin }: RowProps) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reopened, setReopened] = useState(false)
  /** Ciò che la conferma mostrava all'apertura: se la rilettura lo cambia a conferma aperta, l'utente lo vede detto. */
  const [openedWith, setOpenedWith] = useState<{ version: string; sha256: string | null; host: string } | null>(null)
  /** Una conferma riaperta da sola in una riga dove il focus non c'era: si annuncia, il focus resta dov'è. */
  const [announce, setAnnounce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const cancelConfirm = useRef<HTMLButtonElement>(null)
  /** Bottone che ha aperto la conferma: il focus ci torna alla chiusura. */
  const opener = useRef<HTMLElement | null>(null)
  const focusInside = useRef(false)
  /** La conferma che si apre porta il focus su Cancel solo se l'utente è già nella riga (o ha cliccato l'opener): mai se la riga è appena comparsa. */
  const moveFocus = useRef(false)
  const restoreFocus = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const install = entry.install
  const blocked = blockOf(entry)
  const running = install?.state === 'running'
  const failed = install?.state === 'error'
  const cancelled = install?.state === 'cancelled'
  const done = install?.state === 'done'
  // Senza dati di download non c'è riquadro di conferma: niente Update.
  const canConfirm = confirmable(entry)
  const update = entry.installed?.updateAvailable === true && canConfirm
  const download = isDownload(entry)
  const showLogin = entry.state !== 'unavailable' && (entry.login.state !== 'unknown' || entry.curated || entry.added)
  // Un blocco di sicurezza dell'installazione (firma, team, quarantena, conflitto…) non si risolve riprovando; si ripete `checksum-changed` (con i dati riletti)
  // e un errore che il catalogo ha superato (codice non definitivo e voce senza blocchi): un 404 momentaneo non lascia la riga senza bottone.
  const failCode: AgentBlockCode | null = failed ? (install?.errorCode ?? null) : null
  const finalFail = isFinalFailure(failCode)
  const retryable = failCode === null || failCode === 'checksum-changed' || (install !== null && supersededError(install, entry))
  // Una CLI già trovata sul Mac si usa lo stesso: il blocco riguarda solo il download. Se la rilettura dà un blocco, vale quello, non l'errore vecchio.
  const showBlock = blocked !== null && entry.state !== 'detected' && !finalFail
  // Aggiornamento disponibile ma checksum non leggibile ora: senza checksum non c'è conferma, quindi una nota con "Try again".
  const updateNote = entry.installed?.updateAvailable === true && !canConfirm && blocked === 'checksum-unavailable' && !running && !failed && !done
  const signature = !failed ? (install?.signature ?? entry.installed?.signature ?? null) : null
  const needsLogin = entry.added && entry.login.state === 'required'

  // Se la rilettura toglie il checksum o mette un blocco, la conferma non può restare aperta.
  useEffect(() => {
    if (confirm && !canConfirm) {
      restoreFocus.current = true
      setReopened(false)
      setOpenedWith(null)
      setAnnounce(false)
      setConfirm(null)
    }
  }, [confirm, canConfirm])

  useEffect(() => {
    if (confirm) {
      if (moveFocus.current) cancelConfirm.current?.focus()
      moveFocus.current = false
      return
    }
    // Il bottone d'apertura è disabilitato finché la conferma è aperta: il focus ci torna solo dopo il render, quando è di nuovo attivo.
    if (!restoreFocus.current) return
    restoreFocus.current = false
    const back = opener.current
    opener.current = null
    const target = back?.isConnected && !(back as HTMLButtonElement).disabled ? back : (root.current?.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? root.current)
    target?.focus()
  }, [confirm])

  // Il bottone su cui stava il focus cambia (Scarica → Annulla → niente): il focus passa all'azione che subentra, o alla riga.
  const action = running
    ? 'cancel'
    : failed
      ? !retryable || !canConfirm
        ? 'none'
        : 'retry'
      : done
        ? 'none'
        : update
          ? 'update'
          : entry.added
            ? 'added'
            : download
              ? 'download'
              : entry.state === 'unavailable' || showBlock
                ? 'none'
                : 'add'
  useEffect(() => {
    if (!focusInside.current) return
    const active = document.activeElement
    if (active && active !== document.body && root.current?.contains(active) && !(active as HTMLButtonElement).disabled) return
    if (active && active !== document.body && !root.current?.contains(active)) {
      focusInside.current = false
      return
    }
    const next = root.current?.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? root.current
    next?.focus()
  }, [action, busy, entry.login.state])

  const pendingReview = reviews[entry.id]
  // L'host ha rifiutato perché versione o checksum sono cambiati: la conferma si riapre con i dati nuovi.
  useEffect(() => {
    if (!pendingReview) return
    opener.current = null
    // Una riga appena montata (ricerca, gruppo che si apre) non ha il focus: la conferma si annuncia e il campo di ricerca continua a ricevere ciò che si scrive.
    const inside = focusInside.current || (root.current?.contains(document.activeElement) ?? false)
    moveFocus.current = inside
    setAnnounce(!inside)
    setProblem(null)
    setReopened(true)
    setOpenedWith(null)
    setConfirm(pendingReview)
    onReviewed(entry.id)
  }, [pendingReview, entry.id, onReviewed])

  function openConfirm(kind: Exclude<Confirm, null>, e: MouseEvent<HTMLElement>): void {
    opener.current = e.currentTarget
    moveFocus.current = true
    setAnnounce(false)
    setProblem(null)
    setReopened(false)
    setOpenedWith({ version: entry.registryVersion, sha256: entry.download?.sha256 ?? null, host: entry.download?.host ?? '' })
    setConfirm(kind)
  }
  function closeConfirm(): void {
    restoreFocus.current = true
    setReopened(false)
    setAnnounce(false)
    setOpenedWith(null)
    setConfirm(null)
  }
  function onBlurRow(e: FocusEvent<HTMLDivElement>): void {
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInside.current = false
  }
  function add(): void {
    setBusy(true)
    setProblem(null)
    actions
      .add(entry)
      .then(() => onAdded(entry.id))
      .catch((e: Error) => mounted.current && setProblem(e.message))
      .finally(() => mounted.current && setBusy(false))
  }
  function confirmed(): void {
    setConfirm(null)
    setReopened(false)
    setAnnounce(false)
    setOpenedWith(null)
    opener.current = null
    onInstall(entry)
  }

  const changedWhileOpen = openedWith !== null && entry.download !== null && (openedWith.version !== entry.registryVersion || openedWith.sha256 !== entry.download.sha256 || openedWith.host !== entry.download.host)
  const where = whereLine(entry)
  const name = entry.name
  const label =
    action === 'download'
      ? t('Download and add')
      : action === 'update'
        ? t('Update')
        : t('Add')

  return (
    <div ref={root} tabIndex={-1} data-agent={entry.id} className="flex items-start gap-3 px-4 py-3.5 outline-none" onFocusCapture={() => (focusInside.current = true)} onBlurCapture={onBlurRow}>
      <AgentMark agent={`acp:${entry.id}`} title={name} size={18} className="mt-0.5 text-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{name}</span>
          <StateLabel entry={entry} />
          {update && entry.installed && (
            <span className="rounded border border-border px-1 text-xs text-muted-foreground">{t('Update to v{version}', { version: entry.registryVersion })}</span>
          )}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        {entry.state === 'unavailable' && entry.reason && !showBlock && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
        {updateNote && entry.installed && <UpdateNote name={name} version={entry.registryVersion} onRetry={onRefresh} retrying={loading} />}
        {showBlock && blocked && <BlockNotice code={blocked} name={name} installUrl={entry.installUrl} onRetry={onRefresh} retrying={loading} />}
        {where && !running && <p title={where} className="truncate font-mono text-xs text-faint">{where}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {showLogin && <LoginLine entry={entry} />}
          {signature && <SignatureLine signature={signature} />}
          {entry.docsUrl && !(showBlock && entry.docsUrl === entry.installUrl) && (
            <ExternalLinkButton url={entry.docsUrl} label={t('Setup guide')} aria={t('Setup guide for {name}, opens in your browser', { name })} />
          )}
        </div>
        {needsLogin && <LoginPanel entry={entry} actions={actions} projectId={projectId} onLogin={onLogin} />}
        {running && install && (
          <div className="flex flex-col gap-2">
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              {stageLabel(entry, install)}
            </p>
            {install.stage === 'downloading' && <DownloadBar login={install} format={binaryBytes} />}
          </div>
        )}
        {failCode && !showBlock && <BlockNotice code={failCode} name={name} installUrl={entry.installUrl} announce onRetry={onRefresh} retrying={loading} />}
        {failed && !failCode && !showBlock && !checking.has(entry.id) && !(confirm && canConfirm) && install?.error && (
          <p role="alert" className="text-xs text-destructive">
            {install.error}
          </p>
        )}
        {cancelled && <p role="status" className="text-xs text-muted-foreground">{t('Download cancelled.')}</p>}
        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
        {confirm && canConfirm && entry.download && entry.download.sha256 && (
          <div
            role="group"
            aria-label={confirm === 'update' ? t('Confirm update of {name}', { name }) : t('Confirm download of {name}', { name })}
            className="flex flex-col gap-2 rounded-md bg-muted p-3"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              closeConfirm()
            }}
          >
            <p role="status" className="sr-only">
              {announce ? t('A confirmation for {name} is open. Check the details before you confirm.', { name }) : ''}
            </p>
            <p className="text-xs font-medium">
              {confirm === 'update' && entry.installed
                ? t('Update {name} from v{from} to v{to}?', { name, from: entry.installed.version, to: entry.registryVersion })
                : t('Download {name} v{version}?', { name, version: entry.registryVersion })}
            </p>
            {(reopened || changedWhileOpen) && (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-attention">
                <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                {t('The registry now lists different details than the ones you saw. Check them again before you confirm.')}
              </p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t('Version')}</dt>
              <dd className="tabular-nums">v{entry.registryVersion}</dd>
              <dt className="text-muted-foreground">{t('Downloads from')}</dt>
              <dd className="min-w-0 break-all font-mono">{entry.download.host}</dd>
              <dt className="text-muted-foreground">{t('Size')}</dt>
              <dd className="tabular-nums">{sizeLabel(entry.download.size)}</dd>
              <dt className="text-muted-foreground">{t('Checksum (SHA-256)')}</dt>
              <dd className="min-w-0">
                <ChecksumField sha256={entry.download.sha256} />
              </dd>
              <dt className="text-muted-foreground">{t('Checksum from')}</dt>
              <dd>{checksumLabel(entry.download.checksum)}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">{t('Ladder checks the checksum before it can start the agent, and never updates it on its own.')}</p>
            <p className="text-xs text-muted-foreground">{t('Who signed the program is checked after the download, and Ladder shows it when it is done.')}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="text-sm" onClick={confirmed}>
                {confirm === 'update' ? t('Update') : t('Download and add')}
              </Button>
              <Button ref={cancelConfirm} variant="ghost" size="sm" className="text-sm" onClick={closeConfirm}>
                {t('Cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action === 'cancel' && (
          <Button data-primary variant="ghost" size="sm" className="text-sm" aria-label={t('Cancel the download of {name}', { name })} onClick={() => void actions.cancel(entry.id)}>
            {t('Cancel')}
          </Button>
        )}
        {action === 'retry' && (
          <Button data-primary variant="outline" size="sm" className="text-sm" disabled={confirm !== null && canConfirm} aria-disabled={loading} aria-label={t('Try downloading {name} again', { name })} onClick={(e) => !loading && openConfirm(update ? 'update' : 'download', e)}>
            {t('Try again')}
          </Button>
        )}
        {(action === 'update' || action === 'download') && (
          <Button data-primary variant="outline" size="sm" className="text-sm" disabled={confirm !== null && canConfirm} aria-label={action === 'update' ? t('Update {name}', { name }) : t('Download and add {name}', { name })} onClick={(e) => openConfirm(action, e)}>
            {action === 'download' && <Download aria-hidden />}
            {label}
          </Button>
        )}
        {action === 'add' && (
          <Button data-primary variant="outline" size="sm" className="text-sm" disabled={busy} aria-label={t('Add {name}', { name })} onClick={add}>
            {busy ? t('Adding…') : label}
          </Button>
        )}
      </div>
    </div>
  )
}

function matches(entry: AgentCatalogEntry, tokens: string[]): boolean {
  const hay = `${entry.name} ${entry.id} ${entry.description}`.toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

function RowList({ entries, label, ...row }: { entries: AgentCatalogEntry[]; label: string } & Omit<RowProps, 'entry'>) {
  return (
    <div role="list" aria-label={label} className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {entries.map((entry) => (
        <div key={entry.id} role="listitem">
          <CatalogRow entry={entry} {...row} />
        </div>
      ))}
    </div>
  )
}

export function AgentCatalog({ actions }: { actions: AgentCatalogActions }) {
  const { entries, loading, error, reload, setLogin, patch, setInstall, setInstallIfCurrent } = useAgentCatalog(actions)
  const projectId = useApp((s) => ('projectId' in s.selection ? (s.selection.projectId ?? undefined) : undefined))
  const [reviews, setReviews] = useState<Reviews>({})
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [more, setMore] = useState(false)

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = tokens.length > 0
  const { curated, rest } = useMemo(() => {
    const shown = (entries ?? []).filter((entry) => matches(entry, tokens))
    return { curated: shown.filter((e) => e.curated), rest: shown.filter((e) => !e.curated) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens deriva da query
  }, [entries, query])

  /** Ciò che l'utente ha confermato per ogni agente, da confrontare con la rilettura dopo un rifiuto. */
  const confirmedRef = useRef(new Map<string, { version: string; sha256: string | null; host: string | null; kind: 'download' | 'update' }>())

  /**
   * Il catalogo può essere obsoleto (versione, checksum o host cambiati dopo la conferma): si rilegge e, se la voce è ancora
   * confermabile con dati diversi (o l'host dice `checksum-changed`), la conferma si riapre con i dati nuovi. Mai con quelli vecchi.
   * Se non è più confermabile, la riga mostra la nota di blocco giusta.
   */
  const reviewAfterRefusal = useCallback(
    (id: string, code: AgentBlockCode | null) => {
      setChecking((set) => new Set(set).add(id))
      reload((list) => {
        const seen = confirmedRef.current.get(id)
        if (!seen) return
        const fresh = list.find((item) => item.id === id)
        if (!fresh || !confirmable(fresh) || fresh.state === 'unavailable') return
        const changed = fresh.registryVersion !== seen.version || fresh.download!.sha256 !== seen.sha256 || fresh.download!.host !== seen.host
        if (!changed && code !== 'checksum-changed') return
        confirmedRef.current.delete(id)
        setReviews((map) => ({ ...map, [id]: seen.kind }))
      })
    },
    [reload]
  )

  // La rilettura che segue un rifiuto è finita (bene o male): l'errore grezzo può tornare a vedersi, se la riga lo mostra ancora.
  useEffect(() => {
    if (!loading) setChecking((set) => (set.size === 0 ? set : new Set()))
  }, [loading])

  // Un errore dell'host per un'installazione che abbiamo confermato (o per checksum/host cambiati) rilegge il catalogo e applica la stessa logica del rifiuto.
  useEffect(
    () =>
      actions.onInstall((install) => {
        if (install.state === 'done') confirmedRef.current.delete(install.id)
        if (install.state !== 'error' || isDefinitiveFailure(install.errorCode)) return
        if (confirmedRef.current.has(install.id) || install.errorCode === 'checksum-changed' || install.errorCode === 'host') reviewAfterRefusal(install.id, install.errorCode)
      }),
    [actions, reviewAfterRefusal]
  )

  /** Dopo la conferma: parte in locale, poi gli eventi `agent.install` portano i passi. Un rifiuto dell'host (registro cambiato, niente checksum) resta come errore anche dopo la rilettura. */
  function startInstall(entry: AgentCatalogEntry): void {
    const base = { id: entry.id, version: entry.registryVersion, stage: null, progress: null, bytes: null, total: null, errorCode: null, signature: null }
    const seq = setInstall({ ...base, state: 'running', error: null })
    const kind = entry.installed?.updateAvailable ? 'update' : 'download'
    confirmedRef.current.set(entry.id, { version: entry.registryVersion, sha256: entry.download?.sha256 ?? null, host: entry.download?.host ?? null, kind })
    actions
      .install(entry)
      .then((started) => started && setInstallIfCurrent(started, seq))
      .catch((e: Error) => {
        // Il contratto porta nel rifiuto solo il messaggio: il codice arriva con l'evento `agent.install`, che parte PRIMA del rifiuto e lo ha già registrato
        // (questa risposta, meno recente, non lo sovrascrive). Se l'evento non c'è stato resta l'errore senza codice.
        setInstallIfCurrent({ ...base, state: 'error', error: e.message, errorCode: null }, seq)
        // Se versione, checksum o host sono cambiati la conferma si riapre con i dati nuovi: l'utente non conferma mai ciò che non ha visto.
        reviewAfterRefusal(entry.id, null)
      })
  }
  const added = (id: string) => patch(id, { added: true })
  const clearReview = useCallback(
    (id: string) =>
      setReviews((map) => {
        if (!(id in map)) return map
        const { [id]: _taken, ...rest } = map
        return rest
      }),
    []
  )
  // Una conferma pendente per una riga del gruppo chiuso apre il gruppo: la riga si monta e la prende in carico subito, mai in ritardo.
  // Se la ricerca la nasconde resta in attesa finché la riga non compare (i dati si leggono da `entry` all'apertura, quindi sono freschi).
  useEffect(() => {
    if (!more && rest.some((entry) => entry.id in reviews)) setMore(true)
  }, [reviews, rest, more])
  const refresh = useCallback(() => reload(undefined, { manual: true }), [reload])
  const rows = { actions, projectId, reviews, onReviewed: clearReview, onRefresh: refresh, loading, checking, onInstall: startInstall, onAdded: added, onLogin: setLogin }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={t('Add an agent')}>
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search: gemini, opencode, goose…')}
          aria-label={t('Search the ACP registry')}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button variant="ghost" size="sm" className="text-sm" disabled={loading} aria-label={t('Scan for installed agents again')} onClick={refresh}>
          <RefreshCw aria-hidden className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
          {t('Rescan')}
        </Button>
      </div>

      {!entries && loading && (
        <p role="status" className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t('Looking for agents on your Mac and reading the registry…')}
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="text-sm" onClick={refresh}>
            {t('Try again')}
          </Button>
        </div>
      )}

      {entries && curated.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="px-1 text-xs font-semibold text-muted-foreground">{t('Most used')}</h4>
          <RowList entries={curated} label={t('Most used')} {...rows} />
        </div>
      )}
      {entries && rest.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={more || searching}
            disabled={searching}
            onClick={() => setMore((v) => !v)}
            className="flex w-fit items-center gap-1 rounded-sm px-1 text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:text-muted-foreground"
          >
            <ChevronRight aria-hidden className={cn('size-3 transition-transform motion-reduce:transition-none', (more || searching) && 'rotate-90')} />
            {t('More from the ACP registry · {n}', { n: rest.length })}
          </button>
          {(more || searching) && <RowList entries={rest} label={t('More from the ACP registry')} {...rows} />}
        </div>
      )}
      {entries && curated.length + rest.length === 0 && (
        <p className="px-1 py-3 text-sm text-muted-foreground">{searching ? t('No agent matches “{query}”.', { query: query.trim() }) : t('The registry has no agents for this Mac.')}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('The agent handles its own login. Binaries are only downloaded after you confirm, and are never updated on their own.')}</p>
    </section>
  )
}
