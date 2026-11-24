import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint, fromBase64Url, isValidMacKey, isValidPairing, parsePairingUrl } from './pairing-url.ts'

const KEY = '3mSP-mJHTIFJyI4OiYttXcEGG0kTg7ITIZkUlDWSqz4'

test('chiave del Mac: 32 byte in base64url', () => {
  assert.equal(fromBase64Url(KEY).length, 32)
  assert.equal(isValidMacKey(KEY), true)
  assert.equal(isValidMacKey(` ${KEY}\n`), true)
  assert.equal(isValidMacKey(''), false)
  assert.equal(isValidMacKey('troppo-corta'), false)
  assert.equal(isValidMacKey(KEY + 'AA'), false)
  assert.equal(isValidMacKey('chiave con spazi e simboli!!'), false)
})

test('un abbinamento incompleto non è valido (non sovrascrive quello buono)', () => {
  assert.equal(isValidPairing({ wsUrl: 'ws://127.0.0.1:7788', macKey: KEY }), true)
  assert.equal(isValidPairing({ wsUrl: 'wss://relay.example/x', macKey: KEY }), true)
  assert.equal(isValidPairing({ wsUrl: '', macKey: KEY }), false)
  assert.equal(isValidPairing({ wsUrl: 'http://127.0.0.1:7788', macKey: KEY }), false)
  assert.equal(isValidPairing({ wsUrl: 'ws://127.0.0.1:7788', macKey: '' }), false)
  assert.equal(isValidPairing({ wsUrl: 'ws://', macKey: KEY }), false)
})

test('codice QR provvisorio', () => {
  const url = `ladder://pair?k=${KEY}&u=${encodeURIComponent('ws://127.0.0.1:7788')}&n=${encodeURIComponent('Il mio Mac')}`
  assert.deepEqual(parsePairingUrl(url), { macKey: KEY, wsUrl: 'ws://127.0.0.1:7788', macName: 'Il mio Mac' })
  assert.equal(parsePairingUrl('https://example.com'), null)
  assert.equal(parsePairingUrl('ladder://pair?k=abc'), null)
  assert.equal(fingerprint(KEY), '3mSP -mJH TIFJ')
})
