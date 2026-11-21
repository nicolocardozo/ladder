// Prompt dietro i pulsanti (Crea PR, Correggi la CI, Risolvi i conflitti, Invia i commenti, Da issue).
// Il progetto li cambia con [prompts] in .ladder/settings.toml: un percorso di file o il testo stesso.
import { readFile } from 'node:fs/promises'
import { getLocale, t } from '@shared/i18n'
import { insideRoot } from './files'
import { loadProjectSettings } from './project-settings'

// Testi inviati agli agenti: inglese predefinito, italiano se la lingua dell'app è l'italiano.
export const DEFAULT_PROMPTS_EN: Record<string, string> = {
  create_pr: `Open the pull request for branch {{branch}} into {{base}}. I wrote the title and the description myself and saved them in two files: use them exactly as they are. Do not rewrite, shorten or "improve" them, and never paste their contents into a command.

1. Make sure all changes are committed. If commits are missing, create small ones with clear messages. Do not add Co-Authored-By lines.
2. Push the branch to origin.
3. Create the PR with this command, exactly as written (the title file holds one line, the description file the Markdown body):
   \`gh pr create --base {{base_arg}} --title "$(cat {{title_file}})" --body-file {{body_file}}\`
   If the description file is empty, drop \`--body-file\` and pass \`--body ""\` instead.
4. Send me the PR link.`,
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
  create_pr: `Apri la pull request del branch {{branch}} verso {{base}}. Titolo e descrizione li ho scritti io e li ho salvati in due file: usali esattamente così come sono. Non riscriverli, non accorciarli e non "migliorarli", e non incollarne mai il contenuto in un comando.

1. Controlla che tutte le modifiche siano committate. Se mancano commit, creane di piccoli con messaggi chiari. Non aggiungere righe Co-Authored-By.
2. Pubblica il branch su origin.
3. Crea la PR con questo comando, esattamente come scritto (il file del titolo contiene una riga, quello della descrizione il testo Markdown):
   \`gh pr create --base {{base_arg}} --title "$(cat {{title_file}})" --body-file {{body_file}}\`
   Se il file della descrizione è vuoto, togli \`--body-file\` e passa \`--body ""\`.
4. Scrivimi il link della PR.`,
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

/**
 * Blocco accodato a un `create_pr` personalizzato che non usa {{title_file}} / {{body_file}}: i dati della PR non si
 * perdono mai in silenzio. Dice dove stanno i file e il comando da usare (titolo letto dal file, mai incollato).
 */
const PR_FILES_BLOCK: Record<'en' | 'it', string> = {
  en: `The PR title and description are saved in files (data, never paste their contents into a command). Title, one line: {{title_file}}. Description: {{body_file}}.
Create the PR with this command, exactly as written: \`gh pr create --base {{base_arg}} --title "$(cat {{title_file}})" --body-file {{body_file}}\`. If the description file is empty, drop \`--body-file\` and pass \`--body ""\`.`,
  it: `Titolo e descrizione della PR sono salvati in file (sono dati: non incollarne mai il contenuto in un comando). Titolo, una riga: {{title_file}}. Descrizione: {{body_file}}.
Crea la PR con questo comando, esattamente come scritto: \`gh pr create --base {{base_arg}} --title "$(cat {{title_file}})" --body-file {{body_file}}\`. Se il file della descrizione è vuoto, togli \`--body-file\` e passa \`--body ""\`.`
}

/**
 * Variabili con testo scritto dall'utente: si inseriscono senza toccarle. `title` e `body` restano per i `create_pr`
 * personalizzati scritti prima dei file (l'host non li passa più ai prompt predefiniti).
 */
const VERBATIM_VARS = new Set(['title', 'body'])

export const PROMPT_NAMES = Object.keys(DEFAULT_PROMPTS_EN)

/** Prompt predefinito `name` nella lingua attuale. */
export function defaultPrompt(name: string): string | undefined {
  return (getLocale() === 'it' ? DEFAULT_PROMPTS_IT : DEFAULT_PROMPTS_EN)[name]
}

/** Modello del prompt `name`: quello del progetto ([prompts]) oppure il predefinito. */
async function loadTemplate(root: string, name: string): Promise<string> {
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
}

/** Sostituisce le variabili {{nome}}; quelle assenti diventano stringa vuota. Righe vuote in eccesso tolte. */
function fill(template: string, vars: Record<string, string>): string {
  // `title` e `body` sono dati dell'utente (PR): entrano dopo la pulizia delle righe vuote, così restano com'erano scritti.
  const verbatim = new Map<string, string>()
  const text = template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => {
      if (VERBATIM_VARS.has(key) && key in vars) {
        const token = `\u0000${verbatim.size}\u0000`
        verbatim.set(token, vars[key])
        return token
      }
      return vars[key] ?? ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.replace(/\u0000\d+\u0000/g, (token) => verbatim.get(token) ?? '')
}

/** Testo del prompt `name` per il progetto, con le variabili {{nome}} sostituite. Righe vuote in eccesso tolte. */
export async function renderPrompt(root: string, name: string, vars: Record<string, string>): Promise<string> {
  return fill(await loadTemplate(root, name), vars)
}

/** Tra apici singoli, per incollarlo in una riga di shell come un solo argomento letterale. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Prompt `create_pr` con i file di titolo e descrizione già scritti dall'host. Le variabili `title_file`, `body_file` e
 * `base_arg` sono già tra apici per la shell. Un modello personalizzato che non usa i file (o non usa il file della
 * descrizione, se c'è) riceve in coda il blocco standard: titolo e descrizione non vanno mai persi. `{{source}}`
 * (la vecchia riga dell'issue) non esiste più: si sostituisce sempre con una stringa vuota.
 */
export async function renderPrPrompt(root: string, input: { branch: string; base: string; titlePath: string; bodyPath: string; title: string; body: string }): Promise<string> {
  const template = await loadTemplate(root, 'create_pr')
  const vars: Record<string, string> = {
    branch: input.branch,
    base: input.base,
    base_arg: shellQuote(input.base),
    title_file: shellQuote(input.titlePath),
    body_file: shellQuote(input.bodyPath),
    title: input.title,
    body: input.body,
    source: ''
  }
  const uses = (name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i').test(template)
  const complete = uses('title_file') && (uses('body_file') || input.body.length === 0)
  const text = fill(template, vars)
  return complete ? text : `${text}\n\n${fill(PR_FILES_BLOCK[getLocale() === 'it' ? 'it' : 'en'], vars)}`
}
