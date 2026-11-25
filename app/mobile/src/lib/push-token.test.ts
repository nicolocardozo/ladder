import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedTokenStillValid, isTransientTokenError, notSetUpAfterTransient } from './push-token.ts'

test('Expo errors: network and server pass, the rest is final', () => {
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_NETWORK_ERROR' }), true)
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_SERVER_ERROR' }), true)
  assert.equal(isTransientTokenError({ code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }), false)
  assert.equal(isTransientTokenError(new Error('Default FirebaseApp is not initialized')), false)
  assert.equal(isTransientTokenError(null), false)
})

test('cached token: reused until the system token changes', () => {
  const cached = { token: 'ExponentPushToken[a]', device: 'dev1' }
  assert.equal(cachedTokenStillValid(cached), true)
  assert.equal(cachedTokenStillValid(cached, 'dev1'), true)
  assert.equal(cachedTokenStillValid(cached, 'dev2'), false)
  assert.equal(cachedTokenStillValid(null, 'dev1'), false)
  assert.equal(cachedTokenStillValid({ token: 't', device: null }, 'dev1'), false)
})

test('"not configured" only without a good token and after several attempts', () => {
  assert.equal(notSetUpAfterTransient(false, 1), false)
  assert.equal(notSetUpAfterTransient(false, 3), true)
  assert.equal(notSetUpAfterTransient(true, 10), false)
})
