import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ChatItem } from '../../shared/protocol.ts'
import { pageItems } from './paging.ts'

const item = (seq: number): ChatItem => ({ id: `i${seq}`, seq, kind: 'user', text: `m${seq}` }) as unknown as ChatItem

function seeded(count: number): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('create table items (session_id text, id text, seq integer, json text, primary key (session_id, id)); create index items_by_seq on items (session_id, seq)')
  const insert = db.prepare('insert into items (session_id, id, seq, json) values (?, ?, ?, ?)')
  for (let seq = 1; seq <= count; seq++) insert.run('s', `i${seq}`, seq, JSON.stringify(item(seq)))
  insert.run('other', 'x', 1, JSON.stringify(item(1)))
  return db
}

const liveOf = (count: number): Map<string, ChatItem> => new Map(Array.from({ length: count }, (_, i) => [`i${i + 1}`, item(i + 1)] as const))
const seqs = (p: { items: ChatItem[] }) => p.items.map((i) => i.seq)

for (const mode of ['database', 'memoria']) {
  test(`pages from the end backwards (${mode})`, () => {
    const db = seeded(150)
    const live = mode === 'memoria' ? liveOf(150) : undefined
    const first = pageItems(db, live, 's')
    assert.equal(first.items.length, 60)
    assert.deepEqual([seqs(first)[0], seqs(first).at(-1)], [91, 150])
    assert.equal(first.hasMore, true)
    const second = pageItems(db, live, 's', 91, 60)
    assert.deepEqual([seqs(second)[0], seqs(second).at(-1)], [31, 90])
    assert.equal(second.hasMore, true)
    const third = pageItems(db, live, 's', 31, 60)
    assert.deepEqual([seqs(third)[0], seqs(third).at(-1)], [1, 30])
    assert.equal(third.hasMore, false)
    // Exactly finished: no phantom "hasMore".
    assert.equal(pageItems(db, live, 's', 61, 60).hasMore, false)
    assert.equal(pageItems(db, live, 's', 62, 60).hasMore, true)
  })

  test(`limit: maximum 200, minimum 1, odd values (${mode})`, () => {
    const db = seeded(300)
    const live = mode === 'memoria' ? liveOf(300) : undefined
    assert.equal(pageItems(db, live, 's', undefined, 10_000).items.length, 200)
    assert.equal(pageItems(db, live, 's', undefined, 0).items.length, 1)
    assert.equal(pageItems(db, live, 's', undefined, -5).items.length, 1)
    assert.equal(pageItems(db, live, 's', undefined, Number.NaN).items.length, 60)
    assert.equal(pageItems(db, live, 's', 1).items.length, 0)
  })
}

test('in-memory session: sees items not yet saved', () => {
  const db = seeded(3)
  assert.deepEqual(seqs(pageItems(db, liveOf(4), 's')), [1, 2, 3, 4])
  assert.deepEqual(seqs(pageItems(db, undefined, 's')), [1, 2, 3])
})
