// Mac identity for the remote channel: a Curve25519 key created once, in the app's data folder.
// The private key is never logged and never leaves this file; only the public one goes out (for pairing).
import { chmodSync, closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
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
  // A SyntaxError message may quote part of the text (the key): it is replaced with a generic one.
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
  // A file with loose permissions (copied by hand) is tightened to 0600.
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
  return pair
}

/** Reads the identity or creates it. Atomic creation: temporary 0600 file + link without overwriting, so two processes do not trample each other. */
export function loadOrCreateIdentity(dataDir: string): NoiseKeyPair {
  const path = join(dataDir, IDENTITY_FILE)
  const existing = read(path)
  if (existing) return existing
  const pair = generateKeyPair()
  const file: IdentityFile = { v: 1, publicKey: toBase64Url(pair.publicKey), secretKey: toBase64Url(pair.secretKey) }
  if (!createExclusive(path, JSON.stringify(file))) return read(path) ?? pair
  return pair
}

/** The Mac's public key if the identity already exists; does not create it (used to show the fingerprint while the channel is off). */
export function peekIdentityKey(dataDir: string): Uint8Array | null {
  return read(join(dataDir, IDENTITY_FILE))?.publicKey ?? null
}

/** Replaces a file with a new 0600 one (temporary file + rename: either the old or the new, never half of it). */
function replaceFile(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** "Regenerate key": a new Mac identity in place of the old one. Phones paired with the old key can no longer connect. */
export function regenerateIdentity(dataDir: string): NoiseKeyPair {
  const pair = generateKeyPair()
  const file: IdentityFile = { v: 1, publicKey: toBase64Url(pair.publicKey), secretKey: toBase64Url(pair.secretKey) }
  replaceFile(join(dataDir, IDENTITY_FILE), JSON.stringify(file))
  return pair
}

/** Writes a 0600 file without overwriting: temporary file + link. False if it already exists (another process created it an instant earlier). */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(tmp)
  }
}

// ── Relay key ────────────────────────────────────────────────────────────────
// A separate Ed25519 key, to prove to the relay that this is the Mac with that id. It does not enter the Noise handshake.
export const RELAY_KEY_FILE = 'remote-relay-key.json'

export interface RelayKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

function readRelayKey(path: string): RelayKeyPair | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let file: Partial<IdentityFile>
  try {
    file = JSON.parse(raw) as Partial<IdentityFile>
  } catch {
    throw new Error('Relay key file is not valid.')
  }
  if (file.v !== 1 || typeof file.secretKey !== 'string' || typeof file.publicKey !== 'string') throw new Error('Relay key file is not valid.')
  const secretKey = fromBase64Url(file.secretKey)
  if (secretKey.length !== 32) throw new Error('Relay key file is not valid.')
  const publicKey = ed25519.getPublicKey(secretKey)
  if (toBase64Url(publicKey) !== file.publicKey) throw new Error('Relay key file is not valid.')
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
  return { secretKey, publicKey }
}

/** Reads the relay key or creates it (same folder and permissions as the identity). */
export function loadOrCreateRelayKey(dataDir: string): RelayKeyPair {
  const path = join(dataDir, RELAY_KEY_FILE)
  const existing = readRelayKey(path)
  if (existing) return existing
  const secretKey = ed25519.utils.randomSecretKey()
  const publicKey = ed25519.getPublicKey(secretKey)
  const file: IdentityFile = { v: 1, publicKey: toBase64Url(publicKey), secretKey: toBase64Url(secretKey) }
  if (!createExclusive(path, JSON.stringify(file))) return readRelayKey(path) ?? { secretKey, publicKey }
  return { secretKey, publicKey }
}

/** "Regenerate key": a new relay key, hence a new Mac id on the relay. */
export function regenerateRelayKey(dataDir: string): RelayKeyPair {
  const secretKey = ed25519.utils.randomSecretKey()
  const publicKey = ed25519.getPublicKey(secretKey)
  const file: IdentityFile = { v: 1, publicKey: toBase64Url(publicKey), secretKey: toBase64Url(secretKey) }
  replaceFile(join(dataDir, RELAY_KEY_FILE), JSON.stringify(file))
  return { secretKey, publicKey }
}
