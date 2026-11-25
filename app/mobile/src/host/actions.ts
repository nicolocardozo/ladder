// User actions towards the Mac. Haptics only on a sent reply and on an error (DESIGN: haptics are rare).
// Each action resolves true if the Mac accepted it, false if it failed (the error has already been shown): the caller
// decides what to do (keep the sheet open, put the text back in the composer).
import * as Haptics from 'expo-haptics'
import { t } from '@shared/i18n'
import type { Attachment, PermissionLevel, QueuedMessage, RemoteSessionCreate, SessionSummary } from '@shared/protocol'
import type { RequestItem } from '@/lib/turns'
import { useToast } from '@/ui/toast'
import { request } from './controller'

/** Known errors, in English as they arrive: translated here. Anything else is already host text and is shown as is. */
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
    case 'Too many images. Try again in a moment.':
      return t('Too many images. Try again in a moment.')
    case 'Invalid images. Send up to 3 JPEG, PNG or WebP images, 1 MB each and 2 MB in total.':
      return t('Invalid images. Send up to 3 JPEG, PNG or WebP images, 1 MB each and 2 MB in total.')
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

/** Outcome of a new session: the error stays in the form (text already translated), no toast. */
export type CreateResult = { ok: true; session: SessionSummary } | { ok: false; error: string }

export const actions = {
  /** `session.create`. The form shows the error itself and keeps the text; haptics only on the outcome. */
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
  send(sessionId: string, text: string, busy: 'queue' | 'steer', attachments: Attachment[] = []): Promise<boolean> {
    return done(run(() => request({ type: 'session.send', sessionId, text, busy, ...(attachments.length > 0 ? { attachments } : {}) })))
  },
  /** Runs an agent command chosen from "/" (`session.command`): the host adds the "command" row in the chat. */
  command(sessionId: string, name: string, args: string): Promise<boolean> {
    return done(run(() => request({ type: 'session.command', sessionId, name, args })))
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
