// Hermes (RN 0.88, SDK 58) ha già TextEncoder e un TextDecoder con `fatal` (verificato su iOS e Android): manca
// solo crypto.getRandomValues, che @noble legge per le chiavi effimere dell'handshake Noise.
import * as Crypto from 'expo-crypto'

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } }

if (!g.crypto) g.crypto = {}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => Crypto.getRandomValues(array as never) as unknown as T
}
