import type { PermissionLevel } from '@shared/protocol'

export const PERMISSION_LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
export const permissionRank = (level: PermissionLevel) => PERMISSION_LEVELS.indexOf(level)

/** A level is allowed if it does not exceed the project's maximum; with no known maximum, all of them (the host rejects anyway). */
export function allowedLevel(level: PermissionLevel, max: PermissionLevel | null | undefined): boolean {
  return !max || permissionRank(level) <= permissionRank(max)
}
