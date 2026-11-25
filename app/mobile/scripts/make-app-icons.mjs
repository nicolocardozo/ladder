// Genera le icone dell'app mobile dal simbolo del brand (brand/app-icon/svg/ladder-app-circuit.svg):
// - assets/icon.png: quadrato pieno 1024x1024 senza trasparenza e senza angoli arrotondati. iOS arrotonda da sé e riempie
//   di bianco ogni pixel trasparente, per questo non si può usare l'icona del Mac (quadrato arrotondato con margine trasparente).
// - assets/adaptive-icon.png: solo il simbolo su fondo trasparente, dentro l'area sicura dell'icona adattiva di Android
//   (il cerchio centrale di 66/108); il fondo viola lo mette `android.adaptiveIcon.backgroundColor` in app.json.
// Si rilancia solo se cambia il marchio. Serve `sharp`, che non è una dipendenza del progetto:
// `SHARP_PATH=/percorso/di/sharp node scripts/make-app-icons.mjs`. Poi rilanciare make-notification-icon.mjs.
import { readFileSync } from 'node:fs'

const { default: sharp } = await import(process.env.SHARP_PATH ?? 'sharp')
const brand = new URL('../../../brand/app-icon/svg/ladder-app-circuit.svg', import.meta.url).pathname
const svg = readFileSync(brand, 'utf8')
const BG = '#22123C'

// Il tracciato del simbolo, senza la sua trasformazione: la posizione la decidiamo qui.
const d = svg.match(/<path[^>]* d="([^"]+)"/)?.[1]
if (!d) throw new Error('Simbolo non trovato in ' + brand)
// Ingombro del simbolo nel suo sistema di coordinate (dal tracciato del brand).
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

// iOS: stessa proporzione del simbolo nell'icona del Mac (scala 2.6 su 1024), fondo pieno, nessun canale alpha.
await sharp(glyphSvg({ size: 1024, scale: 2.6, background: BG })).flatten({ background: BG }).removeAlpha().png().toFile(out('icon.png'))

// Android: il simbolo largo circa metà dell'icona, così resta dentro l'area sicura anche con le maschere rotonde.
await sharp(glyphSvg({ size: 1024, scale: 1.9, background: null })).png().toFile(out('adaptive-icon.png'))

// iOS 18+: varianti scura e "tinted" (app.json -> ios.icon). La scura ha fondo scuro e simbolo nell'accento di Circuit;
// la tinted è il simbolo in scala di grigi su fondo nero opaco: iOS la colora da sé con la tinta scelta dall'utente.
const DARK_BG = '#181424'
const ACCENT = '#AC97FF'
const tinted = (fill, bg) => glyphSvg({ size: 1024, scale: 2.6, background: bg, fill })
await sharp(tinted(ACCENT, DARK_BG)).flatten({ background: DARK_BG }).removeAlpha().png().toFile(out('icon-dark.png'))
await sharp(tinted('#FFFFFF', '#000000')).flatten({ background: '#000000' }).removeAlpha().greyscale().png().toFile(out('icon-tinted.png'))

console.log('icon.png, adaptive-icon.png, icon-dark.png e icon-tinted.png rigenerate')
