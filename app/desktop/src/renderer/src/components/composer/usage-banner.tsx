// Notice above the composer when a plan usage window is nearly exhausted (from 95%) or exhausted. It can be dismissed, and reappears after the reset.
import { useSyncExternalStore } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import type { AgentId } from '@shared/protocol'
import { t } from '@shared/i18n'
import { useSessionProfileName } from '@/lib/profiles'
import { cn } from '@/lib/utils'
import { USAGE_BANNER_AT, useUsage, usageAlert, usageAlertText } from '@/components/composer/usage-button'

const STORE_PREFIX = 'ladder:usage-banner:'

// In-memory dismissals (windows without a reset) and listeners: all open composers stay in sync.
const memory = new Set<string>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}
const isClosed = (key: string) => memory.has(key) || read(key)

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** Saves the dismissal and removes those of past resets of the same window, which are no longer needed. */
function write(prefix: string, key: string, persist: boolean) {
  if (!persist) {
    memory.add(key)
    emit()
    return
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const stored = localStorage.key(i)
      if (stored?.startsWith(prefix)) localStorage.removeItem(stored)
    }
    localStorage.setItem(key, '1')
  } catch {
    memory.add(key)
  }
  emit()
}

export function UsageBanner({ agent, profileId }: { agent: AgentId; profileId?: string | null }) {
  const { windows, now } = useUsage(agent, profileId)
  const profileName = useSessionProfileName({ agent, profileId })
  const alert = usageAlert(windows, USAGE_BANNER_AT)
  // Agent, profile, window and reset time (to the minute): after the reset the key changes and the notice comes back.
  const resets = alert?.usage.resetsAt ?? null
  const prefix = `${STORE_PREFIX}${agent}:${profileId ?? 'default'}:${alert?.usage.key}:`
  const key = `${prefix}${resets === null ? 'none' : Math.round(resets / 60)}`
  const closed = useSyncExternalStore(subscribe, () => isClosed(key))
  if (!alert || closed) return null
  const text = usageAlertText(alert, now)
  return (
    <div
      role="status"
      className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', alert.limited ? 'border-destructive/40 bg-destructive/8' : 'border-attention/40 bg-attention/8')}
    >
      <TriangleAlert aria-hidden className={cn('mt-px size-3.5 shrink-0', alert.limited ? 'text-destructive' : 'text-attention')} strokeWidth={2} />
      <p className="min-w-0 flex-1 text-secondary-foreground">
        {profileName && <span className="font-medium">{profileName} · </span>}
        <span className="font-medium text-foreground">{text.what}</span>
        {text.reset ? ` ${text.reset}` : ''}
      </p>
      <button
        type="button"
        aria-label={t('Dismiss usage notice')}
        title={t('Dismiss usage notice')}
        onClick={() => {
          write(prefix, key, resets !== null)
        }}
        className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
