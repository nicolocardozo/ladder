// "Add an agent" (Settings → Agents): the ACP catalog with the curated ones on top, then the rest of the registry.
// Each entry says what it is (detected, downloadable, unavailable and why), the login state and where to read the procedure.
// A binary is downloaded only after a confirmation that shows name, version, host, size and checksum; nothing updates by itself.
// Entries Ladder does not download say why and point to the vendor's procedure. The signature is shown after installation.
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

/** Confirmation is offered ONLY with a known checksum and no block: without it, `agents.install` does not exist. */
function confirmable(entry: AgentCatalogEntry): boolean {
  return entry.download !== null && entry.download.sha256 !== null && entry.download.blocked === null && blockOf(entry) === null
}

/** Only a binary with a known checksum and not blocked is downloaded after a confirmation: otherwise the entry stays visible with the reason. */
function isDownload(entry: AgentCatalogEntry): boolean {
  return entry.state === 'downloadable' && entry.distribution === 'binary' && confirmable(entry)
}

/** Downloaded agents are counted in KiB/MiB/GiB, like the confirmation and the limits; links stay in decimal MB. */
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

/** State in one word, with a shape beyond color (like "Connected" for links). */
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

/** Login according to what the protocol said: "unknown" is not "not connected". */
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

/** Where the agent is or how it starts, in muted 12 px. */
function whereLine(entry: AgentCatalogEntry): string | null {
  if (entry.detected) return [entry.detected.path, entry.detected.version ? `v${entry.detected.version}` : null].filter(Boolean).join(' · ')
  if (entry.installed) return t('Downloaded by Ladder · v{version}', { version: entry.installed.version })
  if (isDownload(entry)) return t('Binary from {host} · v{version}', { host: entry.download!.host, version: entry.registryVersion })
  if (entry.state === 'downloadable' && entry.distribution !== 'binary') return entry.distribution === 'uvx' ? t('Starts with uvx on first use') : t('Starts with npx on first use')
  return null
}

type Confirm = 'download' | 'update' | null
/** After a host rejection because version or checksum changed: the row reopens the confirmation with the new data. One per agent, so two nearby rejections do not cancel each other. */
export type Reviews = Record<string, 'download' | 'update'>

interface RowProps {
  entry: AgentCatalogEntry
  actions: AgentCatalogActions
  projectId?: string
  reviews: Reviews
  /** The row has taken over the pending confirmation (or it was discarded): it is removed from the map on first read. */
  onReviewed: (id: string) => void
  /** Re-reads the catalog (for "Try again" when the checksum is not readable now). */
  onRefresh: () => void
  loading: boolean
  /** Agents whose re-read after a rejection is in progress: the raw error text waits for the outcome instead of flashing. */
  checking: ReadonlySet<string>
  onInstall: (entry: AgentCatalogEntry) => void
  onAdded: (id: string) => void
  onLogin: (id: string, login: AgentLogin) => void
}

function CatalogRow({ entry, actions, projectId, reviews, onReviewed, onRefresh, loading, checking, onInstall, onAdded, onLogin }: RowProps) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reopened, setReopened] = useState(false)
  /** What the confirmation showed when it opened: if the re-read changes it while the confirmation is open, the user sees it stated. */
  const [openedWith, setOpenedWith] = useState<{ version: string; sha256: string | null; host: string } | null>(null)
  /** A confirmation reopened on its own in a row that did not have focus: it is announced, focus stays where it is. */
  const [announce, setAnnounce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const cancelConfirm = useRef<HTMLButtonElement>(null)
  /** Button that opened the confirmation: focus returns to it on close. */
  const opener = useRef<HTMLElement | null>(null)
  const focusInside = useRef(false)
  /** The confirmation that opens puts focus on Cancel only if the user is already in the row (or clicked the opener): never if the row just appeared. */
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
  // Without download data there is no confirmation panel: no Update.
  const canConfirm = confirmable(entry)
  const update = entry.installed?.updateAvailable === true && canConfirm
  const download = isDownload(entry)
  const showLogin = entry.state !== 'unavailable' && (entry.login.state !== 'unknown' || entry.curated || entry.added)
  // A security block on installation (signature, team, quarantine, conflict…) is not solved by retrying; `checksum-changed` is repeated (with the re-read data)
  // and so is an error the catalog has moved past (non-final code and entry without blocks): a momentary 404 does not leave the row without a button.
  const failCode: AgentBlockCode | null = failed ? (install?.errorCode ?? null) : null
  const finalFail = isFinalFailure(failCode)
  const retryable = failCode === null || failCode === 'checksum-changed' || (install !== null && supersededError(install, entry))
  // A CLI already found on the Mac is used anyway: the block only concerns the download. If the re-read gives a block, that one applies, not the old error.
  const showBlock = blocked !== null && entry.state !== 'detected' && !finalFail
  // Update available but checksum not readable now: without a checksum there is no confirmation, so a note with "Try again".
  const updateNote = entry.installed?.updateAvailable === true && !canConfirm && blocked === 'checksum-unavailable' && !running && !failed && !done
  const signature = !failed ? (install?.signature ?? entry.installed?.signature ?? null) : null
  const needsLogin = entry.added && entry.login.state === 'required'

  // If the re-read removes the checksum or adds a block, the confirmation cannot stay open.
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
    // The opener button is disabled while the confirmation is open: focus returns to it only after the render, when it is active again.
    if (!restoreFocus.current) return
    restoreFocus.current = false
    const back = opener.current
    opener.current = null
    const target = back?.isConnected && !(back as HTMLButtonElement).disabled ? back : (root.current?.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? root.current)
    target?.focus()
  }, [confirm])

  // The button that had focus changes (Download → Cancel → nothing): focus moves to the action that takes over, or to the row.
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
  // The host rejected because version or checksum changed: the confirmation reopens with the new data.
  useEffect(() => {
    if (!pendingReview) return
    opener.current = null
    // A freshly mounted row (search, group that opens) does not have focus: the confirmation is announced and the search field keeps receiving what is typed.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens derives from query
  }, [entries, query])

  /** What the user confirmed for each agent, to compare with the re-read after a rejection. */
  const confirmedRef = useRef(new Map<string, { version: string; sha256: string | null; host: string | null; kind: 'download' | 'update' }>())

  /**
    * The catalog may be stale (version, checksum or host changed after the confirmation): it is re-read and, if the entry is still
    * confirmable with different data (or the host says `checksum-changed`), the confirmation reopens with the new data. Never with the old ones.
    * If it is no longer confirmable, the row shows the right block note.
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

  // The re-read that follows a rejection is over (well or badly): the raw error can be shown again, if the row still shows it.
  useEffect(() => {
    if (!loading) setChecking((set) => (set.size === 0 ? set : new Set()))
  }, [loading])

  // A host error for an installation we confirmed (or for changed checksum/host) re-reads the catalog and applies the same logic as the rejection.
  useEffect(
    () =>
      actions.onInstall((install) => {
        if (install.state === 'done') confirmedRef.current.delete(install.id)
        if (install.state !== 'error' || isDefinitiveFailure(install.errorCode)) return
        if (confirmedRef.current.has(install.id) || install.errorCode === 'checksum-changed' || install.errorCode === 'host') reviewAfterRefusal(install.id, install.errorCode)
      }),
    [actions, reviewAfterRefusal]
  )

  /** After the confirmation: starts locally, then `agent.install` events carry the steps. A host rejection (registry changed, no checksum) stays as an error even after the re-read. */
  function startInstall(entry: AgentCatalogEntry): void {
    const base = { id: entry.id, version: entry.registryVersion, stage: null, progress: null, bytes: null, total: null, errorCode: null, signature: null }
    const seq = setInstall({ ...base, state: 'running', error: null })
    const kind = entry.installed?.updateAvailable ? 'update' : 'download'
    confirmedRef.current.set(entry.id, { version: entry.registryVersion, sha256: entry.download?.sha256 ?? null, host: entry.download?.host ?? null, kind })
    actions
      .install(entry)
      .then((started) => started && setInstallIfCurrent(started, seq))
      .catch((e: Error) => {
        // The contract carries only the message in the rejection: the code arrives with the `agent.install` event, which fires BEFORE the rejection and has already recorded it
        // (this response, older, does not overwrite it). If the event did not occur the error stays without a code.
        setInstallIfCurrent({ ...base, state: 'error', error: e.message, errorCode: null }, seq)
        // If version, checksum or host changed the confirmation reopens with the new data: the user never confirms what they have not seen.
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
  // A pending confirmation for a row of the closed group opens the group: the row mounts and takes it over right away, never late.
  // If the search hides it, it waits until the row appears (the data is read from `entry` at open, so it is fresh).
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
      <p className="max-w-[62ch] text-xs text-muted-foreground">{t('The agent handles its own login. Binaries are only downloaded after you confirm, and are never updated on their own.')}</p>
    </section>
  )
}
