// Verifica del contrasto dei temi (WCAG 2): 4,5:1 per il testo, 3:1 per bordi dei controlli, focus e indicatori.
// Uso: node scripts/check-contrast.mjs   (esce con codice 1 se qualcosa non passa)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(new URL('..', import.meta.url).pathname, '..', '..')
const { themes } = JSON.parse(readFileSync(join(root, 'brand/themes.json'), 'utf8'))

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

// [primo piano, sfondo, minimo, descrizione]
const checks = (t, onWaiting) => [
  ['text', 'background', 4.5, 'testo su sfondo'],
  ['text', 'surface', 4.5, 'testo su superficie'],
  ['text', 'sidebar', 4.5, 'testo nella sidebar'],
  ['textMuted', 'background', 4.5, 'testo secondario su sfondo'],
  ['textMuted', 'surface', 4.5, 'testo secondario su superficie'],
  ['textMuted', 'sidebar', 4.5, 'testo secondario nella sidebar'],
  ['onSelection', 'selection', 4.5, 'testo della riga selezionata'],
  ['onAccent', 'accent', 4.5, 'testo sul pulsante principale'],
  ['accent', 'background', 4.5, 'accento come testo o link'],
  ['success', 'surface', 4.5, 'righe aggiunte (+) come testo'],
  ['error', 'surface', 4.5, 'righe tolte (−) ed errori come testo'],
  ['waiting', 'surface', 4.5, 'etichetta “Approvazione”'],
  [onWaiting, 'waiting', 4.5, 'testo sul badge “richiede te”'],
  ['focusRing', 'background', 3, 'anello di focus'],
  ['controlBorder', 'background', 3, 'bordo dei controlli su sfondo'],
  ['controlBorder', 'surface', 3, 'bordo dei controlli su superficie'],
  ['unread', 'sidebar', 3, 'punto “da leggere”'],
  ['running', 'sidebar', 3, 'anello “in corso”'],
  ['waiting', 'sidebar', 3, 'barretta “richiede te”']
]

let failures = 0
for (const [id, theme] of Object.entries(themes)) {
  const t = theme.tokens
  const onWaiting = theme.appearance === 'dark' ? '#000000' : '#FFFFFF'
  const rows = []
  for (const [fg, bg, min, label] of checks(t, onWaiting)) {
    const fgHex = fg.startsWith('#') ? fg : t[fg]
    const r = ratio(fgHex, t[bg])
    if (r + 1e-9 < min) {
      failures++
      rows.push(`  ✗ ${label}: ${r.toFixed(2)} (minimo ${min}) · ${fgHex} su ${t[bg]}`)
    }
  }
  console.log(`${rows.length ? '✗' : '✓'} ${theme.name}`)
  for (const row of rows) console.log(row)
}
console.log(failures ? `\n${failures} combinazioni sotto la soglia` : '\nTutte le combinazioni rispettano le soglie')
process.exit(failures ? 1 : 0)
