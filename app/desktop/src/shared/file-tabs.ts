// Identity of a file open as a tab: the same string in `activeTab` and in the editors state.
const PREFIX = 'file:'

export function fileTabId(root: string, path: string): string {
  return `${PREFIX}${root}\n${path}`
}

export function parseFileTab(id: string | null | undefined): { root: string; path: string } | null {
  if (!id?.startsWith(PREFIX)) return null
  const at = id.indexOf('\n')
  return at < 0 ? null : { root: id.slice(PREFIX.length, at), path: id.slice(at + 1) }
}
