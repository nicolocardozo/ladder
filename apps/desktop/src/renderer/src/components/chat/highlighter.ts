// Evidenziazione con Shiki, caricata solo al primo blocco di codice.
// Motore JavaScript (la CSP dell'app vieta WebAssembly) e un tema a variabili CSS che segue chiaro e scuro.
import type { HighlighterCore, ThemedToken } from 'shiki/core'

export type Lang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'bash'
  | 'css'
  | 'html'
  | 'markdown'
  | 'diff'
  | 'python'
  | 'yaml'
  | 'sql'

const loaders: Record<Lang, () => Promise<{ default: unknown }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  sql: () => import('shiki/langs/sql.mjs')
}

const ALIASES: Record<string, Lang> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  console: 'bash',
  terminal: 'bash',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  py: 'python',
  python: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql'
}

/** Vero se il valore è il nome di un linguaggio (ts, bash…), non un percorso. */
export function isLangName(value: string): boolean {
  return Object.hasOwn(ALIASES, value.toLowerCase())
}

/** Linguaggio da un'etichetta del blocco o dall'estensione di un percorso. */
export function resolveLang(value: string | null | undefined): Lang | null {
  if (!value) return null
  const key = value.toLowerCase()
  if (ALIASES[key]) return ALIASES[key]
  const dot = key.lastIndexOf('.')
  return dot >= 0 ? (ALIASES[key.slice(dot + 1)] ?? null) : null
}

const THEME = 'ladder'
let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Map<Lang, Promise<void>>()

function getHighlighter() {
  highlighterPromise ??= (async () => {
    const [core, engine] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
    const theme = core.createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-', fontStyle: true })
    return core.createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: engine.createJavaScriptRegexEngine({ forgiving: true })
    })
  })()
  return highlighterPromise
}

async function ensureLang(highlighter: HighlighterCore, lang: Lang) {
  let pending = loadedLangs.get(lang)
  if (!pending) {
    pending = loaders[lang]().then((mod) =>
      highlighter.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0])
    )
    loadedLangs.set(lang, pending)
  }
  await pending
}

export type TokenLines = ThemedToken[][]

const cache = new Map<string, TokenLines>()
const CACHE_LIMIT = 300

function cacheKey(code: string, lang: Lang) {
  return `${lang}\u0000${code}`
}

export function getCachedTokens(code: string, lang: Lang): TokenLines | null {
  const key = cacheKey(code, lang)
  const hit = cache.get(key)
  if (!hit) return null
  // Aggiorna l'ordine LRU.
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

export async function highlight(code: string, lang: Lang): Promise<TokenLines> {
  const cached = getCachedTokens(code, lang)
  if (cached) return cached
  const highlighter = await getHighlighter()
  await ensureLang(highlighter, lang)
  const tokens = highlighter.codeToTokens(code, { lang, theme: THEME }).tokens
  cache.set(cacheKey(code, lang), tokens)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return tokens
}
