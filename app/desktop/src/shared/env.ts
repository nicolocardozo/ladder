// Ambiente dei processi figli: condiviso da host e main, così la regola per le variabili tolte è una sola.

/** Copia dell'ambiente senza le variabili ANTHROPIC_* e CLAUDE*: una chiave API passerebbe alla fatturazione a consumo. `strip` toglie anche altri nomi. */
export function cleanEnv(strip: readonly string[] = []): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key) || strip.includes(key)) continue
    env[key] = value
  }
  return env
}
