// Genera dai file del brand (radice del repo) i moduli usati dall'app:
//  - src/renderer/src/styles/themes.generated.css  variabili --ladder-* per ogni tema
//  - src/shared/themes.generated.ts                 elenco dei temi con palette e token, per anteprime e processo main
//  - src/renderer/src/components/brand/logo-paths.generated.ts  tracciati di simbolo e wordmark
// Fonte: brand/themes.json e logo/svg/*.svg. Rieseguire con `pnpm --filter @ladder/desktop sync-brand`.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const app = new URL('..', import.meta.url).pathname
const root = join(app, '..', '..')
const source = JSON.parse(readFileSync(join(root, 'brand/themes.json'), 'utf8'))

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const header = '/* File generato da scripts/sync-brand.mjs a partire da brand/themes.json: non modificarlo a mano. */\n'

// ── CSS dei temi
function themeBlock(selector, theme, id) {
  const vars = Object.entries(theme.tokens).map(([k, v]) => `  --ladder-${kebab(k)}: ${v};`)
  // Colori del codice propri del tema (nei Mono): senza, codice e diff derivano da accento e stati.
  for (const [k, v] of Object.entries(theme.syntax ?? {})) if (k !== 'terminal') vars.push(`  --ladder-syntax-${kebab(k)}: ${v};`)
  // Colore del marchio in UI: bianco sui temi scuri, iris Circuit sui chiari, nero su Mono Light.
  vars.push(`  --ladder-brand-ink: ${theme.appearance === 'dark' ? source.brand.white : id === 'mono-light' ? source.brand.black : source.brand.primary};`)
  // Testo sopra il colore "in attesa": scuro sui temi scuri (dove l'attesa è chiara), bianco sui chiari.
  vars.push(`  --ladder-on-waiting: ${theme.appearance === 'dark' ? '#000000' : '#FFFFFF'};`)
  return `${selector} {\n  color-scheme: ${theme.appearance};\n${vars.join('\n')}\n}`
}
// Prima il tema predefinito su :root (ripiego senza attributo), poi tutti i temi: a parità di specificità vince l'ultimo.
const blocks = [themeBlock(':root', source.themes[source.defaultTheme], source.defaultTheme)]
for (const [id, theme] of Object.entries(source.themes)) blocks.push(themeBlock(`[data-theme="${id}"]`, theme, id))
writeFileSync(join(app, 'src/renderer/src/styles/themes.generated.css'), header + '\n' + blocks.join('\n\n') + '\n')

// ── Elenco dei temi per TypeScript
const themes = Object.entries(source.themes).map(([id, t]) => ({ id, name: t.name, appearance: t.appearance, palette: t.palette, tokens: t.tokens, ...(t.syntax ? { syntax: t.syntax } : {}) }))
const ts = `${header.replace('/*', '//').replace(' */', '')}
export type ThemeId = ${themes.map((t) => `'${t.id}'`).join(' | ')}

export interface ThemeInfo {
  id: ThemeId
  name: string
  appearance: 'light' | 'dark'
  palette: { primary: string; secondary: string; highlight: string }
  tokens: Record<${Object.keys(themes[0].tokens).map((k) => `'${k}'`).join(' | ')}, string>
  syntax?: { keyword: string; string: string; function: string; constant: string; added: string; removed: string; terminal: { red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string } }
}

export const DEFAULT_THEME: ThemeId = '${source.defaultTheme}'

export const BRAND = ${JSON.stringify(source.brand, null, 2)} as const

export const THEMES: ThemeInfo[] = ${JSON.stringify(themes, null, 2)}

export function themeById(id: unknown): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}
`
writeFileSync(join(app, 'src/shared/themes.generated.ts'), ts)

// ── Tracciati del logo (le versioni bianche: il colore lo decide l'interfaccia con currentColor)
function svgPaths(file) {
  const svg = readFileSync(join(root, 'logo/svg', file), 'utf8')
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1]
  // Ogni tracciato con la sua eventuale trasformazione (il wordmark del lockup è spostato con translate).
  const paths = [...svg.matchAll(/<path([^>]*)\/?>/g)].map((m) => ({
    d: m[1].match(/\sd="([^"]+)"/)[1],
    transform: m[1].match(/\stransform="([^"]+)"/)?.[1] ?? null
  }))
  return { viewBox, paths }
}
const logo = {
  mark: svgPaths('ladder-mark-white.svg'),
  wordmark: svgPaths('ladder-wordmark-white.svg'),
  horizontal: svgPaths('ladder-horizontal-white.svg')
}
writeFileSync(
  join(app, 'src/renderer/src/components/brand/logo-paths.generated.ts'),
  `${header.replace('/*', '//').replace(' */', '')}
export const LOGO = ${JSON.stringify(logo, null, 2)} as const
`
)
console.log(`temi: ${themes.length}, predefinito: ${source.defaultTheme}; logo: simbolo, wordmark, orizzontale`)
