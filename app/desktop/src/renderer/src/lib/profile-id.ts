// Id dei profili (LAD-23): il predefinito è `default:<agente>` oppure assente/null. Senza dipendenze, così lo store può importarlo.
export function isDefaultProfileId(id: string | null | undefined): boolean {
  return !id || id.startsWith('default:')
}
