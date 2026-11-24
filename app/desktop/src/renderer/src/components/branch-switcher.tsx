// Branch locali del progetto: elenco con ricerca (`BranchList`, anche per scegliere da dove parte un worktree) e menu del branch del
// checkout principale (`BranchSwitcherPanel`): cambio con `git switch`, scelta inline per le modifiche non committate, nuovo branch da qui.
// Le protezioni vere stanno nell'host; qui si mostra in anticipo ciò che l'host rifiuterebbe (sessione al lavoro, branch in un worktree).
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, GitFork, GitMerge, Plus, Search, TriangleAlert } from 'lucide-react'
import type { LocalBranch } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { request } from '@/lib/host-client'
import { relativeAge } from '@/lib/session-state'
import { useProjectBranches } from '@/lib/use-project-branches'
import { cn } from '@/lib/utils'

/** Ricerca per sottostringa, senza distinguere maiuscole; l'ordine dell'host (ultimo commit) resta. */
function filterBranches(branches: LocalBranch[], query: string): LocalBranch[] {
  const needle = query.trim().toLowerCase()
  return needle ? branches.filter((b) => b.name.toLowerCase().includes(needle)) : branches
}

/**
 * Campo di ricerca e elenco dei branch locali: spunta sul selezionato, età dell'ultimo commit, voci disabilitate con il motivo.
 * Frecce su e giù passano tra campo e voci, Invio sceglie la prima voce libera della ricerca.
 */
export function BranchList({
  branches,
  selected,
  onPick,
  disabledReason,
  pending = null,
  maxHeight = 'max-h-64'
}: {
  branches: LocalBranch[]
  selected: string | null
  onPick: (branch: LocalBranch) => void
  /** Motivo per cui una voce non si può scegliere (mostrato sotto il nome); null = libera. */
  disabledReason?: (branch: LocalBranch) => string | null
  /** Branch che si sta per cambiare: la sua riga mostra l'attesa. */
  pending?: string | null
  maxHeight?: string
}) {
  const [query, setQuery] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const shown = useMemo(() => filterBranches(branches, query), [branches, query])
  const reasonOf = (b: LocalBranch) => (b.name === selected ? null : (disabledReason?.(b) ?? null))
  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  const move = (event: KeyboardEvent, from: number) => {
    const buttons = items()
    const next = event.key === 'ArrowDown' ? from + 1 : from - 1
    if (next < 0) return search.current?.focus()
    buttons[Math.min(next, buttons.length - 1)]?.focus()
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={search}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              items()[0]?.focus()
            } else if (e.key === 'Enter') {
              // Con un cambio in corso Invio non fa nulla (come i clic sulle voci, disabilitate).
              const first = pending === null ? shown.find((b) => !reasonOf(b) && b.name !== selected) : undefined
              if (first) onPick(first)
            }
          }}
          placeholder={t('Find a branch…')}
          aria-label={t('Find a branch…')}
          className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul ref={list} className={cn('m-0 flex list-none flex-col overflow-y-auto p-1', maxHeight)}>
        {shown.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">{query.trim() ? t('No branch matches “{query}”.', { query: query.trim() }) : t('No branches yet.')}</li>}
        {shown.map((b, index) => {
          const reason = reasonOf(b)
          const isSelected = b.name === selected
          return (
            <li key={b.name}>
              <button
                type="button"
                disabled={Boolean(reason) || pending !== null}
                aria-current={isSelected ? 'true' : undefined}
                title={reason ?? b.subject ?? undefined}
                onClick={() => onPick(b)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(e, items().indexOf(e.currentTarget))
                  }
                }}
                className={cn(
                  'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent',
                  isSelected && 'bg-accent/50'
                )}
                data-index={index}
              >
                <Check aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', !isSelected && 'opacity-0')} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[0.8125rem]">{b.name}</span>
                  {reason && <span className="truncate text-xs text-muted-foreground">{reason}</span>}
                </span>
                {pending === b.name ? (
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{t('Switching…')}</span>
                ) : b.at > 0 ? (
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{relativeAge(b.at)}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Il motivo, uguale per tutti, per cui un branch estratto in un worktree non si sceglie come branch del checkout principale. */
export function inWorktreeReason(b: LocalBranch): string | null {
  return b.worktree ? t('Checked out in a worktree: {path}', { path: b.worktree }) : null
}

/**
 * Contenuto del menu del branch: cambio di branch del checkout principale, nuovo branch da qui, e l'accesso al pannello Merge.
 * `onDone` chiude il menu dopo un cambio riuscito; un errore resta nel menu, leggibile.
 */
export function BranchSwitcherPanel({ projectId, onDone, onOpenMerge }: { projectId: string; onDone: () => void; onOpenMerge?: () => void }) {
  const { data, error, loading, reload } = useProjectBranches(projectId, true)
  // Branch scelto mentre ci sono modifiche non committate: il menu chiede cosa farne prima di partire.
  const [confirm, setConfirm] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const run = async (label: string, command: Parameters<typeof request>[0]) => {
    setPending(label)
    setFailure(null)
    try {
      await request(command)
      onDone()
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
      setConfirm(null)
      reload()
    } finally {
      setPending(null)
    }
  }
  const switchTo = (branch: string, dirty: 'carry' | 'stash') => void run(branch, { type: 'project.branch.switch', projectId, branch, dirty })
  const pick = (b: LocalBranch) => {
    if (b.current || data?.busy) return
    if ((data?.dirty ?? 0) > 0) setConfirm(b.name)
    else switchTo(b.name, 'carry')
  }
  const create = () => {
    const next = name.trim()
    if (next) void run(next, { type: 'project.branch.create', projectId, name: next })
  }

  const busy = data?.busy ?? null
  const dirty = data?.dirty ?? 0
  return (
    <div className="flex min-w-0 flex-col">
      {error && !data && (
        <div role="alert" className="flex flex-wrap items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <span className="min-w-0 break-words">{error}</span>
          <Button size="xs" variant="ghost" onClick={reload}>
            {t('Try again')}
          </Button>
        </div>
      )}
      {!data && !error && loading && <p className="px-3 py-3 text-xs text-muted-foreground">{t('Reading branches…')}</p>}
      {data && (
        <>
          {busy && (
            <p role="status" className="flex items-start gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-attention" />
              {t('“{title}” has an agent at work in this folder. Wait for it to finish, or stop it, to change branch.', { title: busy.title })}
            </p>
          )}
          {failure && (
            <p role="alert" className="break-words border-b border-border px-3 py-2 text-xs text-destructive">
              {failure}
            </p>
          )}
          {confirm ? (
            <div className="flex flex-col gap-2 px-3 py-3 text-sm">
              <p>{t('Switch to {branch}?', { branch: confirm })}</p>
              <p className="text-xs text-muted-foreground">{plural(dirty, 'You have {n} uncommitted file. Bring it along if git allows, or set it aside first.', 'You have {n} uncommitted files. Bring them along if git allows, or set them aside first.')}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" disabled={pending !== null} onClick={() => switchTo(confirm, 'carry')}>
                  {pending ? t('Switching…') : t('Bring the changes')}
                </Button>
                <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => switchTo(confirm, 'stash')}>
                  {t('Set aside (stash)')}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => setConfirm(null)}>
                  {t('Cancel')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('Stash saves them as “ladder: before switching to {branch}”. Find them with git stash list.', { branch: confirm })}</p>
            </div>
          ) : (
            <BranchList
              branches={data.branches}
              selected={data.current}
              pending={pending}
              onPick={pick}
              disabledReason={(b) => (busy ? t('Not while an agent is working here') : inWorktreeReason(b))}
            />
          )}
          {!confirm && (
            <div className="flex flex-col border-t border-border p-1">
              {creating ? (
                <form
                  className="flex flex-col gap-1.5 p-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    create()
                  }}
                >
                  <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('New branch name')} aria-label={t('New branch name')} className="h-8 font-mono text-[0.8125rem]" disabled={pending !== null} />
                  <p className="text-xs text-muted-foreground">{dirty > 0 ? t('Starts from the current commit. Your uncommitted changes come along.') : t('Starts from the current commit.')}</p>
                  <div className="flex gap-1.5">
                    <Button type="submit" size="sm" disabled={!name.trim() || Boolean(busy) || pending !== null}>
                      {t('Create and switch')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={pending !== null} onClick={() => setCreating(false)}>
                      {t('Cancel')}
                    </Button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => setCreating(true)}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-55 disabled:hover:bg-transparent"
                >
                  <Plus aria-hidden className="size-3.5" />
                  {t('Create branch from here…')}
                </button>
              )}
              {onOpenMerge && (
                <button
                  type="button"
                  onClick={() => {
                    onDone()
                    onOpenMerge()
                  }}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <GitMerge aria-hidden className="size-3.5" />
                  {t('Open the Merge panel')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {data && data.branches.some((b) => b.worktree) && !confirm && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <GitFork aria-hidden className="size-3 shrink-0" />
          {t('Branches in a worktree can’t be checked out here.')}
        </p>
      )}
    </div>
  )
}
