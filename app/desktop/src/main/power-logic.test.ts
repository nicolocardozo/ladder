import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteIsOn, staysInBackground, wantKeepAwake } from './power-logic.ts'

test('wantKeepAwake: needs the preference and at least one session or phone', () => {
  assert.equal(wantKeepAwake(true, 0, 0), false)
  assert.equal(wantKeepAwake(true, 1, 0), true)
  assert.equal(wantKeepAwake(true, 0, 1), true)
  assert.equal(wantKeepAwake(false, 3, 2), false)
})

test('remoteIsOn: development variables only count outside the packaged app', () => {
  assert.equal(remoteIsOn(false, false, {}), false)
  assert.equal(remoteIsOn(false, false, { LADDER_REMOTE_PORT: '9000' }), true)
  assert.equal(remoteIsOn(false, false, { LADDER_RELAY_URL: 'wss://x' }), true)
  assert.equal(remoteIsOn(false, true, { LADDER_REMOTE_PORT: '9000' }), false)
  assert.equal(remoteIsOn(true, true, {}), true)
})

test('staysInBackground: macOS only, with the channel on', () => {
  assert.equal(staysInBackground('darwin', true), true)
  assert.equal(staysInBackground('darwin', false), false)
  assert.equal(staysInBackground('linux', true), false)
})
