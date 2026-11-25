import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeRelativePath, searchFiles } from './file-search.ts'

const files = ['README.md', 'src/main.ts', 'src/utils/app-config.ts', 'src/app.ts', 'docs/the-app/index.md', 'a/b/c/d/application.ts', 'src/x/y/zzz.ts']

test('ordering: name prefix, name contains, path contains, subsequence; then depth', () => {
  assert.deepEqual(searchFiles(files, 'app'), ['src/app.ts', 'src/utils/app-config.ts', 'a/b/c/d/application.ts', 'docs/the-app/index.md'])
  assert.deepEqual(searchFiles(files, 'SRCMAIN').slice(0, 1), ['src/main.ts'])
  assert.deepEqual(searchFiles(files, 'nothing-here'), [])
})

test('empty query: the shallowest files; limit and maximum', () => {
  assert.deepEqual(searchFiles(files, '', 2), ['README.md', 'src/app.ts'])
  const many = Array.from({ length: 200 }, (_, i) => `f${i}.ts`)
  assert.equal(searchFiles(many, '', 1000).length, 50)
  assert.equal(searchFiles(many, '').length, 20)
  assert.equal(searchFiles(many, '', 0).length, 20)
})

test('absolute paths or paths with .. are discarded', () => {
  assert.deepEqual(searchFiles(['/etc/passwd', '../x', 'a/../b', 'ok.ts', 'C:\\x', 'a\\b', 'a//b'], ''), ['ok.ts'])
  assert.equal(isSafeRelativePath('a/b.ts'), true)
  assert.equal(isSafeRelativePath('a/\u0000b'), false)
})
