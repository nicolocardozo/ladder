// Limiti d'uso del piano sul telefono (LAD-90). Stessa logica del desktop (composer/usage-button.tsx, lib/usage-accounts.ts),
// ridotta: soglie di avviso, finestra da segnalare, elenco degli abbonamenti, testi di orario e di età del dato.
// Solo logica pura (niente React Native): si prova con node --test.
import type { AgentId, RemoteAgentStatus, RemoteProfile, UsageWindow } from '../../../desktop/src/shared/protocol.ts'
import { localeTag, t } from '../../../desktop/src/shared/i18n.ts'

/** Da quanto una finestra merita un avviso (icona nell'header); il bannerino sopra il composer parte più in alto. Come il desktop. */
export const USAGE_WARN_AT = 80
export const USAGE_BANNER_AT = 95
/** Dati più vecchi di così si rileggono quando si apre la schermata (l'host fa comunque al massimo una lettura vera al minuto). */
export const USAGE_STALE_MS = 60_000

export const isProfileAgent = (agent: AgentId): boolean => agent === 'claude-code' || agent === 'codex'
export const isDefaultProfileId = (id: string | null | undefined): boolean => !id || id.startsWith('default:')

/** Chiave stabile di un account: l'agente e, per Claude e Codex, il profilo (il predefinito è sempre `default:<agente>`). */
export function accountKey(agent: AgentId, profileId?: string | null): string {
  return isProfileAgent(agent) ? `${agent}:${isDefaultProfileId(profileId) ? `default:${agent}` : profileId}` : agent
}

/** Gravità di una finestra: 0 niente, 1 vicina al limite, 2 limite esaurito. */
function severity(usage: UsageWindow, threshold: number): 0 | 1 | 2 {
  if (usage.state === 'limited') return 2
  if (threshold === USAGE_BANNER_AT) return usage.percent !== null && usage.percent >= threshold ? 1 : 0
  return usage.percent === null ? (usage.state === 'warning' ? 1 : 0) : usage.percent >= threshold ? 1 : 0
}

/** Uso extra e simili: spesa opzionale senza reset, non è un limite del piano che si azzera. */
export function isSpend(usage: UsageWindow): boolean {
  return usage.key === 'extra_usage' || (usage.resetsAt === null && !!usage.label)
}

/** Una finestra già azzerata non dice più niente: si aspetta il dato nuovo. `now` in secondi Unix. */
export const liveWindows = (windows: UsageWindow[] | undefined, now: number): UsageWindow[] => (windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now)

export interface UsageAlert {
  usage: UsageWindow
  limited: boolean
}

/** La finestra più vicina al limite fra quelle sopra soglia, o null: sotto soglia non c'è niente da dire. */
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

/** Nome di una finestra: "5-hour window", "Weekly", o l'etichetta già pronta dell'host. */
export function windowName(usage: UsageWindow): string {
  if (usage.label) return usage.label
  const base = usage.minutes >= 7 * 24 * 60 ? t('Weekly') : usage.minutes >= 60 ? t('{hours}-hour window', { hours: Math.round(usage.minutes / 60) }) : t('{minutes}-minute window', { minutes: usage.minutes })
  return usage.model ? `${base} · ${usage.model}` : base
}

/** Il nome corto di un agente nei testi stretti: "Claude", "Codex", o il nome dello stato. */
export const agentShortName = (agent: AgentId, status?: Pick<RemoteAgentStatus, 'name'> | null): string => (agent === 'claude-code' ? 'Claude' : agent === 'codex' ? 'Codex' : (status?.name ?? agent))

/** Riga della finestra peggiore (Impostazioni): "Claude · 82% of 5h", "Codex · limit reached". */
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

/** Ora locale del reset: solo l'ora se è oggi, altrimenti anche il giorno della settimana. Secondi Unix. */
export function resetsWhen(resetsAt: number, now: number): { when: string; today: boolean } {
  const date = new Date(resetsAt * 1000)
  const today = date.toDateString() === new Date(now * 1000).toDateString()
  const time = date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  return { when: today ? time : `${date.toLocaleDateString(localeTag(), { weekday: 'short' })} ${time}`, today }
}

/** "Resets at 18:40 · in 2 h 5 min" (oggi) oppure "Resets Mon 09:00 · in 2 d 3 h". */
export function resetsLabel(resetsAt: number, now: number): string {
  const { when, today } = resetsWhen(resetsAt, now)
  const left = durationText(resetsAt - now)
  return today ? t('Resets at {when} · in {left}', { when, left }) : t('Resets {when} · in {left}', { when, left })
}

/** "Updated 3 min ago". `at` in millisecondi, `now` in secondi come nel resto del file. */
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

/** "Weekly: close to the limit (88% used)." / "Weekly: limit reached.", e quando si azzera. */
export function usageAlertText(alert: UsageAlert, now: number): { what: string; reset: string | null } {
  const { usage, limited } = alert
  const window = windowName(usage)
  const percent = usage.percent === null ? null : Math.round(clampPercent(usage.percent)!)
  const what = limited ? t('{window}: limit reached.', { window }) : percent === null ? t('{window}: close to the limit.', { window }) : t('{window}: close to the limit ({percent}% used).', { window, percent })
  return { what, reset: usage.resetsAt === null ? null : resetsSentence(usage.resetsAt, now) }
}

// ── Abbonamenti ──

export interface UsageAccount {
  key: string
  agent: AgentId
  /** Profilo da passare all'host: assente per il predefinito e per gli agenti senza profili. */
  profileId: string | undefined
  /** Nome del profilo, solo se l'agente ne ha più di uno. */
  profileName: string | null
  status: RemoteAgentStatus | null
  /** Solo gli agenti nativi espongono i limiti e si possono rileggere. */
  native: boolean
  /** È l'account della sessione da cui si è arrivati. */
  current: boolean
}

/** Stato dell'agente per un profilo: il predefinito è quello senza `profileId` (o `default:…`), gli altri portano il loro id. */
export function statusFor(agents: RemoteAgentStatus[], agent: AgentId, profileId?: string | null): RemoteAgentStatus | null {
  if (isDefaultProfileId(profileId)) return agents.find((a) => a.agent === agent && isDefaultProfileId(a.profileId)) ?? null
  return agents.find((a) => a.agent === agent && a.profileId === profileId) ?? null
}

const PROFILE_AGENTS: AgentId[] = ['claude-code', 'codex']

/** Profili di un agente, predefinito per primo; se il predefinito manca nell'elenco lo si sintetizza. */
export function profilesOf(profiles: RemoteProfile[], agent: AgentId): RemoteProfile[] {
  const own = profiles.filter((p) => p.agent === agent).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  if (!isProfileAgent(agent) || own.some((p) => p.isDefault)) return own
  return [{ id: `default:${agent}`, agent: agent as RemoteProfile['agent'], name: 'Default', isDefault: true }, ...own]
}

/**
 * Abbonamenti da mostrare: uno per profilo collegato di Claude e Codex (collegato = l'agente c'è e ha un account),
 * più l'account della sessione di provenienza, che c'è sempre (anche per un agente ACP, che dirà "non disponibile").
 * L'account corrente per primo, gli altri nell'ordine di Claude, Codex, profilo per profilo.
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

/** Nome di un abbonamento: il piano dell'account ("Claude Max") e, se l'agente ha più profili, il profilo. */
export function accountName(account: Pick<UsageAccount, 'agent' | 'status' | 'profileName'>): string {
  const base = account.status?.account ?? account.status?.name ?? (account.agent === 'claude-code' ? 'Claude' : account.agent === 'codex' ? 'Codex' : account.agent)
  return [base, account.profileName].filter(Boolean).join(' · ')
}

/**
 * La finestra peggiore fra tutti gli abbonamenti, per la riga di Impostazioni ("Claude · 82% of 5h"). Solo finestre vere del piano
 * (con percentuale o esaurite, senza spesa extra). Null se non ce n'è nessuna.
 */
export function worstWindow(accounts: UsageAccount[], now: number): { account: UsageAccount; usage: UsageWindow } | null {
  let best: { account: UsageAccount; usage: UsageWindow } | null = null
  let score = -1
  for (const account of accounts) {
    for (const usage of liveWindows(account.status?.usage, now)) {
      // Una finestra esaurita conta anche senza percentuale; una senza percentuale e non esaurita non dice niente.
      if (isSpend(usage) || (usage.percent === null && usage.state !== 'limited')) continue
      const s = (usage.state === 'limited' ? 1000 : 0) + (usage.percent ?? 100)
      if (s > score) [best, score] = [{ account, usage }, s]
    }
  }
  return best
}

/** La finestra da segnalare per l'account di una sessione, o null. `threshold` come usageAlert. */
export function sessionAlert(agents: RemoteAgentStatus[], agent: AgentId, profileId: string | null | undefined, now: number, threshold = USAGE_WARN_AT): UsageAlert | null {
  return usageAlert(liveWindows(statusFor(agents, agent, profileId)?.usage, now), threshold)
}

/** Il dato di un account va riletto: mai letto o più vecchio di USAGE_STALE_MS (`ms` = orologio in millisecondi). */
export function isStale(usageAt: number | null | undefined, lastRead: number | undefined, ms: number): boolean {
  const last = Math.max(usageAt ?? 0, lastRead ?? 0)
  return !last || ms - last > USAGE_STALE_MS
}

// ── Bannerino chiuso ──

/** Tolleranza sul momento del reset: l'host lo ricalcola a ogni lettura e può spostarlo di qualche secondo o minuto. */
const RESET_JITTER_S = 10 * 60

/** Chiave di una finestra per il bannerino chiuso: account e finestra, mai il reset (che balla). */
export const dismissKey = (agent: AgentId, profileId: string | null | undefined, windowKey: string): string => `${accountKey(agent, profileId)}:${windowKey}`

/**
 * Il bannerino di questa finestra è stato chiuso per questo reset? Si ricorda il reset visto alla chiusura: lo stesso (entro la
 * tolleranza) = ancora chiuso; un reset diverso = la finestra si è azzerata e l'avviso può tornare. Senza reset vale finché non si azzera la memoria.
 */
export function isDismissed(closed: ReadonlyMap<string, number | null>, key: string, resetsAt: number | null): boolean {
  if (!closed.has(key)) return false
  const at = closed.get(key)
  if (at === null || resetsAt === null) return at === resetsAt
  return Math.abs(at! - resetsAt) <= RESET_JITTER_S
}
