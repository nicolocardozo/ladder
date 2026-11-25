import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextualStrings, dictationLocale, MAX_DICTATION_MS, mergeTranscript, meterLevel, onDeviceStatus } from './dictation.ts'

test('dictationLocale segue la lingua dell’app', () => {
  assert.equal(dictationLocale('it'), 'it-IT')
  assert.equal(dictationLocale('en'), 'en-US')
})

test('contextualStrings: Ladder, worktree e i progetti, senza doppioni né vuoti', () => {
  assert.deepEqual(contextualStrings(['acme-web', ' ', 'Ladder', 'acme-web']), ['Ladder', 'worktree', 'acme-web'])
  assert.ok(contextualStrings(Array.from({ length: 500 }, (_, i) => `p${i}`)).length <= 100)
})

test('mergeTranscript: unisce con uno spazio solo se serve', () => {
  assert.equal(mergeTranscript('', 'ciao mondo'), 'ciao mondo')
  assert.equal(mergeTranscript('fix the bug', 'in the parser'), 'fix the bug in the parser')
  assert.equal(mergeTranscript('fix ', 'it'), 'fix it')
  assert.equal(mergeTranscript('riga\n', 'dopo'), 'riga\ndopo')
  assert.equal(mergeTranscript('lascia', '   '), 'lascia')
})

test('meterLevel: da -2..10 a 0..1, mai fuori scala', () => {
  assert.equal(meterLevel(-2), 0)
  assert.equal(meterLevel(-5), 0)
  assert.equal(meterLevel(10), 1)
  assert.equal(meterLevel(40), 1)
  assert.equal(meterLevel(4), 0.5)
  assert.equal(meterLevel(Number.NaN), 0)
})

test('durata massima: 5 minuti', () => {
  assert.equal(MAX_DICTATION_MS, 300_000)
})

test('onDeviceStatus: il modello c’è, manca, o la lingua non è supportata', () => {
  // iOS: l'elenco dei modelli installati è vuoto, basta che la lingua sia supportata e il telefono sappia dettare da sé.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], [], true), { ok: true, locale: 'it-IT' })
  assert.deepEqual(onDeviceStatus('it-IT', ['en-US'], [], true), { ok: false, reason: 'unsupported', locale: 'it-IT' })
  // Il telefono non sa dettare da sé: mai la rete.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT'], ['it-IT'], false), { ok: false, reason: 'unsupported', locale: 'it-IT' })
  // Android: supportata ma modello non scaricato.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], ['en-US'], true), { ok: false, reason: 'not-installed', locale: 'it-IT' })
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], ['it_IT'], true), { ok: true, locale: 'it-IT' })
  // Stessa lingua, altra regione: vale.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-CH'], ['it-CH'], true), { ok: true, locale: 'it-IT' })
  // Nessun elenco (Android 12 e precedenti): decide il flag.
  assert.deepEqual(onDeviceStatus('en-US', [], [], true), { ok: true, locale: 'en-US' })
})
