import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/mona-sans/wght.css'
import '@fontsource/monaspace-neon/400.css'
import '@fontsource/monaspace-neon/500.css'
import '@fontsource/monaspace-neon/600.css'
import './styles/globals.css'
import '@shared/locales/it'
import { setLocale, type Locale } from '@shared/i18n'
import { App } from './App'
import { request, send } from './lib/host-client'
import { useApp } from './store/app-store'
import { useSettings } from './hooks/use-theme'

// Accesso per il debug e le prove end-to-end via DevTools: stesso potere della pagina, nessun accesso a Node.
;(window as unknown as { __ladder: unknown }).__ladder = { request, send, store: useApp, settings: useSettings }

setLocale(window.ladder?.locale ?? 'en')

/** Cambio di lingua: la lingua corrente si imposta prima di disegnare e l'app si ridisegna da capo. */
function LocaleRoot() {
  const locale: Locale = useApp((s) => s.prefs?.locale) ?? window.ladder?.locale ?? 'en'
  setLocale(locale)
  document.documentElement.lang = locale
  return <App key={locale} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleRoot />
  </StrictMode>
)
