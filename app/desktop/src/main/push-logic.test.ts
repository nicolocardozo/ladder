import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttentionEvent } from '../shared/protocol.ts'
import { isWatching, PUSH_IDLE_SECONDS, pushFor, type PushContext } from './push-logic.ts'

const ctx = (over: Partial<PushContext> = {}): PushContext => ({ view: null, idleSeconds: 600, locked: false, dndUntil: null, now: 1_000, ...over })
const request: AttentionEvent = { kind: 'request', sessionId: 's1', projectId: 'p1', itemId: 'q1', title: 'Project · Secret title', body: 'rm -rf secret' }
const turn: AttentionEvent = { kind: 'turn', sessionId: 's1', projectId: 'p1', projectName: 'P', itemId: 't1', durationMs: 90_000, title: 'T' }

test('pushFor: idle Mac and unwatched session → push without text', () => {
  assert.deepEqual(pushFor(request, ctx()), { kind: 'request', sessionId: 's1', itemId: 'q1' })
  assert.equal(JSON.stringify(pushFor(request, ctx())).includes('secret'), false)
  assert.deepEqual(pushFor({ kind: 'error', sessionId: 's2', projectId: 'p', itemId: null, title: 'x', body: 'y' }, ctx()), { kind: 'error', sessionId: 's2', itemId: null })
  assert.equal(pushFor({ kind: 'agents', sessionId: 's2', projectId: 'p', projectName: 'P', itemId: 'i', outcome: 'failed', finished: 1, failed: 1, title: 'x', body: 'y' }, ctx())?.kind, 'agents')
})

test('pushFor: `resolved` never sends anything', () => {
  assert.equal(pushFor({ kind: 'resolved', sessionId: 's1', itemId: 'q1' }, ctx()), null)
})

test('pushFor: Mac used in the last 3 minutes → nothing', () => {
  assert.equal(pushFor(request, ctx({ idleSeconds: PUSH_IDLE_SECONDS - 1 })), null)
  assert.notEqual(pushFor(request, ctx({ idleSeconds: PUSH_IDLE_SECONDS })), null)
})

test('pushFor: locked screen → sends even if idle time is short', () => {
  assert.notEqual(pushFor(request, ctx({ idleSeconds: 5, locked: true })), null)
})

test('pushFor: session visible in the foreground window → nothing (the screen cannot be locked in that case)', () => {
  assert.equal(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's1' } })), null)
  // Side-by-side columns: the list of visible ones counts, not just the active one.
  assert.equal(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's9', visibleSessionIds: ['s9', 's1'] } })), null)
  // Another session in front: it is sent.
  assert.notEqual(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's9', visibleSessionIds: ['s9'] } })), null)
  assert.equal(isWatching(null, 's1'), false)
})

test('pushFor: locked screen → sends even if the session is visible in the window', () => {
  assert.notEqual(pushFor(request, ctx({ locked: true, idleSeconds: 1, view: { projectId: 'p1', sessionId: 's1', visibleSessionIds: ['s1'] } })), null)
  assert.equal(pushFor({ kind: 'resolved', sessionId: 's1', itemId: 'q1' }, ctx({ locked: true })), null)
  assert.equal(pushFor({ ...turn, durationMs: 1 } as AttentionEvent, ctx({ locked: true })), null)
})

test('pushFor: short turns do not notify, as on the Mac', () => {
  assert.equal(pushFor({ ...turn, durationMs: 59_999 } as AttentionEvent, ctx()), null)
  assert.notEqual(pushFor(turn, ctx()), null)
})

test('pushFor: Ladder’s "Do not disturb" also applies to phones', () => {
  assert.equal(pushFor(request, ctx({ dndUntil: 5_000 })), null)
  assert.notEqual(pushFor(request, ctx({ dndUntil: 500 })), null)
})
