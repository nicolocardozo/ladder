// Prompt dietro i pulsanti (Crea PR, Correggi la CI, Risolvi i conflitti, Invia i commenti, Da issue).
// Il progetto li cambia con [prompts] in .ladder/settings.toml: un percorso di file o il testo stesso.
import { readFile } from 'node:fs/promises'
import { getLocale, t } from '@shared/i18n'
import { insideRoot } from './files'
import { loadProjectSettings } from './project-settings'

// Testi inviati agli agenti: inglese predefinito, italiano se la lingua dell'app è l'italiano.
export const DEFAULT_PROMPTS_EN: Record<string, string> = {
  create_pr: `Prepare the pull request for branch {{branch}} into {{base}}.

1. Make sure all changes are committed. If commits are missing, create small ones with clear messages.
2. Push the branch to origin.
3. Write the title and description: what changes and why, how you verified it, what is left to do.
4. Create the PR with \`gh pr create --base {{base}}\` and send me the link.
{{source}}`,
  fix: `CI is failing on PR {{pr}}. Failed checks:
{{checks}}

Read the logs (for example with \`gh run view --log-failed\`), find the cause and fix it. Run the affected tests locally, then commit and push.`,
  conflicts: `Branch {{branch}} has conflicts with {{base}} in these files:
{{conflicts}}

Update the branch with {{base}} (\`git fetch origin\` and \`git merge origin/{{base}}\`), resolve the conflicts keeping the intent of both sides, run the tests and commit. If a choice is not obvious, ask me before deciding.`,
  comments: `PR {{pr}} has these review comments:

{{comments}}

Address each point: fix what needs fixing and explain where you disagree. Then commit and push.`,
  review: `Review the changes from this session in read-only mode. Point out bugs, unhandled edge cases and unclear parts, with file and line. Do not modify any files.`,
  pull_request: `Continue the work on PR {{ref}} · {{title}}
{{url}}

{{body}}

Read the branch changes against the base and the review comments, then tell me where it stands and what is missing.`,
  issue: `Work on this task.

{{ref}} · {{title}}
{{url}}

{{body}}

Before writing code, read the parts of the project involved and briefly tell me how you plan to proceed.`
}

export const DEFAULT_PROMPTS_IT: Record<string, string> = {
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

export const PROMPT_NAMES = Object.keys(DEFAULT_PROMPTS_EN)

/** Prompt predefinito `name` nella lingua attuale. */
export function defaultPrompt(name: string): string | undefined {
  return (getLocale() === 'it' ? DEFAULT_PROMPTS_IT : DEFAULT_PROMPTS_EN)[name]
}

/** Testo del prompt `name` per il progetto, con le variabili {{nome}} sostituite. Righe vuote in eccesso tolte. */
export async function renderPrompt(root: string, name: string, vars: Record<string, string>): Promise<string> {
  const settings = await loadProjectSettings(root)
  const configured = settings.prompts[name]
  let template = defaultPrompt(name) ?? ''
  if (configured) {
    // Un percorso relativo al progetto (come nel piano) oppure il testo del prompt scritto nel TOML.
    const looksLikePath = !/\n/.test(configured) && /\.(md|txt|prompt)$/i.test(configured.trim())
    if (looksLikePath) {
      try {
        template = await readFile(insideRoot(root, configured.trim()), 'utf8')
      } catch {
        throw new Error(t('Can’t find {path}, set in [prompts] {name}.', { path: configured.trim(), name }))
      }
    } else {
      template = configured
    }
  }
  if (!template) throw new Error(t('No prompt “{name}”.', { name }))
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => vars[key] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
