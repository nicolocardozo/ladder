// Prompt dietro i pulsanti (Crea PR, Correggi la CI, Risolvi i conflitti, Invia i commenti, Da issue).
// Il progetto li cambia con [prompts] in .ladder/settings.toml: un percorso di file o il testo stesso.
import { readFile } from 'node:fs/promises'
import { insideRoot } from './files'
import { loadProjectSettings } from './project-settings'

export const DEFAULT_PROMPTS: Record<string, string> = {
  create_pr: `Prepara la pull request del branch {{branch}} verso {{base}}.

1. Controlla che tutte le modifiche siano committate. Se mancano commit, creane di piccoli con messaggi chiari.
2. Pubblica il branch su origin.
3. Scrivi titolo e descrizione: cosa cambia e perché, come l'hai verificato, cosa resta da fare.
4. Crea la PR con \`gh pr create --base {{base}}\` e scrivimi il link.
{{source}}`,
  fix: `La CI della PR {{pr}} non passa. Controlli falliti:
{{checks}}

Leggi i log (per esempio con \`gh run view --log-failed\`), trova la causa e correggila. Esegui in locale i test coinvolti, poi fai commit e push.`,
  conflicts: `Il branch {{branch}} ha conflitti con {{base}} in questi file:
{{conflicts}}

Aggiorna il branch con {{base}} (\`git fetch origin\` e \`git merge origin/{{base}}\`), risolvi i conflitti mantenendo l'intento di entrambe le parti, esegui i test e fai commit. Se una scelta non è ovvia, chiedimi prima di decidere.`,
  comments: `Sulla PR {{pr}} ci sono questi commenti di review:

{{comments}}

Rispondi a ogni punto: correggi dove serve e spiega dove non sei d'accordo. Poi fai commit e push.`,
  review: `Rivedi le modifiche di questa sessione in sola lettura. Segnala bug, casi limite non gestiti e punti poco chiari, con file e riga. Non modificare i file.`,
  pull_request: `Continua il lavoro sulla PR {{ref}} · {{title}}
{{url}}

{{body}}

Leggi le modifiche del branch rispetto alla base e i commenti di review, poi dimmi a che punto è e cosa manca.`,
  issue: `Lavora su questa attività.

{{ref}} · {{title}}
{{url}}

{{body}}

Prima di scrivere codice leggi le parti del progetto coinvolte e dimmi in breve come pensi di procedere.`
}

export const PROMPT_NAMES = Object.keys(DEFAULT_PROMPTS)

/** Testo del prompt `name` per il progetto, con le variabili {{nome}} sostituite. Righe vuote in eccesso tolte. */
export async function renderPrompt(root: string, name: string, vars: Record<string, string>): Promise<string> {
  const settings = await loadProjectSettings(root)
  const configured = settings.prompts[name]
  let template = DEFAULT_PROMPTS[name] ?? ''
  if (configured) {
    // Un percorso relativo al progetto (come nel piano) oppure il testo del prompt scritto nel TOML.
    const looksLikePath = !/\n/.test(configured) && /\.(md|txt|prompt)$/i.test(configured.trim())
    if (looksLikePath) {
      try {
        template = await readFile(insideRoot(root, configured.trim()), 'utf8')
      } catch {
        throw new Error(`Non trovo ${configured.trim()}, indicato in [prompts] ${name}.`)
      }
    } else {
      template = configured
    }
  }
  if (!template) throw new Error(`Nessun prompt “${name}”.`)
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => vars[key] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
