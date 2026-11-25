import assert from 'node:assert/strict'
import test from 'node:test'
import { isBlockedLink, linkHead } from './deep-link.ts'

test('linkHead strips scheme, fragment and trailing slash', () => {
  assert.equal(linkHead('ladder://session/s1'), '/session/s1')
  assert.equal(linkHead('/pair#abc'), '/pair')
  assert.equal(linkHead('/waiting/'), '/waiting')
})

test('sheets, the "+" tab and pairing steps cannot be opened from a link', () => {
  for (const p of ['/sheet/request', 'ladder://sheet/permission', '/sheet', '/new', 'ladder://new/', '/pair/password', '/pair/device']) assert.equal(isBlockedLink(p), true, p)
})

test('real destinations pass', () => {
  for (const p of ['/', '/session/s1', '/project/p-ladder', '/waiting', '/settings', '/pair', '/pair#code', '/newsletter']) assert.equal(isBlockedLink(p), false, p)
})
