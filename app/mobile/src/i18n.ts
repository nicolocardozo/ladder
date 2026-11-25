// Lingua dell'app: inglese predefinito, italiano come il Mac. Stesso i18n condiviso (shared/i18n.ts + locales/it),
// più il catalogo delle stringhe del telefono (src/locales/it.ts).
import { getLocales } from 'expo-localization'
import { setLocale, type Locale } from '@shared/i18n'
import '@shared/locales/it'
import './locales/it'

/** Lingua del sistema se supportata, altrimenti inglese. */
export function systemLocale(): Locale {
  const code = getLocales()[0]?.languageCode
  return code === 'it' ? 'it' : 'en'
}

export function applyLocale(choice: 'system' | Locale): Locale {
  const locale = choice === 'system' ? systemLocale() : choice
  setLocale(locale)
  return locale
}
