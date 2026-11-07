import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { request, send } from './lib/host-client'
import { useApp } from './store/app-store'
import { useSettings } from './hooks/use-theme'

// Accesso per il debug e le prove end-to-end via DevTools: stesso potere della pagina, nessun accesso a Node.
;(window as unknown as { __ladder: unknown }).__ladder = { request, send, store: useApp, settings: useSettings }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
