// Identità del Mac per il canale remoto: una chiave Curve25519 creata una volta sola, nella cartella dati dell'app.
// La chiave privata non si logga e non esce da questo file; fuori va solo quella pubblica (per l'abbinamento, LAD-51).
import { chmodSync, closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { generateKeyPair, keyPairFromSecret, type NoiseKeyPair } from '../../shared/remote/noise.ts'

export const IDENTITY_FILE = 'remote-identity.json'

interface IdentityFile {
  v: 1
  /** Base64url, 32 byte. */
  publicKey: string
  secretKey: string
}

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'))

function read(path: string): NoiseKeyPair | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  // Il messaggio di un SyntaxError può citare un pezzo del testo (la chiave): si sostituisce con uno generico.
  let file: Partial<IdentityFile>
  try {
    file = JSON.parse(raw) as Partial<IdentityFile>
  } catch {
    throw new Error('Remote identity file is not valid.')
  }
  if (file.v !== 1 || typeof file.secretKey !== 'string' || typeof file.publicKey !== 'string') throw new Error('Remote identity file is not valid.')
  const secretKey = fromBase64Url(file.secretKey)
  if (secretKey.length !== 32) throw new Error('Remote identity file is not valid.')
  const pair = keyPairFromSecret(secretKey)
  if (toBase64Url(pair.publicKey) !== file.publicKey) throw new Error('Remote identity file is not valid.')
  // Un file con permessi larghi (copiato a mano) si stringe a 0600.
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
  return pair
}

/** Legge l'identità o la crea. Creazione atomica: file temporaneo 0600 + link senza sovrascrivere, così due processi non si calpestano. */
export function loadOrCreateIdentity(dataDir: string): NoiseKeyPair {
  const path = join(dataDir, IDENTITY_FILE)
  const existing = read(path)
  if (existing) return existing
  const pair = generateKeyPair()
  const file: IdentityFile = { v: 1, publicKey: toBase64Url(pair.publicKey), secretKey: toBase64Url(pair.secretKey) }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify(file))
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
  } catch (error) {
    // Un altro processo l'ha creata un istante prima: vale la sua.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read(path) ?? pair
    throw error
  } finally {
    unlinkSync(tmp)
  }
  return pair
}
