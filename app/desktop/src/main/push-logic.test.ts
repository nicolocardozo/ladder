import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttentionEvent } from '../shared/protocol.ts'
import { isWatching, PUSH_IDLE_SECONDS, pushFor, type PushContext } from './push-logic.ts'

const ctx = (over: Partial<PushContext> = {}): PushContext => ({ view: null, idleSeconds: 600, locked: false, dndUntil: null, now: 1_000, ...over })
const request: AttentionEvent = { kind: 'request', sessionId: 's1', projectId: 'p1', itemId: 'q1', title: 'Project · Secret title', body: 'rm -rf secret' }
const turn: AttentionEvent = { kind: 'turn', sessionId: 's1', projectId: 'p1', projectName: 'P', itemId: 't1', durationMs: 90_000, title: 'T' }

test('pushFor: Mac inattivo e sessione non guardata → push senza testi', () => {
  assert.deepEqual(pushFor(request, ctx()), { kind: 'request', sessionId: 's1', itemId: 'q1' })
  assert.equal(JSON.stringify(pushFor(request, ctx())).includes('secret'), false)
  assert.deepEqual(pushFor({ kind: 'error', sessionId: 's2', projectId: 'p', itemId: null, title: 'x', body: 'y' }, ctx()), { kind: 'error', sessionId: 's2', itemId: null })
  assert.equal(pushFor({ kind: 'agents', sessionId: 's2', projectId: 'p', projectName: 'P', itemId: 'i', outcome: 'failed', finished: 1, failed: 1, title: 'x', body: 'y' }, ctx())?.kind, 'agents')
})

test('pushFor: `resolved` non manda mai nulla', () => {
  assert.equal(pushFor({ kind: 'resolved', sessionId: 's1', itemId: 'q1' }, ctx()), null)
})

test('pushFor: Mac usato negli ultimi 3 minuti → niente', () => {
  assert.equal(pushFor(request, ctx({ idleSeconds: PUSH_IDLE_SECONDS - 1 })), null)
  assert.notEqual(pushFor(request, ctx({ idleSeconds: PUSH_IDLE_SECONDS })), null)
})

test('pushFor: schermo bloccato → si manda anche se l’inattività è breve', () => {
  assert.notEqual(pushFor(request, ctx({ idleSeconds: 5, locked: true })), null)
})

test('pushFor: sessione visibile nella finestra in primo piano → niente, anche se bloccato non può essere', () => {
  assert.equal(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's1' } })), null)
  // Colonne affiancate: conta l'elenco delle visibili, non solo l'attiva.
  assert.equal(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's9', visibleSessionIds: ['s9', 's1'] } })), null)
  // Altra sessione davanti: si manda.
  assert.notEqual(pushFor(request, ctx({ view: { projectId: 'p1', sessionId: 's9', visibleSessionIds: ['s9'] } })), null)
  assert.equal(isWatching(null, 's1'), false)
})

test('pushFor: schermo bloccato → si manda anche se la sessione è visibile nella finestra', () => {
  assert.notEqual(pushFor(request, ctx({ locked: true, idleSeconds: 1, view: { projectId: 'p1', sessionId: 's1', visibleSessionIds: ['s1'] } })), null)
  assert.equal(pushFor({ kind: 'resolved', sessionId: 's1', itemId: 'q1' }, ctx({ locked: true })), null)
  assert.equal(pushFor({ ...turn, durationMs: 1 } as AttentionEvent, ctx({ locked: true })), null)
})

test('pushFor: turni brevi non notificano, come sul Mac', () => {
  assert.equal(pushFor({ ...turn, durationMs: 59_999 } as AttentionEvent, ctx()), null)
  assert.notEqual(pushFor(turn, ctx()), null)
})

test('pushFor: "Non disturbare" di Ladder vale anche per i telefoni', () => {
  assert.equal(pushFor(request, ctx({ dndUntil: 5_000 })), null)
  assert.notEqual(pushFor(request, ctx({ dndUntil: 500 })), null)
})
