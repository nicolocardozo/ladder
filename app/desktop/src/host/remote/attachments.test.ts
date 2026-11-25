import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base64Size, cleanAttachments, magicMatches, sanitizeName } from './attachments.ts'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)])

test('base64Size e numeri magici', () => {
  assert.equal(base64Size(png.toString('base64')), png.length)
  assert.equal(magicMatches('image/png', png), true)
  assert.equal(magicMatches('image/jpeg', png), false)
  assert.equal(magicMatches('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), true)
  assert.equal(magicMatches('image/webp', Buffer.from('RIFF\0\0\0\0WAVE')), false)
})

test('sanitizeName: basename, controlli, 120 caratteri, ripiego', () => {
  assert.equal(sanitizeName('../../etc/a.png', 'image/png'), 'a.png')
  assert.equal(sanitizeName('x\u0000\u0007y\n.jpg', 'image/jpeg'), 'xy.jpg')
  assert.equal(sanitizeName('a'.repeat(300), 'image/jpeg').length, 120)
  assert.equal(sanitizeName('..', 'image/webp'), 'image.webp')
  assert.equal(sanitizeName(42, 'image/png'), 'image.png')
})

test('cleanAttachments: base64 non canonico, padding e caratteri strani', () => {
  const ok = png.toString('base64')
  assert.equal(cleanAttachments([{ name: 'a', mediaType: 'image/png', data: ok }])?.length, 1)
  assert.equal(cleanAttachments([{ name: 'a', mediaType: 'image/png', data: ok.replace(/=*$/, '') + '\n' }]), null)
  assert.equal(cleanAttachments([{ name: 'a', mediaType: 'image/png', data: `${ok.slice(0, -2)}=!` }]), null)
  // bit di riempimento diversi da zero: non canonico
  const odd = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]).toString('base64')
  assert.equal(cleanAttachments([{ name: 'a', mediaType: 'image/png', data: odd.slice(0, -2) + 'F=' }]), null)
  assert.deepEqual(cleanAttachments([]), [])
  assert.equal(cleanAttachments(null), null)
})
