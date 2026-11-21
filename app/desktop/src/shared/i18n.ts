// Lingue di Ladder. Il testo sorgente nel codice è in inglese (lingua predefinita); le altre lingue sono cataloghi
// che traducono il testo inglese esatto. Una stringa senza traduzione resta in inglese, mai vuota.
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

/** Tag BCP 47 per date e numeri: "en-US", "it-IT". */
export function localeTag(locale: Locale = current): string {
  return locale === 'it' ? 'it-IT' : 'en-US'
}

function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match)) : text
}

/** Traduce il testo inglese nella lingua corrente; `{nome}` si sostituisce con `vars.nome`. */
export function t(text: string, vars?: Vars): string {
  const translated = current === 'en' ? text : (catalogs[current]?.[text] ?? text)
  return fill(translated, vars)
}

/** Il testo inglese e le sue traduzioni in tutti i cataloghi registrati (senza variabili). */
export function translations(text: string): string[] {
  const found = new Set([text])
  for (const catalog of Object.values(catalogs)) if (catalog?.[text]) found.add(catalog[text])
  return [...found]
}

/** Singolare o plurale: `plural(n, '{n} file', '{n} files')`. Ogni forma ha la sua voce nel catalogo. */
export function plural(n: number, one: string, other: string, vars?: Vars): string {
  return t(n === 1 ? one : other, { n, ...vars })
}
