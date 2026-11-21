// Limiti d'uso del piano, a portata di clic nel composer: quanto hai consumato, quando si azzera, e un refresh.
import { useState } from 'react'
import { ChartNoAxesColumn, RotateCw } from 'lucide-react'
import type { AgentId, AgentStatus, UsageWindow } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { request } from '@/lib/host-client'
import { agentStatusFor, hostProfileId, isProfileAgent, useSessionProfileName } from '@/lib/profiles'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Dati più vecchi di così si rileggono da soli quando si apre il pannello. */
const STALE_MS = 60_000

function windowName(usage: UsageWindow): string {
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

function resetsLabel(resetsAt: number, now: number): string {
  const date = new Date(resetsAt * 1000)
  const sameDay = date.toDateString() === new Date(now * 1000).toDateString()
  const time = date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  const when = sameDay ? time : `${date.toLocaleDateString(localeTag(), { weekday: 'short' })} ${time}`
  return t('Resets {when} · in {left}', { when, left: duration(resetsAt - now) })
}

export function updatedLabel(at: number | null | undefined, now: number): string {
  if (!at) return t('Not read yet')
  const seconds = now - at / 1000
  return seconds < 60 ? t('Updated just now') : t('Updated {left} ago', { left: duration(seconds) })
}

export function UsageRow({ usage, now }: { usage: UsageWindow; now: number }) {
  const percent = usage.percent === null ? null : Math.min(100, Math.max(0, usage.percent))
  const tone = usage.state === 'limited' ? 'bg-destructive' : usage.state === 'warning' || (percent !== null && percent >= 80) ? 'bg-attention' : 'bg-primary'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
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
      {usage.breakdown && usage.breakdown.length > 1 && (
        <span className="text-xs text-muted-foreground tabular-nums">{usage.breakdown.map((part) => `${part.label} ${Math.round(part.percent)}%`).join(' · ')}</span>
      )}
    </div>
  )
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
    const profile = hostProfileId(profileId)
    request<AgentStatus | null>({ type: 'agents.usage', agent, ...(profile ? { profileId: profile } : {}) })
      .then((next) => setFailed(!next?.usageAt))
      .catch(() => setFailed(true))
      .finally(() => {
        setLoading(false)
        setNow(Date.now() / 1000)
      })
  }
  /** All'apertura: l'ora si aggiorna e un dato vecchio si rilegge. */
  const opened = () => {
    setNow(Date.now() / 1000)
    if (!status?.usageAt || Date.now() - status.usageAt > STALE_MS) refresh()
  }

  // Una finestra già azzerata non dice più niente: si aspetta il dato nuovo.
  const windows = (status?.usage ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)
  return { status, loading, failed, now, native, windows, refresh, opened }
}

export function UsageButton({ agent, profileId }: { agent: AgentId; profileId?: string | null }) {
  const { status, loading, failed, now, native, windows, refresh, opened } = useUsage(agent, profileId)
  // Il nome del profilo si vede solo se l'agente ne ha più d'uno.
  const profileName = useSessionProfileName({ agent, profileId })
  return (
    <Popover onOpenChange={(open) => open && opened()}>
      <PopoverTrigger
        aria-label={t('Plan usage')}
        title={t('Plan usage')}
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent data-popup-open:text-foreground"
      >
        <ChartNoAxesColumn className="size-[15px]" strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-72 gap-3 p-3" data-usage-panel>
        <div className="flex items-start gap-2">
          <AgentMark agent={agent} size={14} className="mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{[status?.account ?? status?.name ?? agent, profileName].filter(Boolean).join(' · ')}</span>
            <span className="truncate text-xs text-muted-foreground">{loading ? t('Updating…') : failed ? `${t('Update failed')} · ${updatedLabel(status?.usageAt, now)}` : updatedLabel(status?.usageAt, now)}</span>
          </div>
          {native && (
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              aria-label={t('Refresh usage')}
              title={t('Refresh usage')}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              <RotateCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
            </button>
          )}
        </div>
        {windows.length > 0 ? (
          windows.map((usage) => <UsageRow key={usage.key} usage={usage} now={now} />)
        ) : (
          <p className="text-sm text-muted-foreground">{loading ? t('Reading your plan limits…') : t('No usage data yet. It appears after the first reply.')}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
