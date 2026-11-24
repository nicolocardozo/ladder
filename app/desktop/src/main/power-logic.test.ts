import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteIsOn, staysInBackground, wantKeepAwake } from './power-logic.ts'

test('wantKeepAwake: serve la preferenza e almeno una sessione o un telefono', () => {
  assert.equal(wantKeepAwake(true, 0, 0), false)
  assert.equal(wantKeepAwake(true, 1, 0), true)
  assert.equal(wantKeepAwake(true, 0, 1), true)
  assert.equal(wantKeepAwake(false, 3, 2), false)
})

test('remoteIsOn: le variabili di sviluppo contano solo fuori dall’app pacchettizzata', () => {
  assert.equal(remoteIsOn(false, false, {}), false)
  assert.equal(remoteIsOn(false, false, { LADDER_REMOTE_PORT: '9000' }), true)
  assert.equal(remoteIsOn(false, false, { LADDER_RELAY_URL: 'wss://x' }), true)
  assert.equal(remoteIsOn(false, true, { LADDER_REMOTE_PORT: '9000' }), false)
  assert.equal(remoteIsOn(true, true, {}), true)
})

test('staysInBackground: solo macOS con il canale acceso', () => {
  assert.equal(staysInBackground('darwin', true), true)
  assert.equal(staysInBackground('darwin', false), false)
  assert.equal(staysInBackground('linux', true), false)
})
