import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedTokenStillValid, isTransientTokenError, notSetUpAfterTransient } from './push-token.ts'

test('errori di Expo: rete e server passano, il resto è definitivo', () => {
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_NETWORK_ERROR' }), true)
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_SERVER_ERROR' }), true)
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }), false)
  assert.equal(isTransientTokenError(new Error('Default FirebaseApp is not initialized')), false)
  assert.equal(isTransientTokenError(null), false)
})

test('token in cache: si riusa finché il token di sistema non cambia', () => {
  const cached = { token: 'ExponentPushToken[a]', device: 'dev1' }
  assert.equal(cachedTokenStillValid(cached), true)
  assert.equal(cachedTokenStillValid(cached, 'dev1'), true)
  assert.equal(cachedTokenStillValid(cached, 'dev2'), false)
  assert.equal(cachedTokenStillValid(null, 'dev1'), false)
  assert.equal(cachedTokenStillValid({ token: 't', device: null }, 'dev1'), false)
})

test('"non configurato" solo senza token buono e dopo più tentativi', () => {
  assert.equal(notSetUpAfterTransient(false, 1), false)
  assert.equal(notSetUpAfterTransient(false, 3), true)
  assert.equal(notSetUpAfterTransient(true, 10), false)
})
