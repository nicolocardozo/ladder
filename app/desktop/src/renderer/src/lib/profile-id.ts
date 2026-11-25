// Profile ids: the default is `default:<agent>` or absent/null. No dependencies, so the store can import it.
export function isDefaultProfileId(id: string | null | undefined): boolean {
  return !id || id.startsWith('default:')
}
