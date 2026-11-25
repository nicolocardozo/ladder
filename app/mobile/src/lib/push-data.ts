// `data` of a Ladder push notification (RemotePushData): reading, validation and choice of where to take the user on tap.
// Pure logic only. What comes from outside is not trusted: version, type and shape are checked, and the Mac must be ours.
// Relative imports: the @shared alias does not exist outside Metro and this file also runs under `node`.
import type { PushKind, RemotePushData } from '../../../desktop/src/shared/protocol.ts'
import { pushMacId } from '../../../desktop/src/shared/remote/pairing.ts'

const KINDS: readonly PushKind[] = ['request', 'turn', 'error', 'agents']
/** Session and request ids are short; a huge value is not ours. */
const MAX_ID = 200

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

/** Reads `data` as RemotePushData; null if it is not one (different version, missing or wrongly typed fields). */
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
  /** Request to open (only `kind: 'request'`). */
  requestId: string | null
}

/** Where to take the user on tap; null if the notification is not ours or is from another Mac (no paired Mac: always null). */
export function tapTarget(data: unknown, macKey: string | null): TapTarget | null {
  if (!macKey) return null
  const parsed = parsePushData(data)
  if (!parsed || parsed.mac !== pushMacId(macKey)) return null
  return { sessionId: parsed.sessionId, requestId: parsed.kind === 'request' ? parsed.itemId : null }
}
