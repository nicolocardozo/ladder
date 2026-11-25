// Generates the mobile app icons from the brand symbol (brand/app-icon/svg/ladder-app-circuit.svg):
// - assets/icon.png: solid square 1024x1024 with no transparency and no rounded corners. iOS rounds it itself and fills
//   every transparent pixel with white, which is why the Mac icon can't be used (rounded square with a transparent margin).
// - assets/adaptive-icon.png: only the symbol on a transparent background, inside the safe area of the Android adaptive icon
//   (the central circle of 66/108); the purple background is set by `android.adaptiveIcon.backgroundColor` in app.json.
// Re-run only when the brand changes. Needs `sharp`, which is not a project dependency:
// `SHARP_PATH=/path/to/sharp node scripts/make-app-icons.mjs`. Then re-run make-notification-icon.mjs.
import { readFileSync } from 'node:fs'

const { default: sharp } = await import(process.env.SHARP_PATH ?? 'sharp')
const brand = new URL('../../../brand/app-icon/svg/ladder-app-circuit.svg', import.meta.url).pathname
const svg = readFileSync(brand, 'utf8')
const BG = '#22123C'

// The symbol's path, without its transform: we decide the position here.
const d = svg.match(/<path[^>]* d="([^"]+)"/)?.[1]
if (!d) throw new Error('Symbol not found in ' + brand)
// Footprint of the symbol in its coordinate system (from the brand path).
const GLYPH_W = 275
const GLYPH_H = 177

function glyphSvg({ size, scale, background, fill = '#FFFFFF' }) {
  const x = (size - GLYPH_W * scale) / 2
  const y = (size - GLYPH_H * scale) / 2
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}` +
      `<path fill="${fill}" fill-rule="evenodd" transform="translate(${x} ${y}) scale(${scale})" d="${d}"/></svg>`
  )
}

const out = (name) => new URL(`../assets/${name}`, import.meta.url).pathname

// iOS: same proportion of the symbol as in the Mac icon (scale 2.6 on 1024), solid background, no alpha channel.
await sharp(glyphSvg({ size: 1024, scale: 2.6, background: BG })).flatten({ background: BG }).removeAlpha().png().toFile(out('icon.png'))

// Android: the symbol about half the width of the icon, so it stays inside the safe area even with round masks.
await sharp(glyphSvg({ size: 1024, scale: 1.9, background: null })).png().toFile(out('adaptive-icon.png'))

// iOS 18+: dark and "tinted" variants (app.json -> ios.icon). The dark one has a dark background and the symbol in the Circuit accent;
// the tinted one is the symbol in grayscale on an opaque black background: iOS tints it itself with the color the user chose.
const DARK_BG = '#181424'
const ACCENT = '#AC97FF'
const tinted = (fill, bg) => glyphSvg({ size: 1024, scale: 2.6, background: bg, fill })
await sharp(tinted(ACCENT, DARK_BG)).flatten({ background: DARK_BG }).removeAlpha().png().toFile(out('icon-dark.png'))
await sharp(tinted('#FFFFFF', '#000000')).flatten({ background: '#000000' }).removeAlpha().greyscale().png().toFile(out('icon-tinted.png'))

console.log('icon.png, adaptive-icon.png, icon-dark.png e icon-tinted.png rigenerate')
