// Branch locali del progetto e cambio di branch del checkout principale. Solo `git switch` (mai un checkout di file) e, su scelta
// esplicita, `git stash push -u`. Le protezioni (sessione al lavoro, branch in un worktree, nome valido) stanno qui e nel chiamante,
// non nella UI. Un'operazione alla volta per repository (stesso lock di push e merge).
import { t } from '@shared/i18n'
import type { BranchSwitchResult, LocalBranch } from '@shared/protocol'
import { dirtyCount, gitRead, gitWrite, resolveCommit } from './git'
import { validBranchName, withRepoLock } from './git-push'

const LIST_TIMEOUT_MS = 10_000
/** Branch locali al massimo nell'elenco: oltre, il menu non serve più e la ricerca è nel terminale. */
const MAX_BRANCHES = 500

/** Branch estratto nel checkout principale; null con HEAD staccato (o se git non risponde). */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    return (await gitRead(root, ['symbolic-ref', '--short', '-q', 'HEAD'], LIST_TIMEOUT_MS)).trim() || null
  } catch {
    return null
  }
}

/** Branch estratti negli altri worktree: nome → cartella. Il primo blocco di `git worktree list` è il checkout principale e si salta. */
async function worktreeBranches(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let text: string
  try {
    text = await gitRead(root, ['worktree', 'list', '--porcelain'], LIST_TIMEOUT_MS)
  } catch {
    return out
  }
  for (const [index, block] of text.split(/\n\n+/).entries()) {
    if (index === 0) continue
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (path && ref) out.set(ref, path)
  }
  return out
}

/** Branch locali, l'ultimo commit più recente prima, con quello attuale e quelli già estratti in un worktree. */
export async function listLocalBranches(root: string): Promise<{ current: string | null; branches: LocalBranch[] }> {
  const [current, worktrees, text] = await Promise.all([
    currentBranch(root),
    worktreeBranches(root),
    // Un errore di git qui è un errore vero (repo illeggibile, timeout), non "nessun branch".
    gitRead(root, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES}`, '--format=%(refname)%1f%(committerdate:unix)%1f%(contents:subject)', 'refs/heads'], LIST_TIMEOUT_MS)
  ])
  const branches: LocalBranch[] = []
  for (const line of text.split('\n')) {
    const [ref, at, subject] = line.split('\x1f')
    if (!ref?.startsWith('refs/heads/')) continue
    const name = ref.slice('refs/heads/'.length)
    branches.push({ name, at: (Number(at) || 0) * 1000, subject: (subject ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200), current: name === current, worktree: worktrees.get(name) ?? null })
  }
  // Il branch attuale ci deve essere anche se, per il limite, non è tra i più recenti (o se il repo non ha ancora commit).
  if (current && !branches.some((b) => b.name === current)) branches.unshift({ name: current, at: 0, subject: '', current: true, worktree: null })
  return { current, branches }
}

/** Il testo di un errore di git per le cause che l'utente può correggere; altrimenti il testo di git com'è. */
function switchFailure(message: string, branch: string, folder: string | null): string {
  if (/already (checked out|used by worktree)/i.test(message)) {
    return t('“{branch}” is already checked out in another worktree{folder}. Open that session, or remove the worktree, to use the branch here.', { branch, folder: folder ? ` (${folder})` : '' })
  }
  if (/would be overwritten|commit your changes or stash|local changes/i.test(message)) {
    return t('Git cannot carry your uncommitted changes onto “{branch}”: the same files differ there. Commit them or set them aside (stash), then switch.', { branch })
  }
  if (/cannot switch branch while|in the middle of|not possible because you have unmerged files|unresolved conflict/i.test(message)) {
    return t('Git is in the middle of another operation (rebase, merge or similar) in the project folder. Finish or abort it first.')
  }
  if (/invalid reference|not a valid|did not match any|unknown (branch|revision)/i.test(message)) {
    return t('The branch “{branch}” does not exist in this project.', { branch })
  }
  return message
}

interface SwitchOptions {
  /** Cosa fare delle modifiche non committate: portarle con sé (lo switch normale) o metterle da parte con uno stash. */
  dirty?: 'carry' | 'stash'
  /** Lancia se una sessione sta lavorando nel checkout principale: si chiama prima del lock e di nuovo dentro, subito prima di scrivere. */
  assertIdle: () => void
}

/** Nome che può essere solo un branch: niente caratteri di controllo, spazi o jolly, niente `~ ^ :` (che farebbero leggere una revisione) né `..` o `@{`. */
function plainBranchName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('-') && !/[\u0000-\u001f\u007f\s*?[\\~^:]/.test(name) && !name.includes('..') && !name.includes('@{')
}

/** Il branch locale esiste? Lo dice git sul riferimento esatto, non un elenco limitato. */
async function branchExists(root: string, name: string): Promise<boolean> {
  return plainBranchName(name) && (await resolveCommit(root, `refs/heads/${name}`)) !== null
}

/** Cambia il branch del checkout principale. Vedi `project.branch.switch` nel protocollo per le regole. */
export async function switchBranch(root: string, branch: string, options: SwitchOptions): Promise<BranchSwitchResult> {
  options.assertIdle()
  // I nomi che non sono branch locali esistenti non arrivano a git (e uno che inizia con `-` sarebbe un'opzione).
  if (!(await branchExists(root, branch))) throw new Error(t('The branch “{branch}” does not exist in this project.', { branch }))
  return withRepoLock(root, async () => {
    options.assertIdle()
    if ((await currentBranch(root)) === branch) return { branch, stash: null }
    const folder = (await worktreeBranches(root)).get(branch)
    if (folder) throw new Error(switchFailure('already checked out', branch, folder))
    let stash: StashRef | null = null
    if (options.dirty === 'stash' && (await dirtyCount(root)) > 0) stash = await stashChanges(root, branch)
    try {
      await gitWrite(root, ['switch', '--no-guess', branch])
    } catch (error) {
      const reason = switchFailure((error as Error).message, branch, null)
      // Lo stash è stato fatto per questo cambio: se non è riuscito, le modifiche tornano dove erano.
      if (stash) throw new Error(await restoreStash(root, stash, reason))
      throw new Error(reason)
    }
    return { branch, stash: stash?.message ?? null }
  })
}

/** Crea `name` dal commit attuale e lo estrae (`git switch -c`): le modifiche non committate non si toccano. */
export async function createBranch(root: string, name: string, options: Pick<SwitchOptions, 'assertIdle'>): Promise<BranchSwitchResult> {
  options.assertIdle()
  if (!validBranchName(name)) throw new Error(t('“{name}” is not a valid branch name: use letters, digits and . _ / @ + -, and no spaces.', { name }))
  return withRepoLock(root, async () => {
    options.assertIdle()
    if (await branchExists(root, name)) throw new Error(t('A branch named “{name}” already exists.', { name }))
    try {
      await gitWrite(root, ['switch', '-c', name])
    } catch (error) {
      throw new Error(switchFailure((error as Error).message, name, null))
    }
    return { branch: name, stash: null }
  })
}

/** Uno stash: lo sha non cambia mai, la posizione `stash@{n}` sì (lo stash è del repository, condiviso con i worktree). */
interface StashRef {
  sha: string
  message: string
}

/** Gli stash del repository, il più recente prima. */
async function stashEntries(root: string): Promise<{ sha: string; subject: string }[]> {
  const out = await gitRead(root, ['stash', 'list', '--format=%H%x1f%gs'], LIST_TIMEOUT_MS).catch(() => '')
  return out
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter(([sha]) => /^[0-9a-f]{40,64}$/.test(sha ?? ''))
    .map(([sha, subject]) => ({ sha, subject: subject ?? '' }))
}

/** Lo stash creato da `stash push` qui: quello nuovo (non c'era prima) che porta il nostro messaggio, anche se un altro worktree ne ha creato uno nel frattempo. */
async function newStash(root: string, before: Set<string>, message: string): Promise<StashRef | null> {
  const found = (await stashEntries(root)).find((e) => !before.has(e.sha) && e.subject.endsWith(message))
  return found ? { sha: found.sha, message } : null
}

async function stashChanges(root: string, branch: string): Promise<StashRef> {
  const message = `ladder: before switching to ${branch}`
  const before = new Set((await stashEntries(root)).map((e) => e.sha))
  try {
    await gitWrite(root, ['stash', 'push', '-u', '-m', message])
  } catch (error) {
    // Lo stash può essere stato creato prima dell'errore (per esempio nella pulizia dei file): in quel caso le modifiche sono lì.
    const created = await newStash(root, before, message)
    if (created) throw new Error(t('Git set the changes aside but then reported an error: {output} Your changes are in the stash {sha} (“{message}”). Restore them with git stash apply {sha}.', { output: (error as Error).message, sha: created.sha, message }))
    throw new Error(t('Could not set the changes aside: {output}', { output: (error as Error).message }))
  }
  const created = await newStash(root, before, message)
  // Nessuno stash nuovo (git ha trovato solo file ignorati o già puliti): niente da riprendere.
  if (!created) throw new Error(t('Could not set the changes aside: git saved nothing.'))
  return created
}

/**
 * Lo switch è fallito dopo lo stash: si riprende QUELLO stash (per sha, mai `stash pop`, che prende la cima, magari di un agente in un worktree):
 * `stash apply <sha>` e, solo se riesce, `stash drop` della sua posizione attuale. Restituisce il messaggio da mostrare (con il riferimento preciso se non riesce).
 */
async function restoreStash(root: string, stash: StashRef, reason: string): Promise<string> {
  const left = () => t('{reason} Your changes are in the stash {sha} (“{message}”). Restore them with git stash apply {sha}.', { reason, sha: stash.sha, message: stash.message })
  try {
    await gitWrite(root, ['stash', 'apply', stash.sha])
  } catch {
    return left()
  }
  // Applicato: si toglie lo stash, ma la posizione si rilegge adesso (un altro worktree può averne aggiunto uno) e deve avere ancora il nostro sha.
  const index = (await stashEntries(root)).findIndex((e) => e.sha === stash.sha)
  if (index >= 0) await gitWrite(root, ['stash', 'drop', `stash@{${index}}`]).catch(() => undefined)
  return reason
}
