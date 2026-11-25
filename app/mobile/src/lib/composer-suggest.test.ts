import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlashCommand } from '../../../desktop/src/shared/protocol.ts'
import { parseCommandInput, applySuggestion, commandToken, filterCommands, fileToken, findTrigger, splitPath } from './composer-suggest.ts'

const cmd = (name: string, description = '', aliases?: string[]): SlashCommand => ({ name, description, hint: null, source: 'builtin', ...(aliases ? { aliases } : {}) })

test('findTrigger: "/" solo all’inizio del messaggio', () => {
  assert.deepEqual(findTrigger('/re', 3), { kind: 'command', query: 're', start: 0, end: 3 })
  assert.deepEqual(findTrigger('/', 1), { kind: 'command', query: '', start: 0, end: 1 })
  assert.deepEqual(findTrigger('  /rev', 6), { kind: 'command', query: 'rev', start: 2, end: 6 })
  assert.equal(findTrigger('fix /re', 7), null)
  assert.equal(findTrigger('/review now', 11), null)
  assert.equal(findTrigger('src/app.ts', 10), null)
})

test('findTrigger: "@" all’inizio o dopo uno spazio, fino al cursore', () => {
  assert.deepEqual(findTrigger('@', 1), { kind: 'file', query: '', start: 0, end: 1 })
  assert.deepEqual(findTrigger('look at @src/ap', 15), { kind: 'file', query: 'src/ap', start: 8, end: 15 })
  assert.deepEqual(findTrigger('a\n@x', 4), { kind: 'file', query: 'x', start: 2, end: 4 })
  // Il cursore a metà: conta solo il testo prima.
  assert.deepEqual(findTrigger('@src/app.ts', 4), { kind: 'file', query: 'src', start: 0, end: 4 })
  // Un'email o un @ dentro una parola non è una citazione.
  assert.equal(findTrigger('mail me@host.com', 16), null)
  assert.equal(findTrigger('look @src ', 10), null)
})

test('findTrigger: tipi spenti (nuova sessione: niente comandi)', () => {
  assert.equal(findTrigger('/re', 3, { command: false, file: true }), null)
  assert.equal(findTrigger('@a', 2, { command: true, file: false }), null)
  assert.ok(findTrigger('@a', 2, { command: false, file: true }))
})

test('findTrigger: virgolette iniziali dei percorsi con spazi non entrano nella ricerca', () => {
  assert.equal(findTrigger('@"docs/pay', 10)?.query, 'docs/pay')
})

test('findTrigger: cursore fuori dai limiti', () => {
  assert.equal(findTrigger('abc', 99), null)
  assert.deepEqual(findTrigger('/a', 99), { kind: 'command', query: 'a', start: 0, end: 2 })
  assert.equal(findTrigger('', 0), null)
})

test('applySuggestion: sostituisce il pezzo e aggiunge uno spazio', () => {
  const t = findTrigger('look at @src/ap', 15)!
  assert.deepEqual(applySuggestion('look at @src/ap', t, fileToken('src/app.ts')), { text: 'look at @src/app.ts ', cursor: 20 })
  // Testo dopo il cursore: lo spazio non si raddoppia.
  const mid = findTrigger('see @sr and more', 7)!
  assert.deepEqual(applySuggestion('see @sr and more', mid, fileToken('src/a.ts')), { text: 'see @src/a.ts and more', cursor: 14 })
  const c = findTrigger('/re', 3)!
  assert.deepEqual(applySuggestion('/re', c, commandToken('review')), { text: '/review ', cursor: 8 })
})

test('fileToken: percorsi con spazi tra virgolette', () => {
  assert.equal(fileToken('src/a.ts'), '@src/a.ts')
  assert.equal(fileToken('docs/payments filters.md'), '@"docs/payments filters.md"')
})

test('filterCommands: nome uguale, prefisso, alias, contenuto, descrizione', () => {
  const list = [cmd('review', 'Review the changes'), cmd('security-review', 'Security check'), cmd('clear', 'Reset the context', ['reset']), cmd('init', 'Create CLAUDE.md'), cmd('rebase', 'Rebase the branch')]
  assert.deepEqual(filterCommands(list, 're').map((c) => c.name), ['rebase', 'review', 'clear', 'security-review', 'init'])
  assert.deepEqual(filterCommands(list, 'review').map((c) => c.name), ['review', 'security-review'])
  assert.deepEqual(filterCommands(list, 'reset').map((c) => c.name), ['clear'])
  assert.deepEqual(filterCommands(list, 'claude').map((c) => c.name), ['init'])
  assert.deepEqual(filterCommands(list, '/INIT').map((c) => c.name), ['init'])
  assert.deepEqual(filterCommands(list, 'zzz'), [])
})

test('filterCommands: ricerca vuota = tutti in ordine alfabetico, con limite', () => {
  const list = [cmd('b'), cmd('a'), cmd('c')]
  assert.deepEqual(filterCommands(list, '').map((c) => c.name), ['a', 'b', 'c'])
  assert.equal(filterCommands(list, '', 2).length, 2)
})

test('splitPath', () => {
  assert.deepEqual(splitPath('src/lib/a.ts'), { name: 'a.ts', dir: 'src/lib' })
  assert.deepEqual(splitPath('README.md'), { name: 'README.md', dir: '' })
})

test('parseCommandInput: solo i comandi dell’elenco, con gli argomenti', () => {
  const names = ['review', 'compact']
  assert.deepEqual(parseCommandInput('/review', names), { name: 'review', args: '' })
  assert.deepEqual(parseCommandInput('/compact keep the API notes\nand tests ', names), { name: 'compact', args: 'keep the API notes\nand tests' })
  assert.deepEqual(parseCommandInput('  /review  ', names), { name: 'review', args: '' })
  assert.equal(parseCommandInput('/unknown', names), null)
  assert.equal(parseCommandInput('please /review', names), null)
  assert.equal(parseCommandInput('/Review', names), null)
  assert.equal(parseCommandInput('/', names), null)
})
