// Limiti d'uso del piano, a portata di clic nel composer: quanto hai consumato, quando si azzera, e un refresh.
import { useEffect, useId, useRef, useState } from 'react'
import { ChartNoAxesColumn, RotateCw, TriangleAlert } from 'lucide-react'
import type { AgentId, AgentStatus, ConnectionId, UsageWindow } from '@shared/protocol'
import { localeTag, plural, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CONNECTION_NAME } from '@/lib/connections'
import { request } from '@/lib/host-client'
import { agentStatusFor, hostProfileId, isProfileAgent } from '@/lib/profiles'
import { accountKey, useUsageAccounts, type UsageAccount } from '@/lib/usage-accounts'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Dati più vecchi di così si rileggono da soli quando si apre il pannello. */
const STALE_MS = 60_000

export function windowName(usage: UsageWindow): string {
  if (usage.label) return usage.label
  const base = usage.minutes >= 7 * 24 * 60 ? t('Weekly') : usage.minutes >= 60 ? t('{hours}-hour window', { hours: Math.round(usage.minutes / 60) }) : t('{minutes}-minute window', { minutes: usage.minutes })
  return usage.model ? `${base} · ${usage.model}` : base
}

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return t('{n} min', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{h} h {m} min', { h: hours, m: minutes % 60 })
  return t('{d} d {h} h', { d: Math.floor(hours / 24), h: hours % 24 })
}

/** Ora locale del reset: solo l'ora se è oggi, altrimenti anche il giorno della settimana. */
export function resetsWhen(resetsAt: number, now: number): string {
  const date = new Date(resetsAt * 1000)
  const sameDay = date.toDateString() === new Date(now * 1000).toDateString()
  const time = date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${date.toLocaleDateString(localeTag(), { weekday: 'short' })} ${time}`
}

function resetsLabel(resetsAt: number, now: number): string {
  return t('Resets {when} · in {left}', { when: resetsWhen(resetsAt, now), left: duration(resetsAt - now) })
}

/** Da quanto una finestra merita un avviso sull'icona (e nel popover); il bannerino sopra il composer parte più in alto. */
export const USAGE_WARN_AT = 80
export const USAGE_BANNER_AT = 95

/** Gravità di una finestra: 0 niente, 1 vicina al limite, 2 limite esaurito. */
function usageSeverity(usage: UsageWindow, threshold: number): 0 | 1 | 2 {
  if (usage.state === 'limited') return 2
  if (threshold === USAGE_BANNER_AT) return usage.percent !== null && usage.percent >= threshold ? 1 : 0
  return usage.percent === null ? (usage.state === 'warning' ? 1 : 0) : usage.percent >= threshold ? 1 : 0
}

/** Uso extra e simili: spesa opzionale senza reset, non è un limite del piano che si azzera. */
function isSpend(usage: UsageWindow): boolean {
  return usage.key === 'extra_usage' || (usage.resetsAt === null && !!usage.label)
}

/** La finestra più vicina al limite fra quelle sopra soglia, o null: sotto soglia non c'è niente da dire. */
export function usageAlert(windows: UsageWindow[], threshold = USAGE_WARN_AT): { usage: UsageWindow; limited: boolean } | null {
  let best: UsageWindow | null = null
  let bestScore = 0
  for (const usage of windows) {
    if (isSpend(usage)) continue
    const severity = usageSeverity(usage, threshold)
    if (!severity) continue
    const score = severity * 1000 + (usage.percent ?? 0)
    if (score > bestScore) [best, bestScore] = [usage, score]
  }
  return best ? { usage: best, limited: best.state === 'limited' } : null
}

/** "Weekly: close to the limit (88% used)." e "Resets Mon 09:00.", già tradotti. */
export function usageAlertText(alert: { usage: UsageWindow; limited: boolean }, now: number): { what: string; reset: string | null } {
  const { usage, limited } = alert
  const window = windowName(usage)
  const percent = usage.percent === null ? null : Math.round(Math.min(100, Math.max(0, usage.percent)))
  const what = limited ? t('{window}: limit reached.', { window }) : percent === null ? t('{window}: close to the limit.', { window }) : t('{window}: close to the limit ({percent}% used).', { window, percent })
  return { what, reset: usage.resetsAt === null ? null : t('Resets {when}.', { when: resetsWhen(usage.resetsAt, now) }) }
}

export function updatedLabel(at: number | null | undefined, now: number): string {
  if (!at) return t('Not read yet')
  const seconds = now - at / 1000
  return seconds < 60 ? t('Updated just now') : t('Updated {left} ago', { left: duration(seconds) })
}

/** `compact`: righe da 12 px per le Impostazioni (finestre già aperte accanto all'account), senza il dettaglio per modello. */
export function UsageRow({ usage, now, compact }: { usage: UsageWindow; now: number; compact?: boolean }) {
  const percent = usage.percent === null ? null : Math.min(100, Math.max(0, usage.percent))
  const tone = usage.state === 'limited' ? 'bg-destructive' : usage.state === 'warning' || (percent !== null && percent >= 80) ? 'bg-attention' : 'bg-primary'
  return (
    <div className="flex flex-col gap-1">
      <div className={cn('flex items-baseline justify-between gap-3', compact ? 'text-xs' : 'text-sm')}>
        <span className="min-w-0 truncate">{windowName(usage)}</span>
        <span className="shrink-0 font-medium tabular-nums">
          {percent === null ? (usage.state === 'limited' ? t('Limit reached') : usage.state === 'warning' ? t('Near the limit') : t('OK')) : t('{percent}% used', { percent: Math.round(percent) })}
        </span>
      </div>
      {percent !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div className={cn('h-full origin-left rounded-full transition-transform duration-300 ease-out', tone)} style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
      )}
      {(usage.detail || usage.resetsAt !== null) && <span className="text-xs text-muted-foreground tabular-nums">{usage.detail ?? resetsLabel(usage.resetsAt!, now)}</span>}
      {!compact && usage.breakdown && usage.breakdown.length > 1 && (
        <span className="text-xs text-muted-foreground tabular-nums">{usage.breakdown.map((part) => `${part.label} ${Math.round(part.percent)}%`).join(' · ')}</span>
      )}
    </div>
  )
}

/** Esito di una lettura: `ok` con finestre, `empty` se l'host risponde ma non c'è niente da mostrare, `error` se la richiesta fallisce o è rifiutata. */
export type UsageRead = 'ok' | 'empty' | 'error'

/** Letture in corso per account (una sola alla volta: chi chiede mentre un'altra è in corso ne riceve la stessa) e ora dell'ultima completata. */
const reading = new Map<string, Promise<UsageRead>>()
const lastRead = new Map<string, number>()

/** Il dato di un account va riletto: mai letto o più vecchio di STALE_MS. Vale anche per le letture vuote, che non hanno `usageAt`. */
function isStale(key: string, usageAt: number | null | undefined): boolean {
  const last = Math.max(usageAt ?? 0, lastRead.get(key) ?? 0)
  return !last || Date.now() - last > STALE_MS
}

/** Rilegge i limiti di un agente nativo (e del suo profilo): l'host aggiorna lo store. */
export function readUsage(agent: AgentId, profileId?: string | null): Promise<UsageRead> {
  const key = accountKey(agent, profileId)
  const running = reading.get(key)
  if (running) return running
  const profile = hostProfileId(profileId)
  const promise = request<AgentStatus | null>({ type: 'agents.usage', agent, ...(profile ? { profileId: profile } : {}) })
    .then((next): UsageRead => (next?.usage?.length ? 'ok' : 'empty'))
    .catch((): UsageRead => 'error')
    .then((result) => {
      reading.delete(key)
      if (result !== 'error') lastRead.set(key, Date.now())
      return result
    })
  reading.set(key, promise)
  return promise
}

/** Limiti d'uso di un agente (e del suo profilo): lettura dallo store, refresh e finestre ancora valide. */
export function useUsage(agent: AgentId, profileId?: string | null) {
  const status = useApp((s) => agentStatusFor(s, agent, profileId))
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now() / 1000)
  // Un profilo senza stato proprio (non ancora letto) si può comunque rileggere.
  const native = status ? status.kind === 'native' : isProfileAgent(agent)

  const refresh = () => {
    if (loading || !native) return
    setLoading(true)
    setFailed(false)
    void readUsage(agent, profileId)
      .then((result) => setFailed(result === 'error'))
      .finally(() => {
        setLoading(false)
        setNow(Date.now() / 1000)
      })
  }
  /** All'apertura: l'ora si aggiorna e un dato vecchio si rilegge. */
  const opened = () => {
    setNow(Date.now() / 1000)
    if (isStale(accountKey(agent, profileId), status?.usageAt)) refresh()
  }

  // Una finestra già azzerata non dice più niente: si aspetta il dato nuovo.
  const windows = (status?.usage ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)
  // Al prossimo reset (o ogni minuto) l'ora si aggiorna: le finestre azzerate spariscono anche a popover chiuso.
  const usage = status?.usage
  useEffect(() => {
    const next = (usage ?? []).map((w) => w.resetsAt).filter((at): at is number => at !== null && at > now)
    const wait = Math.min(60_000, next.length ? (Math.min(...next) - now) * 1000 + 500 : 60_000)
    const timer = window.setTimeout(() => setNow(Date.now() / 1000), Math.max(500, wait))
    return () => window.clearTimeout(timer)
  }, [usage, now])
  return { status, loading, failed, now, native, windows, refresh, opened }
}

export function UsageButton({ agent, profileId }: { agent: AgentId; profileId?: string | null }) {
  // Icona e avviso valgono solo per l'account della sessione aperta; il pannello mostra anche gli altri.
  const { now, windows } = useUsage(agent, profileId)
  const [open, setOpen] = useState(false)
  const alert = usageAlert(windows)
  const alertText = alert ? usageAlertText(alert, now) : null
  const label = alertText ? `${t('Plan usage')}: ${alertText.what}` : t('Plan usage')
  const Icon = alert ? TriangleAlert : ChartNoAxesColumn
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className={cn('grid size-7 shrink-0 place-items-center rounded-md transition-colors', alert ? (alert.limited ? 'text-destructive' : 'text-attention') : 'text-muted-foreground', ' outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent data-popup-open:text-foreground')}
      >
        <Icon className="size-[15px]" strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-80 gap-0 p-0" data-usage-panel>
        <UsagePanel agent={agent} profileId={profileId} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** Una copia dell'insieme con le chiavi aggiunte o tolte: lo stato di React cambia sempre, anche per chiavi già presenti. */
function withKeys(set: Set<string>, keys: string[], on: boolean): Set<string> {
  const next = new Set(set)
  for (const key of keys) (on ? next.add(key) : next.delete(key))
  return next
}

/**
 * Il pannello dei limiti: tutti gli abbonamenti collegati (quello della sessione per primo), ciascuno con le sue finestre
 * e le sessioni in uso. Si monta all'apertura: i dati vecchi si rileggono da soli, in parallelo.
 */
function UsagePanel({ agent, profileId, onNavigate }: { agent: AgentId; profileId?: string | null; onNavigate: () => void }) {
  const accounts = useUsageAccounts({ agent, profileId })
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [announce, setAnnounce] = useState('')
  const mounted = useRef(true)
  const announceTimer = useRef<number | undefined>(undefined)
  const native = accounts.filter((a) => a.native)

  /** Svuota la regione e riscrive dopo un attimo: lo stesso messaggio due volte di fila si annuncia comunque. */
  const say = (message: string) => {
    window.clearTimeout(announceTimer.current)
    setAnnounce('')
    if (message) announceTimer.current = window.setTimeout(() => setAnnounce(message), 100)
  }

  /** Rilegge gli account dati, tutti insieme (le letture già in corso si uniscono, vedi `readUsage`). */
  const read = (list: UsageAccount[], announceDone: boolean) => {
    const todo = list.filter((a) => a.native)
    if (!todo.length) return
    const keys = todo.map((a) => a.key)
    setBusy((prev) => withKeys(prev, keys, true))
    setFailed((prev) => withKeys(prev, keys, false))
    if (announceDone) say(t('Updating…'))
    void Promise.all(
      todo.map((a) =>
        readUsage(a.agent, a.profileId).then((result) => {
          if (!mounted.current) return result
          setBusy((prev) => withKeys(prev, [a.key], false))
          // "Update failed" solo se la richiesta è fallita: una risposta senza dati non è un errore.
          if (result === 'error') setFailed((prev) => withKeys(prev, [a.key], true))
          return result
        })
      )
    ).then((results) => {
      if (!mounted.current) return
      setNow(Date.now() / 1000)
      if (announceDone) say(results.includes('error') ? t('Update failed') : t('Usage updated'))
    })
  }

  // All'apertura l'ora si aggiorna e i dati più vecchi di STALE_MS (o mai letti) si rileggono; poi l'ora scorre ogni 30 secondi.
  useEffect(() => {
    mounted.current = true
    setNow(Date.now() / 1000)
    read(
      accounts.filter((a) => isStale(a.key, a.status?.usageAt)),
      false
    )
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      window.clearTimeout(announceTimer.current)
    }
    // Solo all'apertura: `read` e `accounts` cambiano a ogni render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Il dato più vecchio fra gli abbonamenti mostrati.
  const stamps = native.map((a) => a.status?.usageAt).filter((at): at is number => typeof at === 'number' && at > 0)
  const oldest = stamps.length ? Math.min(...stamps) : null
  const refreshing = busy.size > 0
  const anyFailed = native.some((a) => failed.has(a.key))
  const status = refreshing ? t('Updating…') : anyFailed ? `${t('Update failed')} · ${updatedLabel(oldest, now)}` : updatedLabel(oldest, now)

  return (
    <>
      <div className="flex items-start gap-2 px-3 pt-3 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-sm font-medium">{t('Plan limits')}</h2>
          <span className="truncate text-xs text-muted-foreground tabular-nums">{status}</span>
        </div>
        {native.length > 0 && (
          <button
            type="button"
            onClick={() => !refreshing && read(accounts, true)}
            aria-disabled={refreshing || undefined}
            aria-busy={refreshing}
            aria-label={t('Refresh all usage')}
            title={t('Refresh all usage')}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:opacity-60"
          >
            <RotateCw aria-hidden className={cn('size-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} />
          </button>
        )}
        <span role="status" className="sr-only">
          {announce}
        </span>
      </div>
      <ul className="flex max-h-[min(60vh,440px)] min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain border-t border-border px-3 py-3">
        {accounts.length === 0 && <li className="text-xs text-muted-foreground">{t('No subscriptions linked')}</li>}
        {accounts.map((account) => (
          <AccountUsage
            key={account.key}
            account={account}
            now={now}
            loading={busy.has(account.key)}
            failed={failed.has(account.key)}
            onRefresh={() => read([account], true)}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </>
  )
}

/** Nome di un abbonamento: il piano dell'account e, se l'agente ne ha più d'uno, il profilo. */
export function accountName(account: Pick<UsageAccount, 'agent' | 'status' | 'profileName'>): string {
  const base = account.status?.account ?? account.status?.name ?? (account.agent === 'claude-code' || account.agent === 'codex' ? CONNECTION_NAME[account.agent] : account.agent)
  return [base, account.profileName].filter(Boolean).join(' · ')
}

/** Un abbonamento nel pannello: intestazione con logo, nome (porta alle Impostazioni), sessioni in corso e avviso; poi le finestre. */
function AccountUsage({ account, now, loading, failed, onRefresh, onNavigate }: { account: UsageAccount; now: number; loading: boolean; failed: boolean; onRefresh: () => void; onNavigate: () => void }) {
  const headingId = useId()
  const name = accountName(account)
  const windows = (account.status?.usage ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)
  const alert = usageAlert(windows)
  const alertText = alert ? usageAlertText(alert, now) : null
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-2 border-border not-first:border-t not-first:pt-3">
      <div className="flex items-start gap-2">
        <AgentMark agent={account.agent} size={14} className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id={headingId} className="min-w-0 text-sm font-medium">
            {account.native ? (
              <button
                type="button"
                title={t('Open {name} in Settings', { name })}
                onClick={() => {
                  // Apre Impostazioni → Subscriptions, porta il focus sulla riga e la evidenzia.
                  useApp.getState().focusConnection(account.agent as ConnectionId, account.profileId, { highlight: true })
                  onNavigate()
                }}
                className="max-w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {name}
              </button>
            ) : (
              <span className="block truncate">{name}</span>
            )}
          </h3>
          {account.running > 0 && <span className="text-xs text-muted-foreground tabular-nums">{plural(account.running, '1 session in use', '{n} sessions in use')}</span>}
        </div>
        {alert && alertText && (
          <span role="img" aria-label={alertText.what} title={alertText.what} className={cn('mt-0.5 shrink-0', alert.limited ? 'text-destructive' : 'text-attention')}>
            <TriangleAlert aria-hidden className="size-3.5" strokeWidth={2} />
          </span>
        )}
      </div>
      {/* La frase d'avviso vale solo per la sessione aperta; gli altri abbonamenti hanno il segno accanto al nome. */}
      {account.current && alert && alertText && (
        <p role="status" className={cn('flex items-start gap-2 rounded-md px-2 py-1.5 text-xs', alert.limited ? 'bg-destructive/10' : 'bg-attention/10')}>
          <TriangleAlert aria-hidden className={cn('mt-px size-3.5 shrink-0', alert.limited ? 'text-destructive' : 'text-attention')} strokeWidth={2} />
          <span className="min-w-0">
            <span className="font-medium">{alertText.what}</span>
            {alertText.reset ? ` ${alertText.reset}` : ''}
          </span>
        </p>
      )}
      {windows.length > 0 ? (
        windows.map((usage) => <UsageRow key={usage.key} usage={usage} now={now} compact />)
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-xs text-muted-foreground">{!account.native ? t('Usage isn’t available for this agent.') : loading ? t('Reading your plan limits…') : t('No usage data yet. It appears after the first reply.')}</p>
            {account.native && failed && !loading && (
              <p role="alert" className="text-xs text-destructive">
                {t('Update failed')}
              </p>
            )}
          </div>
          {account.native && (
            <button
              type="button"
              onClick={() => !loading && onRefresh()}
              aria-disabled={loading || undefined}
              aria-label={t('Refresh usage of {name}', { name })}
              title={t('Refresh usage')}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:opacity-60"
            >
              <RotateCw aria-hidden className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
            </button>
          )}
        </div>
      )}
    </li>
  )
}
