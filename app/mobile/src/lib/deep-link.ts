// Quali percorsi in ingresso (deep link, notifica) si possono aprire così come sono. Gli sheet (/sheet/…) e il tab "+" (/new) non
// sono destinazioni: senza i dati che li aprono dall'app sarebbero schermate vuote. Un passo dell'abbinamento (password, nome…)
// non può saltare la conferma. In tutti questi casi si va alla radice.

/** Il percorso senza schema, frammento e barra finale. */
export function linkHead(path: string): string {
  const hash = path.indexOf('#')
  return (hash >= 0 ? path.slice(0, hash) : path).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/').replace(/\/+$/, '')
}

export function isBlockedLink(path: string): boolean {
  const head = linkHead(path)
  return /^\/?pair\/.+/i.test(head) || /^\/?sheet(\/.*)?$/i.test(head) || /^\/?new$/i.test(head)
}
