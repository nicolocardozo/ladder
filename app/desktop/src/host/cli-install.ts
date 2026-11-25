// Installation of the `ladder` terminal command: a symlink `~/.local/bin/ladder` to the script inside the app.
// It never overwrites a file that is not our own link. No path aliases (scripts/cli.test.mts tests it).
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CliStatus } from '../shared/protocol'

export interface CliInstallDeps {
  /** CLI script inside the app (Resources/bin/ladder, or the development script); null if there is none. */
  bin: string | null
  /** Socket on which the host listens, or null. */
  socket: () => string | null
  /** The login shell's PATH. */
  shellPath: () => Promise<string>
  t: (text: string, vars?: Record<string, string | number>) => string
  home?: string
}

/** A Ladder CLI script: the app's (`…/Ladder.app/…/bin/ladder`) or the development one (`…/src/cli/bin/ladder-dev`). */
export function isLadderScript(target: string): boolean {
  const name = basename(target)
  return (name === 'ladder' && /\.app\/Contents\/Resources\/bin\/ladder$/.test(target)) || (name === 'ladder-dev' && target.includes('/src/cli/bin/'))
}

export class CliInstall {
  private readonly deps: CliInstallDeps

  constructor(deps: CliInstallDeps) {
    this.deps = deps
  }

  private get link(): string {
    return join(this.deps.home ?? homedir(), '.local', 'bin', 'ladder')
  }

  /** What is in place of the link: nothing, our own link (and where it points), or something else. */
  private async inspect(): Promise<{ kind: 'none' } | { kind: 'ours'; target: string } | { kind: 'other' }> {
    const info = await lstat(this.link).catch(() => null)
    if (!info) return { kind: 'none' }
    if (!info.isSymbolicLink()) return { kind: 'other' }
    const target = resolve(dirname(this.link), await readlink(this.link))
    return isLadderScript(target) ? { kind: 'ours', target } : { kind: 'other' }
  }

  async status(): Promise<CliStatus> {
    const found = await this.inspect()
    const dir = dirname(this.link)
    const path = await this.deps.shellPath().catch(() => '')
    return {
      installed: found.kind === 'ours' && !!this.deps.bin && found.target === resolve(this.deps.bin),
      path: this.link,
      inPath: path.split(':').some((entry) => entry === dir || entry === dir.replace(this.deps.home ?? homedir(), '~')),
      socket: this.deps.socket()
    }
  }

  async install(): Promise<CliStatus> {
    const { bin, t } = this.deps
    if (!bin) throw new Error(t('The command line tool is not part of this build.'))
    const found = await this.inspect()
    if (found.kind === 'other') throw new Error(t('{path} already exists and is not the Ladder command. Move it away and try again.', { path: this.link }))
    try {
      await mkdir(dirname(this.link), { recursive: true })
      if (found.kind === 'ours') await unlink(this.link)
      await symlink(resolve(bin), this.link)
    } catch (error) {
      throw new Error(t('Could not create {path}: {reason}', { path: this.link, reason: (error as Error).message }))
    }
    return this.status()
  }

  async uninstall(): Promise<CliStatus> {
    const { t } = this.deps
    const found = await this.inspect()
    if (found.kind === 'other') throw new Error(t('{path} is not a link made by Ladder, so it was left alone.', { path: this.link }))
    if (found.kind === 'ours') {
      try {
        await unlink(this.link)
      } catch (error) {
        throw new Error(t('Could not remove {path}: {reason}', { path: this.link, reason: (error as Error).message }))
      }
    }
    return this.status()
  }
}
