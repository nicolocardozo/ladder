// Tests of the pairing format: QR, fingerprint, base64url and signatures bound to the channel.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemotePairingPayload } from '../protocol.ts'
import { generateKeyPair } from './noise.ts'
import { decodePairingUrl, encodePairingUrl, fromBase64Url, generateDeviceKey, keyFingerprint, PAIRING_URL_PREFIX, signChannelBinding, toBase64Url, verifyChannelBinding } from './pairing.ts'

const payload = (over: Partial<RemotePairingPayload> = {}): RemotePairingPayload => ({
  v: 1,
  mac: 'Zoë’s Mac',
  key: toBase64Url(generateKeyPair().publicKey),
  relay: 'wss://relay.example',
  id: 'abc123',
  token: toBase64Url(new Uint8Array(32).fill(7)),
  exp: Date.now() + 1000,
  pw: true,
  ...over
})

test('base64url: matches Buffer for every length and rejects the rest', () => {
  for (let n = 0; n < 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
    const text = toBase64Url(bytes)
    assert.equal(text, Buffer.from(bytes).toString('base64url'))
    assert.deepEqual(fromBase64Url(text), bytes)
  }
  assert.throws(() => fromBase64Url('ab+/'))
  assert.throws(() => fromBase64Url('a'))
})

test('QR: encoding and reading round-trip, even with ws and surrounding spaces', () => {
  const p = payload({ ws: 'ws://127.0.0.1:7777' })
  const url = encodePairingUrl(p)
  assert.ok(url.startsWith(PAIRING_URL_PREFIX))
  assert.deepEqual(decodePairingUrl(`  ${url}\n`), p)
  const onlyWs = decodePairingUrl(encodePairingUrl(payload({ relay: undefined, id: undefined, ws: 'ws://127.0.0.1:1', pw: false })))
  assert.equal(onlyWs.relay, undefined)
  assert.equal(onlyWs.ws, 'ws://127.0.0.1:1')
})

test('QR: invalid forms rejected', () => {
  const enc = (o: unknown) => PAIRING_URL_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(o)))
  const good = payload()
  const bad: string[] = [
    '',
    'https://example.com',
    PAIRING_URL_PREFIX,
    PAIRING_URL_PREFIX + '***',
    enc(null),
    enc({ ...good, v: 2 }),
    enc({ ...good, key: 'AAAA' }),
    enc({ ...good, token: '' }),
    enc({ ...good, exp: 'x' }),
    enc({ ...good, pw: 'yes' }),
    enc({ ...good, relay: 'http://x' }),
    enc({ ...good, relay: undefined, id: undefined }),
    enc({ ...good, relay: undefined }),
    PAIRING_URL_PREFIX + 'A'.repeat(5000)
  ]
  for (const url of bad) assert.throws(() => decodePairingUrl(url), /Invalid pairing code/, url.slice(0, 50))
})

test('fingerprint: format "7F3A 91C2 · E04B 5D18", stable and different for different keys', () => {
  const a = generateKeyPair().publicKey
  const f = keyFingerprint(a)
  assert.match(f, /^[0-9A-F]{4} [0-9A-F]{4} · [0-9A-F]{4} [0-9A-F]{4}$/)
  assert.equal(f, keyFingerprint(a))
  assert.notEqual(f, keyFingerprint(generateKeyPair().publicKey))
})

test('signatures: bound to the handshake hash and to the type', () => {
  const key = generateDeviceKey()
  const hash = new Uint8Array(32).fill(1)
  const other = new Uint8Array(32).fill(2)
  const sig = signChannelBinding(key.secretKey, 'auth', hash)
  assert.equal(verifyChannelBinding(key.publicKey, 'auth', hash, sig), true)
  assert.equal(verifyChannelBinding(key.publicKey, 'auth', other, sig), false)
  assert.equal(verifyChannelBinding(key.publicKey, 'pair', hash, sig), false)
  assert.equal(verifyChannelBinding(generateDeviceKey().publicKey, 'auth', hash, sig), false)
  for (const junk of ['', 'x', '***', sig.slice(1)]) assert.equal(verifyChannelBinding(key.publicKey, 'auth', hash, junk), false)
})
