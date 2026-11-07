// Genera l'icona dell'app (resources/icon.icns): una scala chiara su un riquadro scuro a tinta blu.
// Disegno vettoriale semplice, campionato 4×4 per pixel, codificato in PNG senza dipendenze.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const SS = 4
const here = new URL('.', import.meta.url).pathname
const resources = join(here, '..', 'resources')

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Distanza con segno da un rettangolo arrotondato centrato in (cx, cy). */
function roundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r
  const qy = Math.abs(py - cy) - hh + r
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

// Riquadro secondo la griglia delle icone macOS: 824 px su 1024, raggio 185.
const plate = (x, y) => roundRect(x, y, 512, 512, 412, 412, 185) <= 0
// Scala: due montanti e quattro pioli, leggermente spostata verso l'alto.
const rail = 34
const rails = [384, 640]
const rungs = [330, 450, 570, 690]
const ladder = (x, y) =>
  rails.some((rx) => roundRect(x, y, rx, 512, rail / 2, 268, rail / 2) <= 0) ||
  rungs.some((ry) => roundRect(x, y, 512, ry, 128, rail / 2 - 3, rail / 2 - 3) <= 0)

const top = [0x15, 0x1d, 0x2b]
const bottom = [0x0b, 0x0f, 0x16]
const ink = [0x8d, 0xb4, 0xff]
const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE
  const bg = top.map((c, i) => Math.round(c + (bottom[i] - c) * t))
  for (let x = 0; x < SIZE; x++) {
    let cover = 0
    let mark = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS
        const py = y + (sy + 0.5) / SS
        if (plate(px, py)) {
          cover++
          if (ladder(px, py)) mark++
        }
      }
    }
    const i = (y * SIZE + x) * 4
    if (cover === 0) continue
    const m = mark / cover
    rgba[i] = Math.round(bg[0] + (ink[0] - bg[0]) * m)
    rgba[i + 1] = Math.round(bg[1] + (ink[1] - bg[1]) * m)
    rgba[i + 2] = Math.round(bg[2] + (ink[2] - bg[2]) * m)
    rgba[i + 3] = Math.round((255 * cover) / (SS * SS))
  }
}

mkdirSync(resources, { recursive: true })
const master = join(resources, 'icon.png')
writeFileSync(master, png(SIZE, SIZE, rgba))

const iconset = join(resources, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(s), String(s), master, '--out', join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
  execFileSync('sips', ['-z', String(s * 2), String(s * 2), master, '--out', join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' })
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
console.log('icona creata in', resources)
