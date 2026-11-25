// State-derived texts: labels, ages, durations. Uses the shared i18n.
import { t } from '@shared/i18n'
import type { SessionState } from './session-state.ts'

export function stateLabel(state: SessionState): string {
  switch (state) {
    case 'waiting':
      return t('Needs you')
    case 'error':
      return t('Error')
    case 'running':
      return t('Running')
    case 'unread':
      return t('Unread')
    case 'queued':
      return t('Queued')
    default:
      return t('Idle')
  }
}

export function relativeAge(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return ''
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 1) return t('now')
  if (minutes < 60) return t('{n} min', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('{n} h', { n: hours })
  const days = Math.round(hours / 24)
  return days === 1 ? t('yesterday') : t('{n} d', { n: days })
}

/** "2 min 14 s" for turn durations and disconnection times. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('{n} s', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 || m >= 10 ? t('{n} min', { n: m }) : t('{m} min {s} s', { m, s: s % 60 })
  const h = Math.floor(m / 60)
  return t('{h} h {m} min', { h, m: m % 60 })
}
