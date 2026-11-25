// Which incoming paths (deep link, notification) can be opened as they are. Sheets (/sheet/…) and the "+" tab (/new) are not
// destinations: without the data that opens them from within the app they would be empty screens. A pairing step (password, name…)
// cannot skip the confirmation. In all these cases we go to the root.

/** The path without scheme, fragment and trailing slash. */
export function linkHead(path: string): string {
  const hash = path.indexOf('#')
  return (hash >= 0 ? path.slice(0, hash) : path).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/').replace(/\/+$/, '')
}

export function isBlockedLink(path: string): boolean {
  const head = linkHead(path)
  return /^\/?pair\/.+/i.test(head) || /^\/?sheet(\/.*)?$/i.test(head) || /^\/?new$/i.test(head)
}
