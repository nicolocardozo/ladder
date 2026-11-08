// Limiti d'uso del piano, a portata di clic nel composer: quanto hai consumato e quando si azzera.
import { ChartNoAxesColumn } from 'lucide-react'
import type { AgentId, UsageWindow } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useApp } from '@/store/app-store'

function windowName(usage: UsageWindow): string {
  const base = usage.minutes >= 7 * 24 * 60 ? t('Weekly') : usage.minutes >= 60 ? t('{hours}-hour window', { hours: Math.round(usage.minutes / 60) }) : t('{minutes}-minute window', { minutes: usage.minutes })
  return usage.model ? `${base} · ${usage.model}` : base
}

function resetsLabel(resetsAt: number): string {
  const date = new Date(resetsAt * 1000)
  const sameDay = date.toDateString() === new Date().toDateString()
  const time = date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  return t('Resets {when}', { when: sameDay ? time : `${date.toLocaleDateString(localeTag(), { weekday: 'short' })} ${time}` })
}

function UsageRow({ usage }: { usage: UsageWindow }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{windowName(usage)}</span>
        <span className="shrink-0 font-medium tabular-nums">{usage.percent === null ? (usage.state === 'limited' ? t('Limit reached') : usage.state === 'warning' ? t('Near the limit') : t('OK')) : `${Math.round(usage.percent)}%`}</span>
      </div>
      {usage.percent !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full origin-left rounded-full bg-primary" style={{ transform: `scaleX(${Math.min(100, Math.max(0, usage.percent)) / 100})` }} />
        </div>
      )}
      {usage.resetsAt !== null && <span className="text-xs text-muted-foreground">{resetsLabel(usage.resetsAt)}</span>}
    </div>
  )
}

export function UsageButton({ agent }: { agent: AgentId }) {
  const status = useApp((s) => s.agents.find((a) => a.agent === agent) ?? null)
  const now = Date.now() / 1000
  // Una finestra già azzerata non dice più niente: si aspetta il dato nuovo.
  const windows = (status?.usage ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t('Plan usage')}
        title={t('Plan usage')}
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent data-popup-open:text-foreground"
      >
        <ChartNoAxesColumn className="size-[15px]" strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-64 gap-3 p-3" data-usage-panel>
        <div className="flex items-center gap-2">
          <AgentMark agent={agent} size={14} />
          <span className="min-w-0 truncate text-sm font-medium">{status?.account ?? status?.name ?? agent}</span>
          {status?.version && <span className="ml-auto shrink-0 font-mono text-xs text-faint">v{status.version}</span>}
        </div>
        {windows.length > 0 ? windows.map((usage) => <UsageRow key={usage.key} usage={usage} />) : <p className="text-sm text-muted-foreground">{t('No usage data yet. It appears after the first reply.')}</p>}
      </PopoverContent>
    </Popover>
  )
}
