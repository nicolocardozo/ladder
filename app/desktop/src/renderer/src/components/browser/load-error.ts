// Errori di caricamento del browser integrato in parole da leggere. `code` è il codice di rete di Chromium
// (-102 connessione rifiutata, -105 nome non risolto…); 0 è un errore nostro, già tradotto dal main.
import { t } from '@shared/i18n'
import type { BrowserLoadError } from '@shared/protocol'
import { browserAddress } from '@/lib/browser-tabs'

export interface DescribedError {
  title: string
  detail: string
  /** Cosa provare, quando c'è un'indicazione sensata. */
  hint: string | null
  /** Il motivo tecnico, per chi lo cerca: "ERR_CONNECTION_REFUSED (-102)". Null per gli errori nostri. */
  technical: string | null
}

const isLocal = (address: string): boolean => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(address)

export function describeLoadError(error: BrowserLoadError): DescribedError {
  const address = browserAddress(error.url) || t('this page')
  const technical = error.code === 0 ? null : `${error.description} (${error.code})`
  const code = error.code
  if (code === 0) return { title: t('Can’t open this page'), detail: error.description, hint: null, technical }
  if (code === -102)
    return {
      title: t('Can’t connect to {address}', { address }),
      detail: t('The server refused the connection.'),
      hint: isLocal(address) ? t('If this is a development server, check that it’s running in the terminal.') : t('Check that the address is right and the server is up.'),
      technical
    }
  if (code === -105)
    return { title: t('Can’t find {address}', { address }), detail: t('The address couldn’t be resolved.'), hint: t('Check for typos and your internet connection.'), technical }
  if (code === -106 || code === -109 || code === -21)
    return { title: t('No connection'), detail: t('The page can’t be reached from here.'), hint: t('Check your internet connection and try again.'), technical }
  if (code === -7 || code === -118)
    return { title: t('{address} took too long to respond', { address }), detail: t('The connection timed out.'), hint: t('Try again in a moment.'), technical }
  if (code === -100 || code === -101 || code === -324)
    return { title: t('The connection to {address} was interrupted', { address }), detail: t('The server closed the connection without a complete answer.'), hint: t('Try again in a moment.'), technical }
  // -200 … -219: certificato non valido o non attendibile.
  if (code <= -200 && code >= -219)
    return { title: t('The connection to {address} isn’t private', { address }), detail: t('The site’s certificate can’t be trusted.'), hint: null, technical }
  return { title: t('Couldn’t load {address}', { address }), detail: t('Something went wrong while loading the page.'), hint: t('Try again, or open it in your system browser.'), technical }
}
