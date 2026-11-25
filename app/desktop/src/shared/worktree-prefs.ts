// Checks on worktree preferences, shared by main (which saves them) and host (which uses them).

export const DEFAULT_BRANCH_PREFIX = 'ladder/'

/** Valid prefix for git branch names, otherwise the default. Empty = no prefix. */
export function cleanBranchPrefix(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRANCH_PREFIX
  const prefix = raw.trim()
  if (prefix === '') return ''
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix) && !prefix.includes('..') && !prefix.includes('//') && !prefix.includes('@{') && !prefix.split('/').some((part) => part.endsWith('.lock') || part.startsWith('.'))
  return valid && prefix.length <= 40 ? prefix : DEFAULT_BRANCH_PREFIX
}
