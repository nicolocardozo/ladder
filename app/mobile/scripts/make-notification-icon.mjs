// Genera assets/notification-icon.png (96x96, tutto bianco con trasparenza) dal simbolo dell'icona adattiva: è l'icona piccola
// delle notifiche Android, che il sistema colora da sé. Si rilancia solo se cambia il marchio.
// Serve `sharp`, che non è una dipendenza del progetto: `SHARP_PATH=/percorso/di/sharp node scripts/make-notification-icon.mjs`.
const { default: sharp } = await import(process.env.SHARP_PATH ?? 'sharp')
const src = new URL('../assets/adaptive-icon.png', import.meta.url).pathname
const out = new URL('../assets/notification-icon.png', import.meta.url).pathname
const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const BG = 0x25 // canale rosso dello sfondo viola (#24143E circa)
const px = Buffer.alloc(info.width * info.height * 4, 255)
let minX = info.width, minY = info.height, maxX = 0, maxY = 0
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4
    // Più il pixel è chiaro, più è simbolo: l'alpha segue la luminosità, così i bordi restano morbidi.
    const a = Math.max(0, Math.min(255, Math.round(((data[i] - BG) / (255 - BG)) * 255)))
    px[i + 3] = a
    if (a > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  }
}
const w = maxX - minX + 1, h = maxY - minY + 1
// Due passaggi: il simbolo ridotto a 80 px dentro un quadrato trasparente 96x96 (un solo `resize` seguito da un altro annullerebbe il primo).
const glyph = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
  .extract({ left: minX, top: minY, width: w, height: h })
  .resize(80, 80, { fit: 'inside' })
  .png()
  .toBuffer()
await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: glyph, gravity: 'centre' }])
  .png()
  .toFile(out)
console.log('ok', w, h)
