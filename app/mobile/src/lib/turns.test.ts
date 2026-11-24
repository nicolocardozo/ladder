import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFixture } from '../demo/fixtures.ts'
import { nextRevealLength, sliceReveal } from './text-reveal.ts'
import { buildChatRows, summaryParts } from './turns.ts'

const fixture = buildFixture(1_000_000_000)

test('turno concluso: una riga di riepilogo e la risposta finale', () => {
  const rows = buildChatRows(fixture.items.s3, 'idle')
  assert.deepEqual(rows.map((r) => r.kind), ['user', 'turn', 'assistant'])
  const turn = rows[1]
  assert.equal(turn.kind === 'turn' && turn.turn.running, false)
  if (turn.kind === 'turn') assert.deepEqual(summaryParts(turn.turn.counts, turn.turn.files), [{ key: 'edits', n: 2 }, { key: 'commands', n: 3 }, { key: 'reads', n: 2 }])
})

test('turno in corso resta aperto, in attesa non gira', () => {
  const running = buildChatRows(fixture.items.s1, 'running')
  const last = running[running.length - 1]
  assert.equal(last.kind, 'turn')
  assert.equal(last.kind === 'turn' && last.turn.running, true)
  assert.equal(last.kind === 'turn' && last.turn.current?.title.startsWith('Runs pnpm test'), true)
  const waiting = buildChatRows(fixture.items.s2, 'waiting')
  const turn = waiting.find((r) => r.kind === 'turn')
  assert.equal(turn?.kind === 'turn' && turn.turn.waiting, true)
  // Con la sessione ferma lo stesso turno non è più "in corso".
  assert.equal(buildChatRows(fixture.items.s2, 'idle').some((r) => r.kind === 'turn' && r.turn.running), false)
})

test('testo rivelato a ritmo costante e senza spezzare le coppie surrogate', () => {
  assert.equal(nextRevealLength(0, 1000, 100) > 0, true)
  assert.equal(nextRevealLength(10, 10, 100), 10)
  // Se il ritardo cresce si accelera.
  assert.equal(nextRevealLength(0, 2000, 100) > nextRevealLength(0, 50, 100), true)
  assert.equal(sliceReveal('a😀b', 2), 'a😀')
})
