// Nome di branch che Ladder accetta di creare e di inviare: comune a host (push, nuovo branch) e UI (campo del nome prima di partire).

/**
 * Nome di branch accettato per il push: lettere e cifre Unicode, `. _ / @ + -`, non inizia con `-` o `.`, niente `..`, `@{`, `//`,
 * componenti che iniziano con `.` o finiscono con `.lock`. Più stretto di git (niente spazi, `;`, `~^:?*[\`, controlli, emoji):
 * quello che non passa non si invia da Ladder.
 */
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/@+-]*$/u.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//') || name.endsWith('/') || name.endsWith('.')) return false
  return !name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
}
