import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REMOTE_MAX_ATTACH_COMMAND } from '../../../desktop/src/shared/protocol.ts'
import { utf8Bytes, attachmentName, base64Bytes, commandBytes, commandFits, encodeUnderLimit, fitSize, imageTypeOf, longEdgeFor, MAX_IMAGE_BYTES, remainingSlots } from './attachments.ts'

test('fitSize: lato lungo al massimo, mai ingrandito, proporzioni mantenute', () => {
  assert.deepEqual(fitSize(4032, 3024, 1568), { width: 1568, height: 1176 })
  assert.deepEqual(fitSize(3024, 4032, 1568), { width: 1176, height: 1568 })
  assert.deepEqual(fitSize(800, 600, 1568), { width: 800, height: 600 })
  assert.deepEqual(fitSize(0, 0, 1568), { width: 1, height: 1 })
  assert.deepEqual(fitSize(10000, 1, 1568), { width: 1568, height: 1 })
})

test('longEdgeFor: 1280 per PNG e screenshot, 1568 per le foto', () => {
  assert.equal(longEdgeFor({ mimeType: 'image/png' }), 1280)
  assert.equal(longEdgeFor({ fileName: 'Screenshot 2026-11-25.jpg' }), 1280)
  assert.equal(longEdgeFor({ fileName: 'IMG_0001.PNG' }), 1280)
  assert.equal(longEdgeFor({ mimeType: 'image/jpeg', fileName: 'IMG_0001.JPG' }), 1568)
  assert.equal(longEdgeFor({}), 1568)
})

test('base64Bytes conta i byte con e senza padding', () => {
  assert.equal(base64Bytes(Buffer.from('abc').toString('base64')), 3)
  assert.equal(base64Bytes(Buffer.from('abcd').toString('base64')), 4)
  assert.equal(base64Bytes(Buffer.from('abcde').toString('base64')), 5)
  assert.equal(base64Bytes(''), 0)
})

test('MAX_IMAGE_BYTES: tre immagini stanno sempre nel totale di 2 MiB', () => {
  assert.ok(MAX_IMAGE_BYTES <= 1024 * 1024)
  assert.ok(MAX_IMAGE_BYTES * 3 <= 2 * 1024 * 1024)
})

test('remainingSlots', () => {
  assert.equal(remainingSlots(0), 3)
  assert.equal(remainingSlots(2), 1)
  assert.equal(remainingSlots(3), 0)
  assert.equal(remainingSlots(7), 0)
})

test('encodeUnderLimit: ritenta con qualità più bassa finché sta nel limite', async () => {
  const seen: [number, number][] = []
  const sizes = [900_000, 700_000, 500_000]
  const out = await encodeUnderLimit(async (q, s) => {
    seen.push([q, s])
    return Buffer.alloc(sizes[seen.length - 1]).toString('base64')
  }, 600_000)
  assert.equal(seen.length, 3)
  assert.equal(out.bytes, 500_000)
  // La qualità non sale mai e la scala non cresce.
  assert.ok(seen.every(([q, s], i) => i === 0 || (q <= seen[i - 1][0] && s <= seen[i - 1][1])))
})

test('encodeUnderLimit: se nessun tentativo basta lancia too-big; un errore del render risale', async () => {
  await assert.rejects(encodeUnderLimit(async () => Buffer.alloc(2_000_000).toString('base64'), 600_000), /too-big/)
  await assert.rejects(
    encodeUnderLimit(async () => {
      throw new Error('unreadable')
    }),
    /unreadable/
  )
  // Un risultato vuoto non vale come "piccolo".
  await assert.rejects(encodeUnderLimit(async () => ''), /too-big/)
})

test('attachmentName: base ripulita, suffisso unico, sempre .jpg', () => {
  assert.equal(attachmentName('IMG_0001.HEIC', 'ab12c'), 'IMG_0001-ab12c.jpg')
  assert.equal(attachmentName('/var/mobile/tmp/Foto vacanza.png', 'x'), 'Foto-vacanza-x.jpg')
  assert.equal(attachmentName('../../etc/passwd', 'x'), 'passwd-x.jpg')
  assert.equal(attachmentName('a\u0000b\u001fc.jpg', 'x'), 'abc-x.jpg')
  assert.equal(attachmentName(null, 'x'), 'photo-x.jpg')
  assert.equal(attachmentName('...', 'x'), 'photo-x.jpg')
  assert.ok(attachmentName('x'.repeat(500) + '.jpg', 'abcde').length <= 120)
})

test('commandBytes / commandFits: poco spazio per il testo con immagini vicine al tetto', () => {
  const img = (n: number) => ({ base64: 'A'.repeat(n) })
  assert.equal(commandFits('ciao', []), true)
  assert.equal(commandFits('ciao', [img(900_000), img(900_000), img(900_000)]), true)
  // 3 immagini da 2 MiB in tutto (≈2,8 milioni di caratteri base64) + 400 kB di testo non ASCII: oltre il tetto.
  const big = [img(1_000_000), img(1_000_000), img(1_000_000)]
  assert.equal(commandFits('è'.repeat(200_000), big), false)
  assert.ok(commandBytes('a', [img(10)]) < 2_000)
  assert.ok(REMOTE_MAX_ATTACH_COMMAND > commandBytes('a', [img(10)]))
})

test('imageTypeOf: solo i tipi che il Mac accetta', () => {
  assert.equal(imageTypeOf('image/jpeg'), 'image/jpeg')
  assert.equal(imageTypeOf('photo.JPG'), 'image/jpeg')
  assert.equal(imageTypeOf('data:image/png;base64,AAAA'), 'image/png')
  assert.equal(imageTypeOf('x.webp'), 'image/webp')
  assert.equal(imageTypeOf('x.heic'), null)
  assert.equal(imageTypeOf(undefined), null)
})

test('utf8Bytes e commandBytes contano l’escape JSON', () => {
  assert.equal(utf8Bytes('aè€😀'), Buffer.byteLength('aè€😀'))
  // Virgolette, a capo e caratteri di controllo raddoppiano (o sestuplicano) in JSON.
  const nasty = '"\n\u0001'.repeat(1000)
  assert.equal(commandBytes(nasty, []), Buffer.byteLength(JSON.stringify(nasty)) + 1024)
  assert.ok(commandBytes(nasty, []) > nasty.length * 3)
})
