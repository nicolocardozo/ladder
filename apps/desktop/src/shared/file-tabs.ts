// Identità di un file aperto come tab: stessa stringa in `activeTab` e nello stato degli editor.
const PREFIX = 'file:'

export function fileTabId(root: string, path: string): string {
  return `${PREFIX}${root}\n${path}`
}

export function parseFileTab(id: string | null | undefined): { root: string; path: string } | null {
  if (!id?.startsWith(PREFIX)) return null
  const at = id.indexOf('\n')
  return at < 0 ? null : { root: id.slice(PREFIX.length, at), path: id.slice(at + 1) }
}
