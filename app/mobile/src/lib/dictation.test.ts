import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextualStrings, dictationLocale, MAX_DICTATION_MS, mergeTranscript, meterLevel, onDeviceStatus } from './dictation.ts'

test('dictationLocale follows the app language', () => {
  assert.equal(dictationLocale('it'), 'it-IT')
  assert.equal(dictationLocale('en'), 'en-US')
})

test('contextualStrings: Ladder, worktree and the projects, no duplicates or empties', () => {
  assert.deepEqual(contextualStrings(['acme-web', ' ', 'Ladder', 'acme-web']), ['Ladder', 'worktree', 'acme-web'])
  assert.ok(contextualStrings(Array.from({ length: 500 }, (_, i) => `p${i}`)).length <= 100)
})

test('mergeTranscript: joins with a space only when needed', () => {
  assert.equal(mergeTranscript('', 'ciao mondo'), 'ciao mondo')
  assert.equal(mergeTranscript('fix the bug', 'in the parser'), 'fix the bug in the parser')
  assert.equal(mergeTranscript('fix ', 'it'), 'fix it')
  assert.equal(mergeTranscript('riga\n', 'dopo'), 'riga\ndopo')
  assert.equal(mergeTranscript('lascia', '   '), 'lascia')
})

test('meterLevel: from -2..10 to 0..1, never out of range', () => {
  assert.equal(meterLevel(-2), 0)
  assert.equal(meterLevel(-5), 0)
  assert.equal(meterLevel(10), 1)
  assert.equal(meterLevel(40), 1)
  assert.equal(meterLevel(4), 0.5)
  assert.equal(meterLevel(Number.NaN), 0)
})

test('maximum duration: 5 minutes', () => {
  assert.equal(MAX_DICTATION_MS, 300_000)
})

test('onDeviceStatus: the model is present, missing, or the language is unsupported', () => {
  // iOS: the installed models list is empty, it is enough that the language is supported and the phone can dictate on its own.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], [], true), { ok: true, locale: 'it-IT' })
  assert.deepEqual(onDeviceStatus('it-IT', ['en-US'], [], true), { ok: false, reason: 'unsupported', locale: 'it-IT' })
  // The phone cannot dictate on its own: never the network.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT'], ['it-IT'], false), { ok: false, reason: 'unsupported', locale: 'it-IT' })
  // Android: supported but model not downloaded.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], ['en-US'], true), { ok: false, reason: 'not-installed', locale: 'it-IT' })
  assert.deepEqual(onDeviceStatus('it-IT', ['it-IT', 'en-US'], ['it_IT'], true), { ok: true, locale: 'it-IT' })
  // Same language, other region: it counts.
  assert.deepEqual(onDeviceStatus('it-IT', ['it-CH'], ['it-CH'], true), { ok: true, locale: 'it-IT' })
  // No list (Android 12 and earlier): the flag decides.
  assert.deepEqual(onDeviceStatus('en-US', [], [], true), { ok: true, locale: 'en-US' })
})
