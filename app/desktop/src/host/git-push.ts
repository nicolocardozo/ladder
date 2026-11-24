// Push di Ladder (LAD-69): solo su azione esplicita dell'utente, mai force, con anteprima di ciò che parte. Niente shell, niente
// interpolazione: nomi di branch e remote validati, argomenti passati a git come lista, `--` prima di remote e refspec.
import { validBranchName } from '@shared/branch-name'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { t } from '@shared/i18n'
import type { GitPushPreview, GitPushResult } from '@shared/protocol'
import { gitRead, gitStatus, redactUrls, tailOutput, validRemoteName } from './git'
import { gitNetworkEnv } from './git-status'
import { withRepoLock } from './repo-lock'

/** Un push (hook pre-push compresi) che non finisce entro questo tempo si ferma con tutto il suo gruppo di processi. */
export const PUSH_TIMEOUT_MS = 3 * 60_000
/** Commit mostrati nell'anteprima. */
const MAX_PREVIEW_COMMITS = 50

export { validBranchName }

export { validRemoteName }

// Un'operazione alla volta per repository (push, merge, archivia; il fetch in background cede il passo): vedi repo-lock.ts.
export { withRepoLock } from './repo-lock'

// ── Piano del push ───────────────────────────────────────────────────────────

interface Plan {
  branch: string
  /** Sha completo di HEAD; '' se il branch non ha commit. */
  head: string
  remotes: string[]
  /** Remote a cui va il push; null se manca. */
  remote: string | null
  /** L'upstream è esattamente la destinazione (stesso remote, stesso nome del branch locale): conteggi dall'upstream, niente `-u`. */
  tracked: boolean
  upstream: string | null
  /** Upstream che punta altrove (altro nome o altro remote): non è la destinazione. */
  upstreamElsewhere: string | null
  /** Riferimento locale di `<remote>/<branch>` se esiste già (ultimo fetch): base per contare cosa parte. */
  targetRef: string | null
  ahead: number
  behind: number
  problem: GitPushPreview['problem']
}

/**
 * Piano del push. Regola di sicurezza: la destinazione ha SEMPRE lo stesso nome del branch locale. L'upstream conta solo se è
 * proprio quel branch sul remote di push: con `git switch -c feat origin/main` l'upstream è origin/main, ma il push NON va su main:
 * si propone di pubblicare `<remote>/feat` (e l'anteprima segnala l'upstream altrove). Il remote è, in ordine: quello richiesto,
 * `branch.<b>.pushRemote`, `remote.pushDefault`, quello dell'upstream, l'unico del repo.
 */
async function readPlan(root: string, requested: string | undefined): Promise<Plan> {
  const status = await gitStatus(root, false, false)
  if (!status) throw new Error(t('The folder is not a git repository.'))
  if (!status.branch) throw new Error(t('HEAD is detached: switch to a branch before pushing.'))
  const branch = status.branch
  if (!validBranchName(branch)) throw new Error(t('Ladder cannot push the branch “{name}”: its name has characters outside letters, digits and . _ / @ + -.', { name: branch }))
  if (requested !== undefined && !validRemoteName(requested)) throw new Error(t('“{name}” is not a valid remote name.', { name: requested }))
  const remotes = (await gitRead(root, ['remote']).catch(() => '')).split('\n').map((r) => r.trim()).filter(validRemoteName)
  if (requested !== undefined && !remotes.includes(requested)) throw new Error(t('“{name}” is not a remote of this repository.', { name: requested }))

  const config = async (key: string) => (await gitRead(root, ['config', '--get', key]).catch(() => '')).trim()
  const cfgRemote = await config(`branch.${branch}.remote`)
  const merge = await config(`branch.${branch}.merge`)
  const pushRemote = [await config(`branch.${branch}.pushRemote`), await config('remote.pushDefault')].find((r) => remotes.includes(r)) ?? null
  const mergeBranch = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : ''
  const upstreamOk = status.hasUpstream && remotes.includes(cfgRemote) && validBranchName(mergeBranch)
  const tracked = upstreamOk && mergeBranch === branch && (pushRemote === null || pushRemote === cfgRemote)
  if (tracked && requested !== undefined && requested !== cfgRemote) throw new Error(t('The branch follows “{upstream}”: it can only be pushed to that remote.', { upstream: status.upstream ?? cfgRemote }))

  let remote: string | null = null
  let problem: Plan['problem'] = null
  if (tracked) remote = cfgRemote
  else if (requested !== undefined) remote = requested
  else if (pushRemote) remote = pushRemote
  else if (remotes.includes(cfgRemote)) remote = cfgRemote
  else if (remotes.length === 1) remote = remotes[0]
  else problem = remotes.length === 0 ? 'no-remote' : 'choose-remote'

  const head = (await gitRead(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
  // Pubblicazione su un branch che il remote ha già (ultimo fetch): si conta rispetto a quello, non a tutto il remote.
  let targetRef: string | null = null
  let ahead = status.ahead
  let behind = status.behind
  if (!tracked && remote && head) {
    const ref = `refs/remotes/${remote}/${branch}`
    if ((await gitRead(root, ['rev-parse', '--verify', '-q', ref]).catch(() => '')).trim()) {
      targetRef = ref
      const [a, b] = (await gitRead(root, ['rev-list', '--left-right', '--count', `HEAD...${ref}`]).catch(() => '0\t0')).trim().split(/\s+/).map(Number)
      ahead = a || 0
      behind = b || 0
    }
  }
  return {
    branch,
    head,
    remotes,
    remote,
    tracked,
    upstream: tracked ? status.upstream : null,
    upstreamElsewhere: !tracked && status.hasUpstream ? status.upstream : null,
    targetRef,
    ahead: tracked || targetRef ? ahead : 0,
    behind: tracked || targetRef ? behind : 0,
    problem
  }
}

/** Revisioni dei commit che il push invierebbe: quelli dopo l'upstream (o dopo `<remote>/<branch>`), o quelli che il remote (qualunque se manca) non ha. */
function pending(plan: Plan): string[] {
  if (plan.tracked) return ['@{upstream}..HEAD']
  if (plan.targetRef) return [`${plan.targetRef}..HEAD`]
  return ['HEAD', '--not', plan.remote ? `--remotes=${plan.remote}` : '--remotes']
}

/** Quanti commit invierebbe il push. */
async function pendingCount(root: string, plan: Plan, lenient: boolean): Promise<number> {
  if (plan.tracked || plan.targetRef) return plan.ahead
  const read = gitRead(root, ['rev-list', '--count', ...pending(plan)])
  return Number((await (lenient ? read.catch(() => '0') : read)).trim()) || 0
}

/** Cosa invierebbe `git.push`: solo git locale (l'upstream è quello dell'ultimo fetch), nessuna rete. */
export async function pushPreview(root: string, opts: { remote?: string } = {}): Promise<GitPushPreview> {
  const plan = await readPlan(root, opts.remote)
  let commits: GitPushPreview['commits'] = []
  let total = 0
  try {
    total = await pendingCount(root, plan, false)
    if (total > 0) {
      const out = await gitRead(root, ['log', `--max-count=${MAX_PREVIEW_COMMITS}`, '--format=%h%x1f%s', ...pending(plan), '--'])
      commits = out.split('\n').filter(Boolean).map((line) => {
        const [hash, ...rest] = line.split('\x1f')
        return { hash, subject: rest.join('\x1f') }
      })
    }
  } catch {
    // Nessun commit ancora (branch appena nato): niente da inviare.
  }
  return {
    branch: plan.branch,
    remote: plan.remote,
    remotes: plan.remotes,
    upstream: plan.tracked ? plan.upstream : plan.upstreamElsewhere,
    target: plan.remote ? `${plan.remote}/${plan.branch}` : null,
    upstreamElsewhere: plan.upstreamElsewhere,
    head: plan.head,
    willPublish: !plan.tracked,
    commits,
    total,
    behind: plan.behind,
    wouldBeRejected: plan.behind > 0 && total > 0,
    problem: plan.problem
  }
}

// ── Push ─────────────────────────────────────────────────────────────────────

/**
 * Invia il branch corrente a `<remote>/<stesso nome>`. Se l'upstream è proprio quello: push semplice; altrimenti (non pubblicato,
 * upstream su un altro branch o `publish`): `-u`, che imposta l'upstream solo se il push riesce. Il refspec è esplicito e senza `+`:
 * mai force, mai su un branch con nome diverso, qualunque cosa dicano le config del repo. `busy` dice se l'agente sta
 * lavorando nella cartella (potrebbe star facendo git): in quel caso non si parte. `expectedHead`: lo sha mostrato nell'anteprima.
 */
export async function pushBranch(root: string, opts: { publish?: boolean; remote?: string; expectedHead?: string }, busy: () => boolean): Promise<GitPushResult> {
  return withRepoLock(root, async () => {
    const working = () => new Error(t('The agent is working in this folder: wait for it to finish before pushing.'))
    if (busy()) throw working()
    const plan = await readPlan(root, opts.remote)
    if (plan.problem === 'no-remote') throw new Error(t('This repository has no remote to push to.'))
    if (plan.problem === 'choose-remote' || !plan.remote) throw new Error(t('The repository has several remotes: choose which one to push to.'))
    if (opts.expectedHead !== undefined && opts.expectedHead !== plan.head) throw new Error(t('The branch changed after the preview: reopen the confirmation.'))
    const total = await pendingCount(root, plan, true)
    if (total === 0 && (plan.tracked || plan.targetRef) && opts.publish !== true) throw new Error(t('Nothing to push: the branch is up to date with {upstream}.', { upstream: plan.tracked ? (plan.upstream ?? plan.remote) : `${plan.remote}/${plan.branch}` }))
    const publish = !plan.tracked || opts.publish === true
    const refspec = `refs/heads/${plan.branch}:refs/heads/${plan.branch}`
    // L'agente può essersi messo al lavoro mentre si leggeva il piano.
    if (busy()) throw working()
    const run = await runPush(root, [...(publish ? ['-u'] : []), '--', plan.remote, refspec])
    if (run.timedOut) throw new Error(t('The push did not finish in {minutes} minutes and was stopped.', { minutes: String(Math.round(PUSH_TIMEOUT_MS / 60_000)) }))
    if (run.code !== 0) throw new Error(await pushErrorText(root, run.output))
    return { branch: plan.branch, remote: plan.remote, pushed: total, upstream: `${plan.remote}/${plan.branch}`, published: !plan.tracked }
  })
}

/** `git push` non interattivo, in un gruppo di processi a sé (hook compresi): allo scadere si ferma tutto. */
async function runPush(root: string, args: string[]): Promise<{ code: number; output: string; timedOut: boolean }> {
  const env = await gitNetworkEnv(root)
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'color.ui=false', 'push', ...args], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 3_000).unref()
    }, PUSH_TIMEOUT_MS)
    // Si tiene la coda: un hook molto loquace non gonfia la memoria.
    const collect = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 200_000) output = output.slice(-100_000)
    }
    child.stdout!.on('data', collect)
    child.stderr!.on('data', collect)
    child.on('error', (error) => (clearTimeout(timer), reject(error)))
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? 1, output: output.trim(), timedOut })))
  })
}

async function pushErrorText(root: string, output: string): Promise<string> {
  const hook = await gitRead(root, ['rev-parse', '--git-path', 'hooks/pre-push']).then((p) => {
    const path = p.trim()
    return existsSync(isAbsolute(path) ? path : join(root, path))
  }, () => false)
  return translatePushError(output, hook)
}

/**
 * Messaggio leggibile per l'output di un push fallito, con SEMPRE la coda dell'output (un hook o un helper può aver scritto il vero
 * motivo). Ordine: prima gli errori che solo git scrive (credenziali, rete nelle righe `fatal:`/`ssh:`, rifiuti del remote), poi l'hook
 * pre-push, poi le stesse parole cercate ovunque. Così un hook che stampa "Connection refused" non passa per un guasto di rete.
 * `hasPrePushHook`: nel repo c'è un hook pre-push.
 */
export function translatePushError(output: string, hasPrePushHook: boolean): string {
  const tail = redactUrls(tailOutput(output))
  const withTail = (message: string) => (tail ? `${message}\n${tail}` : message)
  const authError = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or password|Host key verification failed|error: 40[13]|returned error: 40[13]|Permission to .+ denied/i
  const networkWords = 'Could not resolve host|Connection (timed out|refused|reset|closed)|Network is unreachable|No route to host|Operation timed out|does not appear to be a git repository|Could not read from remote repository|unable to access|Failed to connect|ssh: connect to host'
  // Righe che scrive git (o ssh), non un hook: `fatal: unable to access…`, `ssh: connect to host… Connection refused`.
  const gitNetwork = new RegExp(`^(fatal|ssh|error): .*(${networkWords})`, 'im')
  const authText = t('Git could not sign in to the remote. Check your credentials (SSH key, credential helper or token) and try again. Ladder never asks for passwords.')
  const networkText = t('The remote could not be reached. Check your connection and the remote address, then try again.')
  if (authError.test(output)) return withTail(authText)
  if (gitNetwork.test(output)) return withTail(networkText)
  if (/\[remote rejected\]|hook declined|^remote: error|GH006/im.test(output)) return t('The remote refused the push:\n{output}', { output: tail })
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(output))
    return t('The push was rejected because the remote has commits this branch does not have. Update the branch from the remote and push again. Nothing was changed.')
  if (hasPrePushHook) return t('A pre-push hook stopped the push:\n{output}', { output: tail })
  if (new RegExp(networkWords, 'i').test(output)) return withTail(networkText)
  return t('Push failed:\n{output}', { output: tail || 'git push' })
}
