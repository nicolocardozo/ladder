// Quando un evento diventa un push sul telefono (LAD-53): decisioni pure, niente Electron, così si provano con node --test.
// Lo decide il main perché solo lui sa se stai usando il Mac; l'host poi filtra per dispositivo (preferenze, fascia silenziosa, app aperta).
import type { AttentionEvent, PushEvent, WindowView } from '../shared/protocol.ts'

/**
 * Sul Mac attivo negli ultimi 3 minuti (tastiera, mouse) niente push: le notifiche del Mac bastano, come in Paseo.
 * Con lo schermo bloccato si manda comunque: sei lì davanti ma non vedi niente, e i 3 minuti non dicono che stai guardando
 * (il blocco può scattare subito dopo l'ultima attività, e per lo screen lock l'inattività non si azzera finché non sblocchi).
 */
export const PUSH_IDLE_SECONDS = 180
/** I turni più brevi di un minuto non notificano (né sul Mac, né sul telefono). */
export const TURN_MIN_MS = 60_000

export interface PushContext {
  /** Vista della finestra in primo piano; null se Ladder non è l'app attiva. */
  view: WindowView | null
  /** Secondi dall'ultimo input dell'utente sul Mac (powerMonitor.getSystemIdleTime). */
  idleSeconds: number
  /** Schermo bloccato (powerMonitor lock-screen / unlock-screen). */
  locked: boolean
  /** "Non disturbare" di Ladder (AppPrefs.dndUntil): vale anche per i telefoni. */
  dndUntil: number | null
  now: number
}

/** Lo stai guardando adesso sul Mac: finestra attiva e sessione visibile (in qualunque colonna). */
export function isWatching(view: WindowView | null, sessionId: string): boolean {
  if (!view) return false
  return view.visibleSessionIds?.includes(sessionId) ?? view.sessionId === sessionId
}

/** L'evento va ai telefoni? Restituisce l'evento senza testi, o null. `resolved` non manda mai nulla. */
export function pushFor(event: AttentionEvent, ctx: PushContext): PushEvent | null {
  if (event.kind === 'resolved') return null
  if (event.kind === 'turn' && event.durationMs < TURN_MIN_MS) return null
  if (ctx.dndUntil && ctx.dndUntil > ctx.now) return null
  // Schermo bloccato: la finestra può restare "in primo piano" sulla sessione, ma non la stai guardando.
  if (ctx.locked) return { kind: event.kind, sessionId: event.sessionId, itemId: event.itemId }
  if (isWatching(ctx.view, event.sessionId)) return null
  if (ctx.idleSeconds < PUSH_IDLE_SECONDS) return null
  return { kind: event.kind, sessionId: event.sessionId, itemId: event.itemId }
}
