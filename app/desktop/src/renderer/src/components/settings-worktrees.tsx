// Settings → Workspace → Worktrees on disk: what Ladder's worktrees hold, how much space they take, and removing the ones
// nothing needs any more. The host checks every removal again; the branches always stay.
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { localeTag, plural, t } from '@shared/i18n'
import type { WorktreeEntry, WorktreeRemoveResult } from '@shared/protocol'
import { Outcome, SettingsBlock, settingsButton } from '@/components/settings-parts'
import { request } from '@/lib/host-client'
import { formatBytes } from '@/lib/system-bridge'
import { cn } from '@/lib/utils'

const inUse = (w: WorktreeEntry) => w.openSessions.length > 0 || w.busy
/** Nothing is lost by removing it: nobody uses it, no uncommitted files, and its commits are on the base or a remote. */
const removable = (w: WorktreeEntry) => !inUse(w) && w.dirty === 0 && w.orphanCommits === 0
const isSafe = (w: WorktreeEntry) => removable(w) && (w.unpushed === 0 || w.merged)
const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
/** `confirming` value for the "remove the unused ones" button. */
const ALL = '\0all'

/** What the worktree holds, in a few words: the reason it can or cannot go. */
function describe(w: WorktreeEntry): { text: string; tone: 'muted' | 'warn' } {
  if (w.openSessions.length > 0) return { text: t('Used by “{title}”', { title: w.openSessions[0].title }), tone: 'muted' }
  if (w.busy) return { text: t('An agent or a plan is working in it'), tone: 'muted' }
  if (w.dirty === null) return { text: t('Git could not read its state'), tone: 'warn' }
  if (w.dirty > 0) return { text: plural(w.dirty, '1 uncommitted file', '{n} uncommitted files'), tone: 'warn' }
  if (w.orphanCommits === null || w.orphanCommits > 0) return { text: w.orphanCommits ? plural(w.orphanCommits, '1 commit on no branch', '{n} commits on no branch') : t('Git could not read its state'), tone: 'warn' }
  if (w.merged) return { text: t('Merged into the base branch'), tone: 'muted' }
  if (w.unpushed) return { text: plural(w.unpushed, '1 commit only on its branch', '{n} commits only on its branch'), tone: 'warn' }
  return { text: t('Nothing that is not on the remote'), tone: 'muted' }
}

export function WorktreesOnDisk() {
  const [list, setList] = useState<WorktreeEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string[]>([])
  // Removing one with commits only on its branch, or several at once, asks once more: the button turns into a confirmation.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ tone: 'muted' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList(await request<WorktreeEntry[]>({ type: 'worktrees.list' }))
    } catch (error) {
      setOutcome({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => void load(), [load])

  const remove = async (paths: string[]) => {
    setBusy(paths)
    setConfirming(null)
    setOutcome(null)
    try {
      const result = await request<WorktreeRemoveResult>({ type: 'worktrees.remove', paths })
      const freed = (list ?? []).filter((w) => result.removed.includes(w.path)).reduce((n, w) => n + (w.bytes ?? 0), 0)
      const parts = [
        result.removed.length ? plural(result.removed.length, 'Removed 1 worktree ({size} freed).', 'Removed {n} worktrees ({size} freed).', { size: formatBytes(freed, localeTag()) }) : null,
        ...result.failed.map((f) => t('{name}: {error}', { name: folderName(f.path), error: f.error }))
      ].filter(Boolean)
      setOutcome({ tone: result.failed.length ? 'error' : 'muted', text: parts.join(' ') })
    } catch (error) {
      setOutcome({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy([])
      void load()
    }
  }

  const total = (list ?? []).reduce((n, w) => n + (w.bytes ?? 0), 0)
  const safe = (list ?? []).filter(isSafe)
  const safeBytes = safe.reduce((n, w) => n + (w.bytes ?? 0), 0)

  return (
    <SettingsBlock
      id="worktrees-disk-title"
      title={t('Worktrees on disk')}
      description={t('Ladder removes a worktree by itself once its branch is merged. Archiving a session without merging leaves it here: remove the ones you no longer need. The branch always stays; files git ignores, like .env.local or a local database, go with the folder.')}
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {list === null ? t('Reading the worktrees…') : list.length === 0 ? t('No worktrees on disk.') : plural(list.length, '1 worktree, {size}', '{n} worktrees, {size}', { size: formatBytes(total, localeTag()) })}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => void load()} disabled={loading || busy.length > 0} className={settingsButton} aria-label={t('Refresh the list')}>
          <RefreshCw aria-hidden className={cn('inline size-3.5 align-[-2px]', loading && 'animate-spin motion-reduce:animate-none')} />
        </button>
        <button
          type="button"
          onClick={() => (confirming === ALL ? void remove(safe.map((w) => w.path)) : setConfirming(ALL))}
          onBlur={() => confirming === ALL && setConfirming(null)}
          disabled={safe.length === 0 || busy.length > 0}
          className={cn(settingsButton, confirming === ALL && 'border-destructive text-destructive')}
        >
          {confirming === ALL
            ? plural(safe.length, 'Remove 1 worktree?', 'Remove {n} worktrees?')
            : safe.length
              ? t('Remove the unused ones ({n}, {size})', { n: safe.length, size: formatBytes(safeBytes, localeTag()) })
              : t('Remove the unused ones')}
        </button>
      </div>
      <span aria-live="polite" className="sr-only">
        {confirming ? t('Press again to confirm the removal.') : ''}
      </span>
      {outcome && (
        <div className="mt-2">
          <Outcome tone={outcome.tone}>{outcome.text}</Outcome>
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
          {list.map((w) => {
            const state = describe(w)
            const working = busy.includes(w.path)
            const asks = confirming === w.path
            return (
              <li key={w.path} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground" title={w.path}>
                    <span className="font-medium">{w.projectName}</span>
                    <span className="text-faint"> · </span>
                    <span className="font-mono text-xs">{w.branch ?? folderName(w.path)}</span>
                  </p>
                  <p className={cn('truncate text-xs', state.tone === 'warn' ? 'text-attention' : 'text-muted-foreground')}>
                    {state.text}
                    {w.archivedSessions > 0 && !inUse(w) ? ` · ${plural(w.archivedSessions, '1 archived session', '{n} archived sessions')}` : ''}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{w.bytes === null ? '…' : formatBytes(w.bytes, localeTag())}</span>
                <button
                  type="button"
                  disabled={!removable(w) || busy.length > 0}
                  onClick={() => (asks || isSafe(w) ? void remove([w.path]) : setConfirming(w.path))}
                  onBlur={() => asks && setConfirming(null)}
                  title={removable(w) ? undefined : state.text}
                  aria-label={asks ? t('Confirm removing {name}; the branch stays', { name: `${w.projectName} ${w.branch ?? folderName(w.path)}` }) : t('Remove {name}', { name: `${w.projectName} ${w.branch ?? folderName(w.path)}` })}
                  className={cn(settingsButton, asks && 'border-destructive text-destructive')}
                >
                  {working ? t('Removing…') : asks ? t('Remove, branch stays') : t('Remove')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </SettingsBlock>
  )
}
