// `data` di una notifica push di Ladder (RemotePushData): lettura, controllo e scelta di dove portare l'utente al tocco.
// Solo logica pura. Quello che arriva da fuori non è fidato: versione, tipo e forma si controllano, e il Mac deve essere il nostro.
// Import relativi: l'alias @shared non esiste fuori da Metro e questo file gira anche sotto `node`.
import type { PushKind, RemotePushData } from '../../../desktop/src/shared/protocol.ts'
import { pushMacId } from '../../../desktop/src/shared/remote/pairing.ts'

const KINDS: readonly PushKind[] = ['request', 'turn', 'error', 'agents']
/** Id di sessione e di richiesta sono brevi; un valore enorme non è nostro. */
const MAX_ID = 200

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

/** Legge `data` come RemotePushData; null se non lo è (versione diversa, campi mancanti o di tipo sbagliato). */
export function parsePushData(data: unknown): RemotePushData | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.v !== 1) return null
  if (typeof d.kind !== 'string' || !KINDS.includes(d.kind as PushKind)) return null
  if (!isId(d.sessionId) || !isId(d.mac)) return null
  if (d.itemId !== null && d.itemId !== undefined && !isId(d.itemId)) return null
  return { v: 1, kind: d.kind as PushKind, sessionId: d.sessionId, itemId: d.itemId ?? null, mac: d.mac }
}

export interface TapTarget {
  sessionId: string
  /** Richiesta da aprire (solo `kind: 'request'`). */
  requestId: string | null
}

/** Dove portare l'utente al tocco; null se la notifica non è nostra o è di un altro Mac (nessun Mac abbinato: sempre null). */
export function tapTarget(data: unknown, macKey: string | null): TapTarget | null {
  if (!macKey) return null
  const parsed = parsePushData(data)
  if (!parsed || parsed.mac !== pushMacId(macKey)) return null
  return { sessionId: parsed.sessionId, requestId: parsed.kind === 'request' ? parsed.itemId : null }
}
