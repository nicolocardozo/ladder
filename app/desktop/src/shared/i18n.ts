// Ladder languages. The source text in the code is English (the default language); the other languages are catalogs
// that translate the exact English text. A string without a translation stays in English, never empty.
export type Locale = 'en' | 'it'
export type Vars = Record<string, string | number>

export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'it', name: 'Italiano' }
]

export const DEFAULT_LOCALE: Locale = 'en'

let current: Locale = DEFAULT_LOCALE
const catalogs: Partial<Record<Locale, Record<string, string>>> = {}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'it'
}

export function registerCatalog(locale: Locale, entries: Record<string, string>): void {
  catalogs[locale] = { ...catalogs[locale], ...entries }
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** BCP 47 tag for dates and numbers: "en-US", "it-IT". */
export function localeTag(locale: Locale = current): string {
  return locale === 'it' ? 'it-IT' : 'en-US'
}

function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match)) : text
}

/** Translates the English text into the current language; `{nome}` is replaced with `vars.nome`. */
export function t(text: string, vars?: Vars): string {
  const translated = current === 'en' ? text : (catalogs[current]?.[text] ?? text)
  return fill(translated, vars)
}

/** Like `t`, but in a chosen language instead of the current one (for texts meant for a phone, which has its own language). */
export function tIn(locale: Locale, text: string, vars?: Vars): string {
  const translated = locale === 'en' ? text : (catalogs[locale]?.[text] ?? text)
  return fill(translated, vars)
}

/** The English text and its translations in all registered catalogs (no variables). */
export function translations(text: string): string[] {
  const found = new Set([text])
  for (const catalog of Object.values(catalogs)) if (catalog?.[text]) found.add(catalog[text])
  return [...found]
}

/** Singular or plural: `plural(n, '{n} file', '{n} files')`. Each form has its own entry in the catalog. */
export function plural(n: number, one: string, other: string, vars?: Vars): string {
  return t(n === 1 ? one : other, { n, ...vars })
}
