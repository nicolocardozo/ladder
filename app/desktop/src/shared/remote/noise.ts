// Noise_NK_25519_ChaChaPoly_SHA256 (Noise spec rev 34), plain TypeScript: only Uint8Array, no Node or DOM APIs,
// so the same file also runs on React Native / Hermes.
// NK: the responder (the Mac) has a static key known in advance to the initiator (the phone, which received it from the QR).
//   <- s
//   ...
//   -> e, es
//   <- e, ee
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const NOISE_PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_SHA256'
import { NOISE_MAX_MESSAGE } from './limits.ts'

export { NOISE_MAX_MESSAGE }
export const NOISE_TAG_LEN = 16
const DH_LEN = 32
const HASH_LEN = 32

export interface NoiseKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

const EMPTY = new Uint8Array(0)
const encoder = new TextEncoder()

export function generateKeyPair(): NoiseKeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function keyPairFromSecret(secretKey: Uint8Array): NoiseKeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** X25519 DH; noble rejects low-order points (all-zero result), which become an error here. */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey)
}

/** Noise HKDF (§4.3) with 2 outputs: chained HMAC-HASH, equivalent to HKDF-SHA256 with empty info. */
function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, chainingKey, input)
  const out1 = hmac(sha256, temp, Uint8Array.of(1))
  const out2 = hmac(sha256, temp, concat(out1, Uint8Array.of(2)))
  return [out1, out2]
}

/** CipherState (§5.1): key + 64-bit counter. ChaChaPoly nonce = 4 zero bytes + little-endian counter. */
export class CipherState {
  private k: Uint8Array | null
  private n = 0n

  constructor(key: Uint8Array | null = null) {
    this.k = key
  }

  hasKey(): boolean {
    return this.k !== null
  }

  private nonce(): Uint8Array {
    // 2^64-1 is reserved by the spec: beyond it the key would have to change; here the session ends.
    if (this.n >= 0xffff_ffff_ffff_ffffn) throw new Error('Noise: nonce esaurito')
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, this.n, true)
    return nonce
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext
    if (plaintext.length + NOISE_TAG_LEN > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    const out = chacha20poly1305(this.k, this.nonce(), ad).encrypt(plaintext)
    this.n++
    return out
  }

  /** Throws if the tag does not match; the counter advances only after successful decryption (§5.1). */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext
    if (ciphertext.length > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    if (ciphertext.length < NOISE_TAG_LEN) throw new Error('Noise: messaggio troppo corto')
    const out = chacha20poly1305(this.k, this.nonce(), ad).decrypt(ciphertext)
    this.n++
    return out
  }
}

/** SymmetricState (§5.2). */
class SymmetricState {
  h: Uint8Array
  private ck: Uint8Array
  private cipher = new CipherState()

  constructor(protocolName: string) {
    const name = encoder.encode(protocolName)
    this.h = name.length <= HASH_LEN ? concat(name, new Uint8Array(HASH_LEN - name.length)) : sha256(name)
    this.ck = this.h
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data))
  }

  mixKey(input: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, input)
    this.ck = ck
    this.cipher = new CipherState(k)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ct)
    return ct
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return pt
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY)
    return [new CipherState(k1), new CipherState(k2)]
  }
}

/**
 * Transport channel after the handshake. After any error (failed decryption, message too long) the channel is
 * broken forever: out-of-order, repeated, reflected or tampered messages are not "skipped", they close the connection.
 */
export class NoiseTransport {
  private broken = false
  private readonly sendCipher: CipherState
  private readonly recvCipher: CipherState
  /** Handshake hash (§11.2): identical on both sides, useful for channel binding. */
  readonly handshakeHash: Uint8Array

  constructor(sendCipher: CipherState, recvCipher: CipherState, handshakeHash: Uint8Array) {
    this.sendCipher = sendCipher
    this.recvCipher = recvCipher
    this.handshakeHash = handshakeHash
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.broken) throw new Error('Noise: canale chiuso')
    try {
      return this.sendCipher.encryptWithAd(EMPTY, plaintext)
    } catch (error) {
      this.broken = true
      throw error
    }
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.broken) throw new Error('Noise: canale chiuso')
    try {
      return this.recvCipher.decryptWithAd(EMPTY, ciphertext)
    } catch (error) {
      this.broken = true
      throw error
    }
  }
}

export interface InitiatorOptions {
  prologue: Uint8Array
  /** The responder's static public key, known in advance (pre-message `<- s`). */
  remoteStatic: Uint8Array
  /** Tests with known vectors only: the ephemeral key is generated by itself. */
  ephemeral?: NoiseKeyPair
}

/** Phone side: `writeMessage1` (-> e, es) then `readMessage2` (<- e, ee). */
export class NoiseInitiator {
  private readonly ss: SymmetricState
  private readonly e: NoiseKeyPair
  private readonly rs: Uint8Array
  private step: 0 | 1 | 2 = 0

  constructor(options: InitiatorOptions) {
    if (options.remoteStatic.length !== DH_LEN) throw new Error('Noise: chiave del Mac non valida')
    this.rs = options.remoteStatic
    this.e = options.ephemeral ?? generateKeyPair()
    this.ss = new SymmetricState(NOISE_PROTOCOL_NAME)
    this.ss.mixHash(options.prologue)
    this.ss.mixHash(this.rs) // <- s
  }

  writeMessage1(payload: Uint8Array): Uint8Array {
    if (this.step !== 0) throw new Error('Noise: handshake fuori sequenza')
    this.step = 1
    this.ss.mixHash(this.e.publicKey)
    this.ss.mixKey(dh(this.e.secretKey, this.rs)) // es
    const message = concat(this.e.publicKey, this.ss.encryptAndHash(payload))
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    return message
  }

  readMessage2(message: Uint8Array): { payload: Uint8Array; transport: NoiseTransport } {
    if (this.step !== 1) throw new Error('Noise: handshake fuori sequenza')
    this.step = 2
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    if (message.length < DH_LEN + NOISE_TAG_LEN) throw new Error('Noise: messaggio troppo corto')
    const re = message.subarray(0, DH_LEN)
    this.ss.mixHash(re)
    this.ss.mixKey(dh(this.e.secretKey, re)) // ee
    const payload = this.ss.decryptAndHash(message.subarray(DH_LEN))
    const [c1, c2] = this.ss.split()
    // The initiator sends with c1 and receives with c2.
    return { payload, transport: new NoiseTransport(c1, c2, this.ss.h) }
  }
}

export interface ResponderOptions {
  prologue: Uint8Array
  /** The Mac's static key. */
  staticKey: NoiseKeyPair
  /** Tests with known vectors only. */
  ephemeral?: NoiseKeyPair
}

/** Mac side: `readMessage1` (-> e, es), the caller checks the payload, then `writeMessage2` (<- e, ee). */
export class NoiseResponder {
  private readonly ss: SymmetricState
  private readonly e: NoiseKeyPair
  private readonly s: NoiseKeyPair
  private re: Uint8Array | null = null
  private step: 0 | 1 | 2 = 0

  constructor(options: ResponderOptions) {
    this.s = options.staticKey
    this.e = options.ephemeral ?? generateKeyPair()
    this.ss = new SymmetricState(NOISE_PROTOCOL_NAME)
    this.ss.mixHash(options.prologue)
    this.ss.mixHash(this.s.publicKey) // <- s
  }

  readMessage1(message: Uint8Array): Uint8Array {
    if (this.step !== 0) throw new Error('Noise: handshake fuori sequenza')
    this.step = 1
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    if (message.length < DH_LEN + NOISE_TAG_LEN) throw new Error('Noise: messaggio troppo corto')
    // Copy: the client's key stays valid even if the network buffer is reused.
    this.re = message.slice(0, DH_LEN)
    this.ss.mixHash(this.re)
    this.ss.mixKey(dh(this.s.secretKey, this.re)) // es
    return this.ss.decryptAndHash(message.subarray(DH_LEN))
  }

  writeMessage2(payload: Uint8Array): { message: Uint8Array; transport: NoiseTransport } {
    if (this.step !== 1 || !this.re) throw new Error('Noise: handshake fuori sequenza')
    this.step = 2
    this.ss.mixHash(this.e.publicKey)
    this.ss.mixKey(dh(this.e.secretKey, this.re)) // ee
    const message = concat(this.e.publicKey, this.ss.encryptAndHash(payload))
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: messaggio troppo lungo')
    const [c1, c2] = this.ss.split()
    // The responder sends with c2 and receives with c1.
    return { message, transport: new NoiseTransport(c2, c1, this.ss.h) }
  }
}
