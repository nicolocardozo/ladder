import assert from 'node:assert/strict'
import test from 'node:test'
import { isBlockedLink, linkHead } from './deep-link.ts'

test('linkHead toglie schema, frammento e barra finale', () => {
  assert.equal(linkHead('ladder://session/s1'), '/session/s1')
  assert.equal(linkHead('/pair#abc'), '/pair')
  assert.equal(linkHead('/waiting/'), '/waiting')
})

test('gli sheet, il tab "+" e i passi dell\'abbinamento non si aprono da un link', () => {
  for (const p of ['/sheet/request', 'ladder://sheet/permission', '/sheet', '/new', 'ladder://new/', '/pair/password', '/pair/device']) assert.equal(isBlockedLink(p), true, p)
})

test('le destinazioni vere passano', () => {
  for (const p of ['/', '/session/s1', '/project/p-ladder', '/waiting', '/settings', '/pair', '/pair#code', '/newsletter']) assert.equal(isBlockedLink(p), false, p)
})
