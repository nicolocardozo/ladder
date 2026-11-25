// Una riga per collegamento (Claude, ChatGPT / Codex, GitHub): stato, account e piano, accesso con download in corso, annulla, esci.
// Presentazionale: lo stato e i comandi arrivano da fuori, così la stessa riga vale per Impostazioni, primo avvio e anteprima web.
import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { Check, CircleAlert, CircleDashed, Copy, ExternalLink, Loader2 } from 'lucide-react'
import githubIcon from '@lobehub/icons-static-svg/icons/github.svg?url'
import type { ConnectionId, ConnectionLogin, ConnectionStatus } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { agentIcon } from '@/components/agent-mark'
import { Button } from '@/components/ui/button'
import { CONNECTION_NAME, type ConnectionActions } from '@/lib/connections'
import { cn } from '@/lib/utils'

/**
 * Griglia di una riga (Impostazioni → Abbonamenti): segno, testo, limiti d'uso e bottoni. Con il pannello delle Impostazioni
 * (`@container` in settings-dialog.tsx) largo almeno 820 px i limiti stanno sulla stessa riga, prima dei bottoni; sotto, testo,
 * limiti e bottoni vanno uno sotto l'altro. Senza contenitore (primo avvio) la riga resta a due colonne con i bottoni a destra.
 */
export const ROW_GRID = 'grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 @[820px]:grid-cols-[18px_minmax(0,3fr)_minmax(240px,2fr)_auto]'
/** Come ROW_GRID, per le righe senza limiti d'uso (Altri agenti): due colonne a ogni larghezza, i bottoni restano a destra. */
export const ROW_GRID_PLAIN = 'grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5'
export const ROW_ACTIONS_PLAIN = 'col-start-3 flex shrink-0 items-center justify-end gap-1 @max-[819px]:col-start-2 @max-[819px]:justify-start'
/** I bottoni stanno all'ultima colonna, allineati al bordo destro; nel pannello stretto sotto il resto, a sinistra. */
export const ROW_ACTIONS = 'col-start-3 flex shrink-0 items-center justify-end gap-1 @max-[819px]:col-start-2 @max-[819px]:justify-start @[820px]:col-start-4 @[820px]:flex-col @[820px]:items-end'
/** Limiti d'uso: sotto il testo, o nella terza colonna. */
/** "Esci": ghost in rosso (il rosso di errore del tema), più deciso al passaggio. */
export const SIGN_OUT = 'text-sm text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/30'
export const ROW_USAGE = 'col-start-2 row-start-2 min-w-0 max-w-[420px] @[820px]:col-start-3 @[820px]:row-start-1'

/** Segno del servizio, decorativo: il nome sta accanto. */
function ServiceMark({ id }: { id: ConnectionId }) {
  const icon = id === 'github' ? githubIcon : agentIcon(id)
  const mask = icon ? `url("${icon}")` : undefined
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-block size-[18px] shrink-0 bg-current text-foreground"
      style={{ maskImage: mask, WebkitMaskImage: mask, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  )
}

/** Strumento che Ladder scarica, per "Scarico …". */
const TOOL: Record<ConnectionId, string> = { 'claude-code': 'Claude', codex: 'Codex', github: 'GitHub CLI' }

function purpose(id: ConnectionId): string {
  if (id === 'claude-code') return t('Runs Claude sessions with your Claude subscription.')
  if (id === 'codex') return t('Runs Codex sessions with your ChatGPT plan.')
  return t('Issues, pull requests and CI in “New session from…” and the Merge panel.')
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000
  return `${mb.toLocaleString(localeTag(), { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`
}

function stageLabel(id: ConnectionId, login: ConnectionLogin): string {
  switch (login.stage) {
    case 'downloading':
      return t('Downloading {tool}…', { tool: TOOL[id] })
    case 'verifying':
      return t('Verifying the download…')
    case 'installing':
      return t('Installing…')
    case 'waiting-browser':
      return t('Waiting for you to finish in the browser…')
    default:
      return t('Finishing…')
  }
}

function sourceLabel(source: NonNullable<ConnectionStatus['source']>): string {
  return source === 'system' ? t('Installed on your Mac') : source === 'bundled' ? t('Included with Ladder') : t('Downloaded by Ladder')
}

/** Barra del download (collegamenti e agenti del catalogo): `progress` nullo = dimensione ignota. `format` cambia solo le unità (MB decimali per i collegamenti, KiB/MiB/GiB per gli agenti come la conferma). */
export function DownloadBar({ login, format = formatBytes }: { login: Pick<ConnectionLogin, 'progress' | 'bytes' | 'total'>; format?: (bytes: number) => string }) {
  const known = login.progress !== null
  const pct = known ? Math.round(Math.min(1, Math.max(0, login.progress!)) * 100) : 0
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={t('Download progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? pct : undefined}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full bg-running', known ? 'transition-[width] duration-300 motion-reduce:transition-none' : 'w-2/5 animate-pulse motion-reduce:animate-none')} style={known ? { width: `${pct}%` } : undefined} />
      </div>
      {login.bytes !== null && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {login.total ? t('{done} of {total}', { done: format(login.bytes), total: format(login.total) }) : format(login.bytes)}
          {known && ` · ${pct}%`}
        </span>
      )}
    </div>
  )
}

export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-sm"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1600)
          })
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? copiedLabel : label}
      </Button>
      {/* Fuori dal bottone: il nome resta `label`, l'esito si annuncia a parte. */}
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </>
  )
}

/** Accesso in corso: passo, avanzamento del download, e in attesa del browser il link e il codice monouso (GitHub). */
function LoginProgress({ id, login }: { id: ConnectionId; login: ConnectionLogin }) {
  const waiting = login.stage === 'waiting-browser'
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        {stageLabel(id, login)}
      </p>
      {login.stage === 'downloading' && <DownloadBar login={login} />}
      {waiting && login.code && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t('Enter this code on the page:')}
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-sm tracking-wider text-foreground">{login.code}</code>
        </p>
      )}
      {waiting && (login.code || login.url) && (
        <div className="-ml-2 flex flex-wrap items-center gap-1">
          {login.code && <CopyButton text={login.code} label={t('Copy code')} copiedLabel={t('Code copied')} />}
          {login.url && (
            <Button variant="ghost" size="sm" className="text-sm" onClick={() => (window.ladder ? void window.ladder.openExternal(login.url!) : window.open(login.url!, '_blank', 'noopener'))}>
              <ExternalLink aria-hidden />
              {t('Reopen the page')}
            </Button>
          )}
          {login.url && <CopyButton text={login.url} label={t('Copy link')} copiedLabel={t('Link copied')} />}
        </div>
      )}
    </div>
  )
}

/** Messaggi di annullamento (host in inglese o tradotto). */
const CANCELLED = /cancell?ed|annullat/i

type Confirm = 'logout' | 'switch' | null

export interface ConnectionRowProps {
  id: ConnectionId
  /** null: lo stato non è ancora stato letto. */
  status: ConnectionStatus | null
  actions: ConnectionActions
  /** Nelle impostazioni mostra anche versione e provenienza dello strumento. */
  showTool?: boolean
  /** Profilo (Claude Code, Codex) di cui è la riga; assente = predefinito. Va ai comandi. */
  profileId?: string
  /** Nome della riga al posto di quello del servizio ("Claude · Lavoro"). */
  name?: string
  /** Al posto del nome, per esempio il campo di rinomina. */
  titleSlot?: ReactNode
  /** Sotto stato e account: dettagli che restano nella colonna del testo. */
  extra?: ReactNode
  /** I limiti d'uso del profilo, già aperti: accanto al testo da 820 px, sotto più stretto. Solo con l'account collegato. */
  usage?: ReactNode
  /** In fondo a destra, dopo i bottoni: il menu del profilo. */
  trailing?: ReactNode
  /** In fondo alla colonna centrale: conferme e errori del profilo. */
  footer?: ReactNode
}

export function ConnectionRow({ id, status, actions, showTool, profileId, name: nameOverride, titleSlot, extra, usage, trailing, footer }: ConnectionRowProps) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const cancelConfirm = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  /** Bottone che ha aperto la conferma: il focus ci torna alla chiusura. */
  const opener = useRef<HTMLElement | null>(null)
  const focusInside = useRef(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const name = nameOverride ?? CONNECTION_NAME[id]
  const login = status?.login ?? null
  const connected = status?.state === 'connected' && !login
  // Il login di Claude sta nel Portachiavi, condiviso con la CLI dell'utente: uscire o cambiare account vale anche per il Terminale.
  // Un profilo di Ladder ha la sua cartella di configurazione: il suo accesso non è quello della CLI.
  const sharesLogin = id === 'claude-code' && !profileId

  useEffect(() => {
    if (confirm) cancelConfirm.current?.focus()
  }, [confirm])

  /** Un comando alla volta per riga: i bottoni restano disattivi finché l'host non risponde. */
  function run(command: () => void | Promise<void>): void {
    setBusy(true)
    void Promise.resolve(command()).finally(() => mounted.current && setBusy(false))
  }
  function openConfirm(kind: 'logout' | 'switch', e: MouseEvent<HTMLElement>): void {
    opener.current = e.currentTarget
    setConfirm(kind)
  }
  function closeConfirm(): void {
    setConfirm(null)
    const back = opener.current
    opener.current = null
    if (back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus()
  }
  function onBlurRow(e: FocusEvent<HTMLDivElement>): void {
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInside.current = false
  }

  const account = status ? (status.email ?? status.user) : null
  const state = login ? 'signing' : status?.state === 'connected' ? 'connected' : status?.state === 'error' ? 'error' : status ? 'signed-out' : 'loading'

  const action = login ? 'cancel' : connected ? 'connected' : 'signin'
  // Se il focus era nella riga e il bottone su cui stava è sparito o disattivato (Accedi → Annulla → Cambia account), passa all'azione principale nuova.
  useEffect(() => {
    if (!focusInside.current) return
    const active = document.activeElement
    // Focus altrove nel dialog (sfocatura senza relatedTarget): non lo rubo.
    if (active && active !== document.body && !root.current?.contains(active)) {
      focusInside.current = false
      return
    }
    if (active && active !== document.body && !(active as HTMLButtonElement).disabled) return
    root.current?.querySelector<HTMLElement>('[data-primary]:not(:disabled)')?.focus()
  }, [action, busy])

  const stateLabel =
    state === 'connected' ? (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check aria-hidden className="size-3" />
        {t('Connected')}
      </span>
    ) : state === 'signing' ? (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
        {t('Signing in…')}
      </span>
    ) : state === 'error' ? (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <CircleAlert aria-hidden className="size-3" />
        {t('Problem')}
      </span>
    ) : state === 'signed-out' ? (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CircleDashed aria-hidden className="size-3" />
        {t('Not signed in')}
      </span>
    ) : null

  const detail =
    state === 'connected'
      ? account
        ? t('Signed in as {account}', { account })
        : t('Signed in')
      : state === 'signed-out' && status?.state === 'missing' && id !== 'claude-code'
        ? t('{tool} isn’t installed. Ladder downloads it, then opens your browser to sign in.', { tool: TOOL[id] })
        : state === 'loading'
          ? t('Checking…')
          : purpose(id)

  return (
    <div ref={root} data-connection={id} data-profile={profileId ?? 'default'} className={cn(ROW_GRID, 'px-4 py-3.5')} onFocusCapture={() => (focusInside.current = true)} onBlurCapture={onBlurRow}>
      <ServiceMark id={id} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {titleSlot ?? <span className="text-sm font-medium">{name}</span>}
          {state === 'connected' && status?.plan && <span className="rounded border border-border px-1 text-xs text-muted-foreground">{status.plan}</span>}
          {stateLabel}
        </div>
        {!login && <p className="text-xs text-muted-foreground">{detail}</p>}
        {!login && status?.error && (
          // Un annullamento voluto non è un guasto: niente rosso e niente avviso.
          <p {...(CANCELLED.test(status.error) ? {} : { role: 'alert' })} className={cn('text-xs', CANCELLED.test(status.error) ? 'text-muted-foreground' : 'text-destructive')}>
            {status.error}
          </p>
        )}
        {login && <LoginProgress id={id} login={login} />}
        {connected && extra}
        {showTool && status && status.state !== 'missing' && (status.version || status.source) && (
          <p className="truncate text-xs text-faint">{[status.version ? `v${status.version}` : null, status.source ? sourceLabel(status.source) : null].filter(Boolean).join(' · ')}</p>
        )}
        {confirm && (
          <div
            role="group"
            aria-label={t('Confirm')}
            className="flex flex-col gap-2 rounded-md bg-muted p-3"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              closeConfirm()
            }}
          >
            <p className="text-xs">
              {confirm === 'logout'
                ? t('Signing out also signs out the Claude Code CLI you use in the Terminal: they share the same login.')
                : sharesLogin
                  ? t('Switching account signs you out first, then opens the sign-in. If you cancel the sign-in you stay signed out, and the Claude Code CLI you use in the Terminal too: they share the same login.')
                  : t('Switching account signs you out first, then opens the sign-in. If you cancel the sign-in you stay signed out.')}
            </p>
            <div className="flex gap-2">
              <Button
                variant={confirm === 'logout' ? 'destructive' : 'outline'}
                size="sm"
                className="text-sm"
                disabled={busy}
                onClick={() => {
                  const kind = confirm
                  setConfirm(null)
                  opener.current = null
                  run(() => (kind === 'logout' ? actions.logout(id, profileId) : actions.login(id, true, profileId)))
                }}
              >
                {confirm === 'logout' ? t('Sign out') : t('Switch account')}
              </Button>
              <Button ref={cancelConfirm} variant="ghost" size="sm" className="text-sm" onClick={closeConfirm}>
                {t('Cancel')}
              </Button>
            </div>
          </div>
        )}
        {footer}
      </div>
      <div className={ROW_ACTIONS}>
        {login ? (
          <Button data-primary variant="ghost" size="sm" className="text-sm" disabled={busy} aria-label={t('Cancel signing in to {name}', { name })} onClick={() => run(() => actions.cancel(id, profileId))}>
            {t('Cancel')}
          </Button>
        ) : connected ? (
          <>
            <Button data-primary variant="ghost" size="sm" className="text-sm" disabled={busy} aria-label={t('Switch account on {name}', { name })} onClick={(e) => openConfirm('switch', e)}>
              {t('Switch account')}
            </Button>
            <Button variant="ghost" size="sm" className={SIGN_OUT} disabled={busy} aria-label={t('Sign out of {name}', { name })} onClick={(e) => (sharesLogin ? openConfirm('logout', e) : run(() => actions.logout(id, profileId)))}>
              {t('Sign out')}
            </Button>
          </>
        ) : status ? (
          <Button data-primary variant="outline" size="sm" className="text-sm" disabled={busy} aria-label={t('Sign in to {name}', { name })} onClick={() => run(() => actions.login(id, false, profileId))}>
            {status.state === 'error' || status.error ? t('Try again') : t('Sign in')}
          </Button>
        ) : null}
        {trailing}
      </div>
      {connected && usage && <div className={ROW_USAGE}>{usage}</div>}
    </div>
  )
}
