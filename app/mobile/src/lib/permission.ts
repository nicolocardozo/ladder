import type { PermissionLevel } from '@shared/protocol'

export const PERMISSION_LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
export const permissionRank = (level: PermissionLevel) => PERMISSION_LEVELS.indexOf(level)

/** Un livello è consentito se non supera il massimo del progetto; senza massimo noto, tutti (l'host rifiuta comunque). */
export function allowedLevel(level: PermissionLevel, max: PermissionLevel | null | undefined): boolean {
  return !max || permissionRank(level) <= permissionRank(max)
}
