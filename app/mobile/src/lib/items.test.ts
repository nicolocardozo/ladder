import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { reasonKind } from './connection.ts'
import { applyItemsEvent, mergeById, mergeSnapshotSessions, PAGE_SIZE } from './items.ts'

const item = (seq: number, text = String(seq)): ChatItem => ({ id: `i${seq}`, turnId: 't', seq, at: seq, kind: 'assistant', text, streaming: false })

test('mergeById sorts by seq and updates by id', () => {
  const merged = mergeById([item(2), item(1)], [item(2, 'nuovo'), item(3)])
  assert.deepEqual(merged.map((i) => i.seq), [1, 2, 3])
  assert.equal((merged[1] as { text: string }).text, 'nuovo')
})

test('replace with a full page leaves older history loadable', () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => item(100 + i))
  const r = applyItemsEvent([item(1), item(2)], false, page, true)
  assert.equal(r.items.length, PAGE_SIZE)
  assert.equal(r.items[0].seq, 100)
  assert.equal(r.hasMore, true)
})

test('replace with a short page: the chat is complete', () => {
  const r = applyItemsEvent([item(1), item(2), item(3)], true, [item(2), item(3)], true)
  assert.equal(r.hasMore, false)
  assert.deepEqual(r.items.map((i) => i.seq), [2, 3])
})

test('without replace items are merged and hasMore does not change', () => {
  const r = applyItemsEvent([item(5)], true, [item(6)], false)
  assert.equal(r.hasMore, true)
  assert.deepEqual(r.items.map((i) => i.seq), [5, 6])
})

test('reasonKind recognizes the categories and hides the rest', () => {
  assert.equal(reasonKind('Timed out'), 'timeout')
  assert.equal(reasonKind('The Mac did not answer in time.'), 'timeout')
  assert.equal(reasonKind('Connection failed'), 'refused')
  assert.equal(reasonKind('Connection lost'), 'lost')
  assert.equal(reasonKind('Remote: frame MORE non pieno'), 'secure')
  assert.equal(reasonKind('Noise: decrypt failed'), 'secure')
  assert.equal(reasonKind(undefined), null)
  assert.equal(reasonKind('boh'), null)
})

const session = (id: string, projectId: string, archived = false): SessionSummary => ({ id, projectId, archived }) as unknown as SessionSummary

test('a new snapshot does not drop archived sessions already read', () => {
  const prev = { a1: session('a1', 'p1', true), a2: session('a2', 'gone', true), s1: session('s1', 'p1') }
  const merged = mergeSnapshotSessions(prev, [session('s2', 'p1'), session('a1', 'p1', false)], ['p1'])
  // s1 is no longer in the snapshot (archived or gone without us reading it): dropped. a2 belongs to a vanished project: dropped.
  // The snapshot reports a1 as active: the snapshot wins.
  assert.deepEqual(Object.keys(merged).sort(), ['a1', 's2'])
  assert.equal(merged.a1.archived, false)
  const kept = mergeSnapshotSessions({ a3: session('a3', 'p1', true) }, [session('s2', 'p1')], ['p1'])
  assert.deepEqual(Object.keys(kept).sort(), ['a3', 's2'])
})
