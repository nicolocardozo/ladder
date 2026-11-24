// Telefoni (LAD-51): comandi verso l'host, controlli sui campi e testi di tempo per Impostazioni → Devices e per la barra in alto.
import type { RemoteLogPage, RemotePairStart, RemoteStatus } from '@shared/protocol'
import { REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

export { REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN }

export const remoteCommands = {
  /** L'indirizzo `url` del risultato contiene il codice monouso: va solo nel QR, mai in un log né in un attributo. */
  pairStart: () => request<RemotePairStart>({ type: 'remote.pair.start' }),
  pairCancel: () => request<null>({ type: 'remote.pair.cancel' }),
  setPassword: (password: string | null) => request<null>({ type: 'remote.password.set', password }),
  revoke: (deviceId: string) => request<null>({ type: 'remote.device.revoke', deviceId }),
  rename: (deviceId: string, name: string) => request<null>({ type: 'remote.device.rename', deviceId, name }),
  regenerateKey: () => request<null>({ type: 'remote.key.regenerate' }),
  logList: (before?: number) => request<RemoteLogPage>({ type: 'remote.log.list', ...(before !== undefined ? { before } : {}), limit: 10 })
}

/** Stato del canale remoto, come lo ha mandato l'host. */
export function useRemoteStatus(): RemoteStatus | null {
  return useApp((s) => s.remote)
}

/** Indirizzo del relay: vuoto = quello predefinito. Solo wss://, o ws:// verso questo Mac (sviluppo). Torna il messaggio d'errore, o null. */
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

/** Tempo trascorso in forma breve ("5 minutes ago"), nella lingua dell'interfaccia. */
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

/** Ora di una voce del log: solo l'ora se è di oggi, altrimenti anche il giorno. */
export function logTime(at: number, now = new Date()): string {
  const date = new Date(at)
  const today = date.toDateString() === now.toDateString()
  return today ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString(localeTag(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "4:32": tempo che manca alla scadenza del codice. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** "Phone connected" / "2 phones connected": nome del segno nella barra in alto. */
export function connectedLabel(count: number): string {
  return count === 1 ? t('Phone connected') : t('{n} phones connected', { n: count })
}
