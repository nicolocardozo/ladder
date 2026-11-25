// Hermes (RN 0.88, SDK 58) already has TextEncoder and a TextDecoder with `fatal` (verified on iOS and Android): only
// crypto.getRandomValues is missing, which @noble reads for the handshake's ephemeral Noise keys.
import * as Crypto from 'expo-crypto'

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } }

if (!g.crypto) g.crypto = {}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => Crypto.getRandomValues(array as never) as unknown as T
}
