import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlashCommand } from '../../../desktop/src/shared/protocol.ts'
import { parseCommandInput, applySuggestion, commandToken, filterCommands, fileToken, findTrigger, splitPath } from './composer-suggest.ts'

const cmd = (name: string, description = '', aliases?: string[]): SlashCommand => ({ name, description, hint: null, source: 'builtin', ...(aliases ? { aliases } : {}) })

test('findTrigger: "/" only at the start of the message', () => {
  assert.deepEqual(findTrigger('/re', 3), { kind: 'command', query: 're', start: 0, end: 3 })
  assert.deepEqual(findTrigger('/', 1), { kind: 'command', query: '', start: 0, end: 1 })
  assert.deepEqual(findTrigger('  /rev', 6), { kind: 'command', query: 'rev', start: 2, end: 6 })
  assert.equal(findTrigger('fix /re', 7), null)
  assert.equal(findTrigger('/review now', 11), null)
  assert.equal(findTrigger('src/app.ts', 10), null)
})

test('findTrigger: "@" at the start or after a space, up to the cursor', () => {
  assert.deepEqual(findTrigger('@', 1), { kind: 'file', query: '', start: 0, end: 1 })
  assert.deepEqual(findTrigger('look at @src/ap', 15), { kind: 'file', query: 'src/ap', start: 8, end: 15 })
  assert.deepEqual(findTrigger('a\n@x', 4), { kind: 'file', query: 'x', start: 2, end: 4 })
  // Cursor in the middle: only the text before it counts.
  assert.deepEqual(findTrigger('@src/app.ts', 4), { kind: 'file', query: 'src', start: 0, end: 4 })
  // An email or an @ inside a word is not a mention.
  assert.equal(findTrigger('mail me@host.com', 16), null)
  assert.equal(findTrigger('look @src ', 10), null)
})

test('findTrigger: disabled kinds (new session: no commands)', () => {
  assert.equal(findTrigger('/re', 3, { command: false, file: true }), null)
  assert.equal(findTrigger('@a', 2, { command: true, file: false }), null)
  assert.ok(findTrigger('@a', 2, { command: false, file: true }))
})

test('findTrigger: leading quotes of paths with spaces are not part of the search', () => {
  assert.equal(findTrigger('@"docs/pay', 10)?.query, 'docs/pay')
})

test('findTrigger: cursor out of bounds', () => {
  assert.equal(findTrigger('abc', 99), null)
  assert.deepEqual(findTrigger('/a', 99), { kind: 'command', query: 'a', start: 0, end: 2 })
  assert.equal(findTrigger('', 0), null)
})

test('applySuggestion: replaces the fragment and adds a space', () => {
  const t = findTrigger('look at @src/ap', 15)!
  assert.deepEqual(applySuggestion('look at @src/ap', t, fileToken('src/app.ts')), { text: 'look at @src/app.ts ', cursor: 20 })
  // Text after the cursor: the space is not doubled.
  const mid = findTrigger('see @sr and more', 7)!
  assert.deepEqual(applySuggestion('see @sr and more', mid, fileToken('src/a.ts')), { text: 'see @src/a.ts and more', cursor: 14 })
  const c = findTrigger('/re', 3)!
  assert.deepEqual(applySuggestion('/re', c, commandToken('review')), { text: '/review ', cursor: 8 })
})

test('fileToken: paths with spaces are quoted', () => {
  assert.equal(fileToken('src/a.ts'), '@src/a.ts')
  assert.equal(fileToken('docs/payments filters.md'), '@"docs/payments filters.md"')
})

test('filterCommands: exact name, prefix, alias, content, description', () => {
  const list = [cmd('review', 'Review the changes'), cmd('security-review', 'Security check'), cmd('clear', 'Reset the context', ['reset']), cmd('init', 'Create CLAUDE.md'), cmd('rebase', 'Rebase the branch')]
  assert.deepEqual(filterCommands(list, 're').map((c) => c.name), ['rebase', 'review', 'clear', 'security-review', 'init'])
  assert.deepEqual(filterCommands(list, 'review').map((c) => c.name), ['review', 'security-review'])
  assert.deepEqual(filterCommands(list, 'reset').map((c) => c.name), ['clear'])
  assert.deepEqual(filterCommands(list, 'claude').map((c) => c.name), ['init'])
  assert.deepEqual(filterCommands(list, '/INIT').map((c) => c.name), ['init'])
  assert.deepEqual(filterCommands(list, 'zzz'), [])
})

test('filterCommands: empty query = all in alphabetical order, with a limit', () => {
  const list = [cmd('b'), cmd('a'), cmd('c')]
  assert.deepEqual(filterCommands(list, '').map((c) => c.name), ['a', 'b', 'c'])
  assert.equal(filterCommands(list, '', 2).length, 2)
})

test('splitPath', () => {
  assert.deepEqual(splitPath('src/lib/a.ts'), { name: 'a.ts', dir: 'src/lib' })
  assert.deepEqual(splitPath('README.md'), { name: 'README.md', dir: '' })
})

test('parseCommandInput: only commands from the list, with their arguments', () => {
  const names = ['review', 'compact']
  assert.deepEqual(parseCommandInput('/review', names), { name: 'review', args: '' })
  assert.deepEqual(parseCommandInput('/compact keep the API notes\nand tests ', names), { name: 'compact', args: 'keep the API notes\nand tests' })
  assert.deepEqual(parseCommandInput('  /review  ', names), { name: 'review', args: '' })
  assert.equal(parseCommandInput('/unknown', names), null)
  assert.equal(parseCommandInput('please /review', names), null)
  assert.equal(parseCommandInput('/Review', names), null)
  assert.equal(parseCommandInput('/', names), null)
})
