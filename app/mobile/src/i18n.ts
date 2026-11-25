// App language: English by default, Italian like the Mac. Same shared i18n (shared/i18n.ts + locales/it),
// plus the phone's string catalog (src/locales/it.ts).
import { getLocales } from 'expo-localization'
import { setLocale, type Locale } from '@shared/i18n'
import '@shared/locales/it'
import './locales/it'

/** System language if supported, otherwise English. */
export function systemLocale(): Locale {
  const code = getLocales()[0]?.languageCode
  return code === 'it' ? 'it' : 'en'
}

export function applyLocale(choice: 'system' | Locale): Locale {
  const locale = choice === 'system' ? systemLocale() : choice
  setLocale(locale)
  return locale
}
