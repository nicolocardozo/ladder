// Phones: commands to the host, field checks and time texts for Settings → Devices and the top bar.
import type { RemoteLogPage, RemotePairStart, RemoteStatus } from '@shared/protocol'
import { REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

export { REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN }

export const remoteCommands = {
  /** The result's `url` address contains the single-use code: it goes only into the QR, never into a log or an attribute. */
  pairStart: () => request<RemotePairStart>({ type: 'remote.pair.start' }),
  pairCancel: () => request<null>({ type: 'remote.pair.cancel' }),
  setPassword: (password: string | null) => request<null>({ type: 'remote.password.set', password }),
  revoke: (deviceId: string) => request<null>({ type: 'remote.device.revoke', deviceId }),
  rename: (deviceId: string, name: string) => request<null>({ type: 'remote.device.rename', deviceId, name }),
  regenerateKey: () => request<null>({ type: 'remote.key.regenerate' }),
  logList: (before?: number) => request<RemoteLogPage>({ type: 'remote.log.list', ...(before !== undefined ? { before } : {}), limit: 10 })
}

/** Remote channel state, as sent by the host. */
export function useRemoteStatus(): RemoteStatus | null {
  return useApp((s) => s.remote)
}

/** Relay address: empty = the default one. Only wss://, or ws:// to this Mac (development). Returns the error message, or null. */
export function relayUrlError(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return t('Enter an address like wss://relay.example.com.')
  }
  if (url.protocol === 'wss:') return url.hostname ? null : t('Enter an address like wss://relay.example.com.')
  if (url.protocol === 'ws:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? null : t('Use wss://. Plain ws:// only works for localhost.')
  return t('The address must start with wss://.')
}

/** Elapsed time in short form ("5 minutes ago"), in the interface language. */
export function relativeTime(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' })
  const seconds = Math.round((at - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86_400 * 30) return rtf.format(Math.round(seconds / 86_400), 'day')
  return new Date(at).toLocaleDateString(localeTag(), { dateStyle: 'medium' })
}

/** Time of a log entry: just the time if it is today, otherwise also the day. */
export function logTime(at: number, now = new Date()): string {
  const date = new Date(at)
  const today = date.toDateString() === now.toDateString()
  return today ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString(localeTag(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "4:32": time left until the code expires. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** "Phone connected" / "2 phones connected": name of the mark in the top bar. */
export function connectedLabel(count: number): string {
  return count === 1 ? t('Phone connected') : t('{n} phones connected', { n: count })
}
