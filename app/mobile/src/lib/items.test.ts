import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem } from '../../../desktop/src/shared/protocol.ts'
import { reasonKind } from './connection.ts'
import { applyItemsEvent, mergeById, PAGE_SIZE } from './items.ts'

const item = (seq: number, text = String(seq)): ChatItem => ({ id: `i${seq}`, turnId: 't', seq, at: seq, kind: 'assistant', text, streaming: false })

test('mergeById ordina per seq e aggiorna per id', () => {
  const merged = mergeById([item(2), item(1)], [item(2, 'nuovo'), item(3)])
  assert.deepEqual(merged.map((i) => i.seq), [1, 2, 3])
  assert.equal((merged[1] as { text: string }).text, 'nuovo')
})

test('replace con pagina piena lascia la storia più vecchia caricabile', () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => item(100 + i))
  const r = applyItemsEvent([item(1), item(2)], false, page, true)
  assert.equal(r.items.length, PAGE_SIZE)
  assert.equal(r.items[0].seq, 100)
  assert.equal(r.hasMore, true)
})

test('replace con pagina corta: la chat è completa', () => {
  const r = applyItemsEvent([item(1), item(2), item(3)], true, [item(2), item(3)], true)
  assert.equal(r.hasMore, false)
  assert.deepEqual(r.items.map((i) => i.seq), [2, 3])
})

test('senza replace gli item si uniscono e hasMore non cambia', () => {
  const r = applyItemsEvent([item(5)], true, [item(6)], false)
  assert.equal(r.hasMore, true)
  assert.deepEqual(r.items.map((i) => i.seq), [5, 6])
})

test('reasonKind riconosce le categorie e nasconde il resto', () => {
  assert.equal(reasonKind('Timed out'), 'timeout')
  assert.equal(reasonKind('The Mac did not answer in time.'), 'timeout')
  assert.equal(reasonKind('Connection failed'), 'refused')
  assert.equal(reasonKind('Connection lost'), 'lost')
  assert.equal(reasonKind('Remote: frame MORE non pieno'), 'secure')
  assert.equal(reasonKind('Noise: decrypt failed'), 'secure')
  assert.equal(reasonKind(undefined), null)
  assert.equal(reasonKind('boh'), null)
})
