// Plan usage limits on the phone. Same logic as the desktop (composer/usage-button.tsx, lib/usage-accounts.ts),
// reduced: warning thresholds, window to flag, list of subscriptions, time and data-age texts.
// Pure logic only (no React Native): tested with node --test.
import type { AgentId, RemoteAgentStatus, RemoteProfile, UsageWindow } from '../../../desktop/src/shared/protocol.ts'
import { localeTag, t } from '../../../desktop/src/shared/i18n.ts'

/** From what level a window deserves a warning (icon in the header); the small banner above the composer starts higher. Same as the desktop. */
export const USAGE_WARN_AT = 80
export const USAGE_BANNER_AT = 95
/** Data older than this is re-read when the screen opens (the host does at most one real read per minute anyway). */
export const USAGE_STALE_MS = 60_000

export const isProfileAgent = (agent: AgentId): boolean => agent === 'claude-code' || agent === 'codex'
export const isDefaultProfileId = (id: string | null | undefined): boolean => !id || id.startsWith('default:')

/** Stable key of an account: the agent and, for Claude and Codex, the profile (the default is always `default:<agent>`). */
export function accountKey(agent: AgentId, profileId?: string | null): string {
  return isProfileAgent(agent) ? `${agent}:${isDefaultProfileId(profileId) ? `default:${agent}` : profileId}` : agent
}

/** Severity of a window: 0 nothing, 1 near the limit, 2 limit exhausted. */
function severity(usage: UsageWindow, threshold: number): 0 | 1 | 2 {
  if (usage.state === 'limited') return 2
  if (threshold === USAGE_BANNER_AT) return usage.percent !== null && usage.percent >= threshold ? 1 : 0
  return usage.percent === null ? (usage.state === 'warning' ? 1 : 0) : usage.percent >= threshold ? 1 : 0
}

/** Extra usage and the like: optional spend with no reset, not a plan limit that resets. */
export function isSpend(usage: UsageWindow): boolean {
  return usage.key === 'extra_usage' || (usage.resetsAt === null && !!usage.label)
}

/** A window that has already reset says nothing anymore: wait for the new data. `now` in Unix seconds. */
export const liveWindows = (windows: UsageWindow[] | undefined, now: number): UsageWindow[] => (windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)

export interface UsageAlert {
  usage: UsageWindow
  limited: boolean
}

/** The window closest to the limit among those above the threshold, or null: below the threshold there is nothing to say. */
export function usageAlert(windows: UsageWindow[], threshold = USAGE_WARN_AT): UsageAlert | null {
  let best: UsageWindow | null = null
  let bestScore = 0
  for (const usage of windows) {
    if (isSpend(usage)) continue
    const s = severity(usage, threshold)
    if (!s) continue
    const score = s * 1000 + (usage.percent ?? 0)
    if (score > bestScore) [best, bestScore] = [usage, score]
  }
  return best ? { usage: best, limited: best.state === 'limited' } : null
}

export const clampPercent = (percent: number | null): number | null => (percent === null ? null : Math.min(100, Math.max(0, percent)))

/** Name of a window: "5-hour window", "Weekly", or the host's ready-made label. */
export function windowName(usage: UsageWindow): string {
  if (usage.label) return usage.label
  const base = usage.minutes >= 7 * 24 * 60 ? t('Weekly') : usage.minutes >= 60 ? t('{hours}-hour window', { hours: Math.round(usage.minutes / 60) }) : t('{minutes}-minute window', { minutes: usage.minutes })
  return usage.model ? `${base} · ${usage.model}` : base
}

/** The short name of an agent in tight texts: "Claude", "Codex", or the state's name. */
export const agentShortName = (agent: AgentId, status?: Pick<RemoteAgentStatus, 'name'> | null): string => (agent === 'claude-code' ? 'Claude' : agent === 'codex' ? 'Codex' : (status?.name ?? agent))

/** Row for the worst window (Settings): "Claude · 82% of 5h", "Codex · limit reached". */
export function worstText(worst: { account: Pick<UsageAccount, 'agent' | 'status'>; usage: UsageWindow }): string {
  const agent = agentShortName(worst.account.agent, worst.account.status)
  const { usage } = worst
  if (usage.state === 'limited') return t('{agent} · limit reached', { agent })
  const percent = Math.round(clampPercent(usage.percent) ?? 0)
  if (usage.label) return t('{agent} · {percent}% of {name}', { agent, percent, name: usage.label })
  if (usage.minutes >= 7 * 24 * 60) return t('{agent} · {percent}% of weekly', { agent, percent })
  if (usage.minutes >= 60) return t('{agent} · {percent}% of {hours}h', { agent, percent, hours: Math.round(usage.minutes / 60) })
  return t('{agent} · {percent}% of {minutes} min', { agent, percent, minutes: usage.minutes })
}

/** "2 h 5 min", "3 d 4 h", "12 min". */
export function durationText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return t('{n} min', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? t('{n} h', { n: hours }) : t('{h} h {m} min', { h: hours, m: minutes % 60 })
  return t('{d} d {h} h', { d: Math.floor(hours / 24), h: hours % 24 })
}

/** Local time of the reset: only the time if it is today, otherwise also the weekday. Unix seconds. */
export function resetsWhen(resetsAt: number, now: number): { when: string; today: boolean } {
  const date = new Date(resetsAt * 1000)
  const today = date.toDateString() === new Date(now * 1000).toDateString()
  const time = date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  return { when: today ? time : `${date.toLocaleDateString(localeTag(), { weekday: 'short' })} ${time}`, today }
}

/** "Resets at 18:40 · in 2 h 5 min" (today) or "Resets Mon 09:00 · in 2 d 3 h". */
export function resetsLabel(resetsAt: number, now: number): string {
  const { when, today } = resetsWhen(resetsAt, now)
  const left = durationText(resetsAt - now)
  return today ? t('Resets at {when} · in {left}', { when, left }) : t('Resets {when} · in {left}', { when, left })
}

/** "Updated 3 min ago". `at` in milliseconds, `now` in seconds as in the rest of the file. */
export function updatedLabel(at: number | null | undefined, now: number): string {
  if (!at) return t('Not read yet')
  const seconds = now - at / 1000
  return seconds < 60 ? t('Updated just now') : t('Updated {left} ago', { left: durationText(seconds) })
}

/** "Resets at 18:40." / "Resets Mon 09:00." */
function resetsSentence(resetsAt: number, now: number): string {
  const { when, today } = resetsWhen(resetsAt, now)
  return today ? t('Resets at {when}.', { when }) : t('Resets {when}.', { when })
}

/** "Weekly: close to the limit (88% used)." / "Weekly: limit reached.", and when it resets. */
export function usageAlertText(alert: UsageAlert, now: number): { what: string; reset: string | null } {
  const { usage, limited } = alert
  const window = windowName(usage)
  const percent = usage.percent === null ? null : Math.round(clampPercent(usage.percent)!)
  const what = limited ? t('{window}: limit reached.', { window }) : percent === null ? t('{window}: close to the limit.', { window }) : t('{window}: close to the limit ({percent}% used).', { window, percent })
  return { what, reset: usage.resetsAt === null ? null : resetsSentence(usage.resetsAt, now) }
}

// ── Subscriptions ──

export interface UsageAccount {
  key: string
  agent: AgentId
  /** Profile to pass to the host: absent for the default and for agents without profiles. */
  profileId: string | undefined
  /** Profile name, only if the agent has more than one. */
  profileName: string | null
  status: RemoteAgentStatus | null
  /** Only native agents expose limits and can be re-read. */
  native: boolean
  /** It is the account of the session we came from. */
  current: boolean
}

/** Agent state for a profile: the default is the one without `profileId` (or `default:…`), the others carry their id. */
export function statusFor(agents: RemoteAgentStatus[], agent: AgentId, profileId?: string | null): RemoteAgentStatus | null {
  if (isDefaultProfileId(profileId)) return agents.find((a) => a.agent === agent && isDefaultProfileId(a.profileId)) ?? null
  return agents.find((a) => a.agent === agent && a.profileId === profileId) ?? null
}

const PROFILE_AGENTS: AgentId[] = ['claude-code', 'codex']

/** An agent's profiles, default first; if the default is missing from the list it is synthesized. */
export function profilesOf(profiles: RemoteProfile[], agent: AgentId): RemoteProfile[] {
  const own = profiles.filter((p) => p.agent === agent).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  if (!isProfileAgent(agent) || own.some((p) => p.isDefault)) return own
  return [{ id: `default:${agent}`, agent: agent as RemoteProfile['agent'], name: 'Default', isDefault: true }, ...own]
}

/**
 * Subscriptions to show: one per connected Claude and Codex profile (connected = the agent exists and has an account),
 * plus the account of the originating session, which is always there (even for an ACP agent, which will say "not available").
 * The current account first, the others in Claude, Codex order, profile by profile.
 */
export function buildUsageAccounts(agents: RemoteAgentStatus[], profiles: RemoteProfile[], current?: { agent: AgentId; profileId?: string | null } | null): UsageAccount[] {
  const currentKey = current ? accountKey(current.agent, current.profileId) : null
  const list: UsageAccount[] = []
  const add = (agent: AgentId, profileId: string | undefined, profileName: string | null): void => {
    const key = accountKey(agent, profileId)
    if (list.some((a) => a.key === key)) return
    const status = statusFor(agents, agent, profileId)
    list.push({ key, agent, profileId, profileName, status, native: status ? status.kind === 'native' : isProfileAgent(agent), current: key === currentKey })
  }
  for (const agent of PROFILE_AGENTS) {
    const own = profilesOf(profiles, agent)
    for (const profile of own) {
      const id = profile.isDefault ? undefined : profile.id
      const status = statusFor(agents, agent, id)
      const linked = !!status?.available && !!status.account
      if (linked || accountKey(agent, id) === currentKey) add(agent, id, own.length > 1 ? profile.name : null)
    }
  }
  if (current) {
    const own = profilesOf(profiles, current.agent)
    const id = isDefaultProfileId(current.profileId) ? undefined : (current.profileId ?? undefined)
    add(current.agent, id, own.length > 1 ? (own.find((p) => (p.isDefault ? isDefaultProfileId(id) : p.id === id))?.name ?? null) : null)
  }
  return list.sort((a, b) => Number(b.current) - Number(a.current))
}

/** Name of a subscription: the account's plan ("Claude Max") and, if the agent has several profiles, the profile. */
export function accountName(account: Pick<UsageAccount, 'agent' | 'status' | 'profileName'>): string {
  const base = account.status?.account ?? account.status?.name ?? (account.agent === 'claude-code' ? 'Claude' : account.agent === 'codex' ? 'Codex' : account.agent)
  return [base, account.profileName].filter(Boolean).join(' · ')
}

/**
 * The worst window across all subscriptions, for the Settings row ("Claude · 82% of 5h"). Only real plan windows
 * (with a percentage or exhausted, without extra spend). Null if there are none.
 */
export function worstWindow(accounts: UsageAccount[], now: number): { account: UsageAccount; usage: UsageWindow } | null {
  let best: { account: UsageAccount; usage: UsageWindow } | null = null
  let score = -1
  for (const account of accounts) {
    for (const usage of liveWindows(account.status?.usage, now)) {
      // An exhausted window counts even without a percentage; one without a percentage that is not exhausted says nothing.
      if (isSpend(usage) || (usage.percent === null && usage.state !== 'limited')) continue
      const s = (usage.state === 'limited' ? 1000 : 0) + (usage.percent ?? 100)
      if (s > score) [best, score] = [{ account, usage }, s]
    }
  }
  return best
}

/** The window to flag for a session's account, or null. `threshold` as in usageAlert. */
export function sessionAlert(agents: RemoteAgentStatus[], agent: AgentId, profileId: string | null | undefined, now: number, threshold = USAGE_WARN_AT): UsageAlert | null {
  return usageAlert(liveWindows(statusFor(agents, agent, profileId)?.usage, now), threshold)
}

/** An account's data should be re-read: never read or older than USAGE_STALE_MS (`ms` = clock in milliseconds). */
export function isStale(usageAt: number | null | undefined, lastRead: number | undefined, ms: number): boolean {
  const last = Math.max(usageAt ?? 0, lastRead ?? 0)
  return !last || ms - last > USAGE_STALE_MS
}

// ── Dismissed banner ──

/** Tolerance on the reset time: the host recomputes it on every read and may shift it by a few seconds or minutes. */
const RESET_JITTER_S = 10 * 60

/** Key of a window for the dismissed banner: account and window, never the reset (which jitters). */
export const dismissKey = (agent: AgentId, profileId: string | null | undefined, windowKey: string): string => `${accountKey(agent, profileId)}:${windowKey}`

/**
 * Was this window's banner dismissed for this reset? The reset seen at dismissal is remembered: the same one (within the
 * tolerance) = still dismissed; a different reset = the window has reset and the warning may return. Without a reset it holds until memory is cleared.
 */
export function isDismissed(closed: ReadonlyMap<string, number | null>, key: string, resetsAt: number | null): boolean {
  if (!closed.has(key)) return false
  const at = closed.get(key)
  if (at === null || resetsAt === null) return at === resetsAt
  return Math.abs(at! - resetsAt) <= RESET_JITTER_S
}
