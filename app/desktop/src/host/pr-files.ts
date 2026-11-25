// Temporary files with the PR title and description: the agent receives only the paths and reads the data from there,
// so no character of the title or body goes through a command line or a heredoc delimiter.
// Private folder (0700) with a random name, files 0600; deleted when the session closes, on a new
// preparation and when the app exits. Folders left by an abrupt exit are removed on the first preparation.
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import { MAX_PR_BODY, MAX_PR_TITLE } from '@shared/protocol'

const PREFIX = 'ladder-pr-'
/** Folders from a previous run: after a day they are of no use to anyone. */
const STALE_MS = 24 * 60 * 60_000

/** Title (one line, no NUL, within the limit) and description (no NUL, within the limit); translated error otherwise. */
export function checkPrText(title: string, body: string): void {
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error(t('The pull request text is not valid.'))
  if (!title.trim()) throw new Error(t('The pull request needs a title.'))
  if (/[\r\n]/.test(title)) throw new Error(t('The pull request title must be a single line.'))
  if (title.includes('\0') || body.includes('\0')) throw new Error(t('The pull request text contains invalid characters.'))
  if (title.length > MAX_PR_TITLE) throw new Error(t('The pull request title is too long ({max} characters at most).', { max: String(MAX_PR_TITLE) }))
  if (body.length > MAX_PR_BODY) throw new Error(t('The pull request description is too long ({max} characters at most).', { max: String(MAX_PR_BODY) }))
}

export class PrFiles {
  private dirs = new Map<string, string>()
  private swept = false

  /** Writes the title and description for the session (and removes the previous preparation's files). */
  async prepare(sessionId: string, title: string, body: string): Promise<{ titlePath: string; bodyPath: string }> {
    checkPrText(title, body)
    this.sweep()
    await this.forget(sessionId)
    // mkdtemp creates the folder with 0700 permissions and a random suffix; the files also have random names.
    const dir = await mkdtemp(join(tmpdir(), PREFIX))
    try {
      const titlePath = join(dir, `title-${randomBytes(6).toString('hex')}.txt`)
      const bodyPath = join(dir, `body-${randomBytes(6).toString('hex')}.md`)
      // Content identical to what the user wrote: no newline added. 'wx': never over an existing file.
      await writeFile(titlePath, title.trim(), { mode: 0o600, flag: 'wx' })
      await writeFile(bodyPath, body, { mode: 0o600, flag: 'wx' })
      this.dirs.set(sessionId, dir)
      return { titlePath, bodyPath }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  /** Deletes the session's files (closed, archived or with a new preparation). */
  async forget(sessionId: string): Promise<void> {
    const dir = this.dirs.get(sessionId)
    if (!dir) return
    this.dirs.delete(sessionId)
    await rm(dir, { recursive: true, force: true })
  }

  /** On app exit: everything goes, synchronously. */
  shutdown(): void {
    for (const dir of this.dirs.values()) rmSync(dir, { recursive: true, force: true })
    this.dirs.clear()
  }

  /** Once per run: removes old `ladder-pr-*` folders left by an exit without cleanup. */
  private sweep(): void {
    if (this.swept) return
    this.swept = true
    try {
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(PREFIX)) continue
        const path = join(tmpdir(), name)
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true })
      }
    } catch {
      // A listing that cannot be read must not block the PR.
    }
  }
}
