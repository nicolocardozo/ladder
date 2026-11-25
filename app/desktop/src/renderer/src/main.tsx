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
import { useChatFont } from './hooks/use-chat-font'

// Access for debugging and end-to-end tests via DevTools: same power as the page, no Node access.
;(window as unknown as { __ladder: unknown }).__ladder = { request, send, store: useApp, settings: useSettings }

setLocale(window.ladder?.locale ?? 'en')

/** Language change: the current language is set before drawing and the app is redrawn from scratch. */
function LocaleRoot() {
  const locale: Locale = useApp((s) => s.prefs?.locale) ?? window.ladder?.locale ?? 'en'
  setLocale(locale)
  document.documentElement.lang = locale
  useChatFont()
  return <App key={locale} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleRoot />
  </StrictMode>
)
