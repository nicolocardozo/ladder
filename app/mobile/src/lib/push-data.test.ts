import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushMacId, toBase64Url } from '../../../desktop/src/shared/remote/pairing.ts'
import { parsePushData, tapTarget } from './push-data.ts'

const KEY = toBase64Url(new Uint8Array(32).fill(9))
const OTHER = toBase64Url(new Uint8Array(32).fill(3))
const data = (patch: Record<string, unknown> = {}) => ({ v: 1, kind: 'request', sessionId: 's1', itemId: 'rq1', mac: pushMacId(KEY), ...patch })

test('valid data', () => {
  assert.deepEqual(parsePushData(data()), data())
  assert.equal(parsePushData(data({ itemId: null }))?.itemId, null)
  assert.equal(parsePushData(data({ itemId: undefined }))?.itemId, null)
})

test('invalid data: version, type, fields', () => {
  assert.equal(parsePushData(null), null)
  assert.equal(parsePushData('x'), null)
  assert.equal(parsePushData(data({ v: 2 })), null)
  assert.equal(parsePushData(data({ kind: 'resolved' })), null)
  assert.equal(parsePushData(data({ sessionId: '' })), null)
  assert.equal(parsePushData(data({ sessionId: 5 })), null)
  assert.equal(parsePushData(data({ itemId: 7 })), null)
  assert.equal(parsePushData(data({ mac: undefined })), null)
  assert.equal(parsePushData(data({ sessionId: 'x'.repeat(201) })), null)
})

test('tap: the right Mac is required', () => {
  assert.deepEqual(tapTarget(data(), KEY), { sessionId: 's1', requestId: 'rq1' })
  assert.equal(tapTarget(data(), OTHER), null)
  assert.equal(tapTarget(data(), null), null)
  assert.equal(tapTarget({ ...data(), mac: 'AAAAAAAAAAAAAAAA' }, KEY), null)
})

test('tap: the request opens only for kind request', () => {
  assert.deepEqual(tapTarget(data({ kind: 'turn', itemId: 'it9' }), KEY), { sessionId: 's1', requestId: null })
  assert.deepEqual(tapTarget(data({ kind: 'request', itemId: null }), KEY), { sessionId: 's1', requestId: null })
})
