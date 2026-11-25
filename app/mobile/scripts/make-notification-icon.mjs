// Generates assets/notification-icon.png (96x96, all white with transparency) from the adaptive icon symbol: it is the small icon
// of Android notifications, which the system tints itself. Re-run only when the brand changes.
// Needs `sharp`, which is not a project dependency: `SHARP_PATH=/path/to/sharp node scripts/make-notification-icon.mjs`.
const { default: sharp } = await import(process.env.SHARP_PATH ?? 'sharp')
const src = new URL('../assets/adaptive-icon.png', import.meta.url).pathname
const out = new URL('../assets/notification-icon.png', import.meta.url).pathname
const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const BG = 0x25 // red channel of the purple background (about #24143E)
const px = Buffer.alloc(info.width * info.height * 4, 255)
let minX = info.width, minY = info.height, maxX = 0, maxY = 0
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4
    // The lighter the pixel, the more symbol it is: alpha follows brightness, so the edges stay soft.
    const a = Math.max(0, Math.min(255, Math.round(((data[i] - BG) / (255 - BG)) * 255)))
    px[i + 3] = a
    if (a > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  }
}
const w = maxX - minX + 1, h = maxY - minY + 1
// Two passes: the symbol shrunk to 80 px inside a transparent 96x96 square (a single `resize` followed by another would cancel the first).
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
