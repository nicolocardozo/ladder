// Controlli sulle preferenze dei worktree, comuni a main (che le salva) e host (che le usa).

export const DEFAULT_BRANCH_PREFIX = 'ladder/'

/** Prefisso valido per i nomi di branch di git, altrimenti quello predefinito. Vuoto = nessun prefisso. */
export function cleanBranchPrefix(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRANCH_PREFIX
  const prefix = raw.trim()
  if (prefix === '') return ''
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix) && !prefix.includes('..') && !prefix.includes('//') && !prefix.includes('@{') && !prefix.split('/').some((part) => part.endsWith('.lock') || part.startsWith('.'))
  return valid && prefix.length <= 40 ? prefix : DEFAULT_BRANCH_PREFIX
}
