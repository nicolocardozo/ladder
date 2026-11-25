// Theme contrast check (WCAG 2): 4.5:1 for text, 3:1 for control borders, focus and indicators.
// Usage: node scripts/check-contrast.mjs   (exits with code 1 if anything fails)
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

// [foreground, background, minimum, description]
const checks = (t, onWaiting) => [
  ['text', 'background', 4.5, 'text on background'],
  ['text', 'surface', 4.5, 'text on surface'],
  ['text', 'sidebar', 4.5, 'text in the sidebar'],
  ['textMuted', 'background', 4.5, 'secondary text on background'],
  ['textMuted', 'surface', 4.5, 'secondary text on surface'],
  ['textMuted', 'sidebar', 4.5, 'secondary text in the sidebar'],
  ['onSelection', 'selection', 4.5, 'text of the selected row'],
  ['onAccent', 'accent', 4.5, 'text on the primary button'],
  ['accent', 'background', 4.5, 'accent as text or link'],
  ['success', 'surface', 4.5, 'added lines (+) as text'],
  ['error', 'surface', 4.5, 'removed lines (−) and errors as text'],
  ['waiting', 'surface', 4.5, '“Approval” label'],
  [onWaiting, 'waiting', 4.5, 'text on the “needs you” badge'],
  ['focusRing', 'background', 3, 'focus ring'],
  ['controlBorder', 'background', 3, 'control border on background'],
  ['controlBorder', 'surface', 3, 'control border on surface'],
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
  for (const key of ['keyword', 'string', 'function', 'constant', 'added', 'removed']) {
    if (!theme.syntax) break
    const r = ratio(theme.syntax[key], t.codeBackground)
    if (r + 1e-9 < 4.5) {
      failures++
      rows.push(`  ✗ codice (${key}): ${r.toFixed(2)} (minimo 4.5) · ${theme.syntax[key]} su ${t.codeBackground}`)
    }
  }
  console.log(`${rows.length ? '✗' : '✓'} ${theme.name}`)
  for (const row of rows) console.log(row)
}
console.log(failures ? `\n${failures} combinations below the threshold` : '\nEvery combination meets its threshold')
process.exit(failures ? 1 : 0)
