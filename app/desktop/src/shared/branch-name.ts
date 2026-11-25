// Branch name that Ladder agrees to create and push: shared by host (push, new branch) and UI (name field before starting).

/**
 * Branch name accepted for push: Unicode letters and digits, `. _ / @ + -`, doesn't start with `-` or `.`, no `..`, `@{`, `//`,
 * components that start with `.` or end with `.lock`. Stricter than git (no spaces, `;`, `~^:?*[\`, control characters, emoji):
 * what doesn't pass is not pushed from Ladder.
 */
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._/@+-]*$/u.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//') || name.endsWith('/') || name.endsWith('.')) return false
  return !name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
}
