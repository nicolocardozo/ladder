import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imagePlaceholder, isImagePlaceholder } from './image-placeholder.ts'

test('segnaposto delle immagini: singolare e plurale, riconosciuto in ogni lingua', () => {
  assert.equal(imagePlaceholder(1), '(image attached)')
  assert.equal(imagePlaceholder(3), '(images attached)')
  for (const text of ['(image attached)', '(images attached)', '(immagine allegata)', '(immagini allegate)']) assert.equal(isImagePlaceholder(text), true)
  assert.equal(isImagePlaceholder('(image attached) e altro'), false)
  assert.equal(isImagePlaceholder(''), false)
})
