// Azioni dell'utente verso il Mac. Vibrazione solo su una risposta inviata e su un errore (DESIGN: haptics rari).
// Ogni azione risolve con true se il Mac l'ha accettata, false se è fallita (l'errore è già stato mostrato): chi chiama
// decide cosa fare (tenere aperto lo sheet, rimettere il testo nel composer).
import * as Haptics from 'expo-haptics'
import { t } from '@shared/i18n'
import type { PermissionLevel, QueuedMessage, RemoteSessionCreate, SessionSummary } from '@shared/protocol'
import type { RequestItem } from '@/lib/turns'
import { useToast } from '@/ui/toast'
import { request } from './controller'

/** Errori noti, in inglese come arrivano: si traducono qui. Il resto è già un testo dell'host e si mostra com'è. */
export function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  switch (text) {
    case 'offline':
      return t('The Mac is not connected.')
    case 'Disconnected':
    case 'Connection lost':
      return t('The connection to your Mac was lost.')
    case 'Too many requests. Slow down.':
      return t('Too many requests. Slow down.')
    case 'This request is not available from the phone.':
      return t('This request is not available from the phone.')
    case 'Invalid request.':
      return t('Invalid request.')
    default:
      return text
  }
}

async function run<T>(fn: () => Promise<T>, opts: { haptic?: boolean } = {}): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    const data = await fn()
    if (opts.haptic) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    return { ok: true, data }
  } catch (error) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
    useToast.getState().show(explain(error), 'error')
    return { ok: false }
  }
}

const done = async (p: Promise<{ ok: boolean }>): Promise<boolean> => (await p).ok

/** Esito di una nuova sessione: l'errore resta nel modulo (testo già tradotto), niente toast. */
export type CreateResult = { ok: true; session: SessionSummary } | { ok: false; error: string }

export const actions = {
  /** `session.create` (LAD-89). Il modulo mostra l'errore da sé e conserva il testo; vibra solo sull'esito. */
  async create(command: RemoteSessionCreate): Promise<CreateResult> {
    try {
      const session = await request<SessionSummary>(command)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      return { ok: true, session }
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      return { ok: false, error: explain(error) }
    }
  },
  approve(sessionId: string, req: RequestItem): Promise<boolean> {
    const option = req.options.find((o) => o.kind === 'allow') ?? req.options[0]
    return done(run(() => request({ type: 'session.respond', sessionId, requestId: req.requestId, response: { optionId: option.id }, via: 'phone' }), { haptic: true }))
  },
  deny(sessionId: string, req: RequestItem, message?: string): Promise<boolean> {
    const option = req.options.find((o) => o.kind === 'deny') ?? { id: 'deny' }
    const text = message?.trim()
    return done(run(() => request({ type: 'session.respond', sessionId, requestId: req.requestId, response: { optionId: option.id, ...(text ? { message: text } : {}) }, via: 'phone' }), { haptic: true }))
  },
  answer(sessionId: string, req: RequestItem, answers: Record<string, string>): Promise<boolean> {
    return done(run(() => request({ type: 'session.respond', sessionId, requestId: req.requestId, response: { answers }, via: 'phone' }), { haptic: true }))
  },
  send(sessionId: string, text: string, busy: 'queue' | 'steer'): Promise<boolean> {
    return done(run(() => request({ type: 'session.send', sessionId, text, busy })))
  },
  interrupt(sessionId: string): Promise<boolean> {
    return done(run(() => request({ type: 'session.interrupt', sessionId })))
  },
  queueSet(sessionId: string, queue: QueuedMessage[]): Promise<boolean> {
    return done(run(() => request({ type: 'session.queue.set', sessionId, queue })))
  },
  queueDeliver(sessionId: string, id: string, how: 'steer' | 'now'): Promise<boolean> {
    return done(run(() => request({ type: 'session.queue.deliver', sessionId, id, how })))
  },
  async setPermission(sessionId: string, permission: PermissionLevel): Promise<{ permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' } | null> {
    const r = await run(() => request<{ permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' }>({ type: 'session.permission.set', sessionId, permission }))
    return r.ok ? r.data : null
  },
  markRead(sessionId: string) {
    return request({ type: 'session.read', sessionId }).catch(() => {})
  }
}
