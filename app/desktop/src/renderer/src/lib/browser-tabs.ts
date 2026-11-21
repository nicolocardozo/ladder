// Identità e testi delle tab browser (LAD-57). Come i file, una tab browser è una tab non-chat: `activeTab` ne porta l'id.
import { t } from '@shared/i18n'
import type { BrowserState } from '@shared/protocol'

const PREFIX = 'browser:'

export const newBrowserTabId = (): string => `${PREFIX}${crypto.randomUUID()}`
export const isBrowserTabId = (id: string | null | undefined): id is string => Boolean(id?.startsWith(PREFIX))

/** Indirizzo breve da mostrare: "localhost:5173" o "example.com", senza schema né percorso. */
export function browserAddress(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Nome della tab: titolo della pagina, altrimenti l'indirizzo breve, altrimenti "Browser". */
export function browserTabLabel(state: Pick<BrowserState, 'title' | 'url'> | undefined, savedUrl = '', savedTitle = ''): string {
  const title = (state?.title || (state ? '' : savedTitle)).trim()
  if (title) return title
  const url = state?.url || savedUrl
  return url ? browserAddress(url) : t('Browser')
}

export const MAX_TITLE = 200

/** Cosa si salva di un indirizzo: solo origine e percorso, mai query o frammento (possono portare token). L'URL completo vive solo nello stato della vista. */
export function storableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin + parsed.pathname
  } catch {
    return ''
  }
}

export const clipTitle = (title: string): string => (title.length > MAX_TITLE ? title.slice(0, MAX_TITLE) : title)
