import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemotePairingPayload } from '../../../desktop/src/shared/protocol.ts'
import { encodePairingUrl, toBase64Url } from '../../../desktop/src/shared/remote/pairing.ts'
import { authNext } from './auth-errors.ts'
import { isPairingLink, payloadFingerprint, readPairingLink, routeOf } from './pair-link.ts'

const KEY = toBase64Url(new Uint8Array(32).fill(7))
const payload = (patch: Partial<RemotePairingPayload> = {}): RemotePairingPayload => ({ v: 1, mac: "Zoë's Mac", key: KEY, relay: 'wss://relay.example.com', id: 'abc123', token: 't'.repeat(43), exp: 2_000_000, pw: false, ...patch })

test('un link valido si legge', () => {
  const r = readPairingLink(encodePairingUrl(payload()), 1_000_000)
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.payload.mac, "Zoë's Mac")
})

test('link scaduto, malformato o di altro tipo', () => {
  assert.deepEqual(readPairingLink(encodePairingUrl(payload({ exp: 500 })), 1_000_000), { ok: false, reason: 'expired', mac: "Zoë's Mac" })
  assert.deepEqual(readPairingLink('ladder://pair#@@@', 1), { ok: false, reason: 'invalid' })
  assert.deepEqual(readPairingLink('https://example.com', 1), { ok: false, reason: 'invalid' })
  assert.deepEqual(readPairingLink('', 1), { ok: false, reason: 'invalid' })
  // Senza strada per raggiungere il Mac (né relay né ws) non è un abbinamento.
  assert.equal(readPairingLink(encodePairingUrl({ ...payload(), relay: undefined, id: undefined }), 1).ok, false)
  assert.equal(isPairingLink(' LADDER://pair#x'), true)
  assert.equal(isPairingLink('ladder://other'), false)
})

test('impronta e percorso mostrati nella conferma', () => {
  assert.match(payloadFingerprint(payload()), /^[0-9A-F]{4} [0-9A-F]{4} · [0-9A-F]{4} [0-9A-F]{4}$/)
  assert.deepEqual(routeOf(payload()), { kind: 'relay', host: 'relay.example.com' })
  assert.deepEqual(routeOf({ ws: 'ws://127.0.0.1:7777' }), { kind: 'direct', host: '127.0.0.1:7777' })
  // Relay senza id non è un percorso: ripiego sul ws.
  assert.deepEqual(routeOf({ relay: 'wss://r.example', ws: 'ws://10.0.2.2:1' }), { kind: 'direct', host: '10.0.2.2:1' })
})

test('ogni codice d\'errore ha un\'azione', () => {
  assert.equal(authNext('token-expired'), 'new-code')
  assert.equal(authNext('token-used'), 'new-code')
  assert.equal(authNext('bad-token'), 'new-code')
  assert.equal(authNext('too-many-attempts'), 'new-code')
  assert.equal(authNext('wrong-password'), 'password')
  assert.equal(authNext('password-required'), 'password')
  assert.equal(authNext('device-revoked'), 'pair-again')
  assert.equal(authNext('unknown-device'), 'pair-again')
  assert.equal(authNext('bad-signature'), 'pair-again')
  assert.equal(authNext('remote-disabled'), 'later')
  assert.equal(authNext('invalid-request'), 'later')
})

test('senza relay (solo WebSocket diretto) un codice si accetta solo con allowDirect', () => {
  const direct = encodePairingUrl({ ...payload(), relay: undefined, id: undefined, ws: 'ws://127.0.0.1:7777' })
  assert.deepEqual(readPairingLink(direct, 1_000_000), { ok: false, reason: 'no-relay', mac: "Zoë's Mac" })
  assert.equal(readPairingLink(direct, 1_000_000, { allowDirect: false }).ok, false)
  assert.equal(readPairingLink(direct, 1_000_000, { allowDirect: true }).ok, true)
  // Un codice con relay vale sempre.
  assert.equal(readPairingLink(encodePairingUrl(payload()), 1_000_000).ok, true)
  // Scaduto vince su tutto.
  assert.equal(readPairingLink(encodePairingUrl({ ...payload(), exp: 5 }), 1_000_000, { allowDirect: true }).ok, false)
})
