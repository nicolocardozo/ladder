// Identity and texts of browser tabs. Like files, a browser tab is a non-chat tab: `activeTab` carries its id.
import { t } from '@shared/i18n'
import type { BrowserState } from '@shared/protocol'

const PREFIX = 'browser:'

export const newBrowserTabId = (): string => `${PREFIX}${crypto.randomUUID()}`
export const isBrowserTabId = (id: string | null | undefined): id is string => Boolean(id?.startsWith(PREFIX))

/** Short address to show: "localhost:5173" or "example.com", without scheme or path. */
export function browserAddress(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Tab name: page title, otherwise the short address, otherwise "Browser". */
export function browserTabLabel(state: Pick<BrowserState, 'title' | 'url'> | undefined, savedUrl = '', savedTitle = ''): string {
  const title = (state?.title || (state ? '' : savedTitle)).trim()
  if (title) return title
  const url = state?.url || savedUrl
  return url ? browserAddress(url) : t('Browser')
}

export const MAX_TITLE = 200

/** What is saved of an address: only origin and path, never query or fragment (they may carry tokens). The full URL lives only in the view state. */
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
