// Ladder push: only on explicit user action, never force, with a preview of what goes out. No shell, no
// interpolation: branch and remote names validated, arguments passed to git as a list, `--` before remote and refspec.
import { validBranchName } from '@shared/branch-name'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { t } from '@shared/i18n'
import type { GitPushPreview, GitPushResult } from '@shared/protocol'
import { gitRead, gitStatus, redactUrls, tailOutput, validRemoteName } from './git'
import { gitNetworkEnv } from './git-status'
import { withRepoLock } from './repo-lock'

/** A push (pre-push hooks included) that does not finish within this time is stopped along with its whole process group. */
export const PUSH_TIMEOUT_MS = 3 * 60_000
/** Commits shown in the preview. */
const MAX_PREVIEW_COMMITS = 50

export { validBranchName }

export { validRemoteName }

// One operation at a time per repository (push, merge, archive; background fetch yields): see repo-lock.ts.
export { withRepoLock } from './repo-lock'

// ── Push plan ────────────────────────────────────────────────────────────────

interface Plan {
  branch: string
  /** Full sha of HEAD; '' if the branch has no commits. */
  head: string
  remotes: string[]
  /** Remote the push goes to; null if missing. */
  remote: string | null
  /** The upstream is exactly the destination (same remote, same name as the local branch): counts come from the upstream, no `-u`. */
  tracked: boolean
  upstream: string | null
  /** Upstream pointing elsewhere (another name or another remote): it is not the destination. */
  upstreamElsewhere: string | null
  /** Local ref of `<remote>/<branch>` if it already exists (last fetch): basis for counting what goes out. */
  targetRef: string | null
  ahead: number
  behind: number
  problem: GitPushPreview['problem']
}

/**
 * Push plan. Safety rule: the destination ALWAYS has the same name as the local branch. The upstream counts only if it is
 * exactly that branch on the push remote: with `git switch -c feat origin/main` the upstream is origin/main, but the push does NOT go to main:
 * it proposes publishing `<remote>/feat` (and the preview flags the upstream elsewhere). The remote is, in order: the requested one,
 * `branch.<b>.pushRemote`, `remote.pushDefault`, the upstream's, the repo's only one.
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
  // Publishing to a branch the remote already has (last fetch): count against that, not against the whole remote.
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

/** Revisions of the commits the push would send: those after the upstream (or after `<remote>/<branch>`), or those the remote (any if missing) does not have. */
function pending(plan: Plan): string[] {
  if (plan.tracked) return ['@{upstream}..HEAD']
  if (plan.targetRef) return [`${plan.targetRef}..HEAD`]
  return ['HEAD', '--not', plan.remote ? `--remotes=${plan.remote}` : '--remotes']
}

/** How many commits the push would send. */
async function pendingCount(root: string, plan: Plan, lenient: boolean): Promise<number> {
  if (plan.tracked || plan.targetRef) return plan.ahead
  const read = gitRead(root, ['rev-list', '--count', ...pending(plan)])
  return Number((await (lenient ? read.catch(() => '0') : read)).trim()) || 0
}

/** What `git.push` would send: local git only (the upstream is that of the last fetch), no network. */
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
    // No commits yet (newborn branch): nothing to send.
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
 * Sends the current branch to `<remote>/<same name>`. If the upstream is exactly that: plain push; otherwise (unpublished,
 * upstream on another branch or `publish`): `-u`, which sets the upstream only if the push succeeds. The refspec is explicit and has no `+`:
 * never force, never to a branch with a different name, whatever the repo's config says. `busy` says whether the agent is
 * working in the folder (it might be running git): in that case we do not start. `expectedHead`: the sha shown in the preview.
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
    // The agent may have started working while the plan was being read.
    if (busy()) throw working()
    const run = await runPush(root, [...(publish ? ['-u'] : []), '--', plan.remote, refspec])
    if (run.timedOut) throw new Error(t('The push did not finish in {minutes} minutes and was stopped.', { minutes: String(Math.round(PUSH_TIMEOUT_MS / 60_000)) }))
    if (run.code !== 0) throw new Error(await pushErrorText(root, run.output))
    return { branch: plan.branch, remote: plan.remote, pushed: total, upstream: `${plan.remote}/${plan.branch}`, published: !plan.tracked }
  })
}

/** Non-interactive `git push`, in its own process group (hooks included): on timeout everything is stopped. */
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
    // Keep the tail: a very chatty hook does not bloat memory.
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
 * Readable message for a failed push's output, ALWAYS with the tail of the output (a hook or helper may have written the real
 * reason). Order: first the errors only git writes (credentials, network in `fatal:`/`ssh:` lines, remote rejections), then the
 * pre-push hook, then the same words searched anywhere. This way a hook that prints "Connection refused" is not mistaken for a network failure.
 * `hasPrePushHook`: the repo has a pre-push hook.
 */
export function translatePushError(output: string, hasPrePushHook: boolean): string {
  const tail = redactUrls(tailOutput(output))
  const withTail = (message: string) => (tail ? `${message}\n${tail}` : message)
  const authError = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or password|Host key verification failed|error: 40[13]|returned error: 40[13]|Permission to .+ denied/i
  const networkWords = 'Could not resolve host|Connection (timed out|refused|reset|closed)|Network is unreachable|No route to host|Operation timed out|does not appear to be a git repository|Could not read from remote repository|unable to access|Failed to connect|ssh: connect to host'
  // Lines written by git (or ssh), not a hook: `fatal: unable to access…`, `ssh: connect to host… Connection refused`.
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
