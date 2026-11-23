import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CloudOff, GitBranch, GitFork } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { changesLabel, describeGit, type GitStatusView } from '@/lib/git-status'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { t } from '@shared/i18n'
import type { GitStatus } from '@shared/protocol'

const base =
  'no-drag inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'

/**
 * Iscrive la sessione agli aggiornamenti git finché l'intestazione la mostra; toglie l'iscrizione quando la lascia.
 * Restituisce lo stato della sua cartella (null prima della risposta, senza host o fuori da un repository).
 */
export function useGitStatus(sessionId: string | null): GitStatus | null {
  const watchGit = useApp((s) => s.watchGit)
  const unwatchGit = useApp((s) => s.unwatchGit)
  useEffect(() => {
    if (!sessionId) return
    watchGit(sessionId)
    return () => unwatchGit(sessionId)
  }, [sessionId, watchGit, unwatchGit])
  return useApp((s) => (sessionId ? (s.gitStatus[s.gitRoot[sessionId] ?? ''] ?? null) : null))
}

/**
 * Chip del branch: icona git, nome (troncato, intero nel tooltip), segno di worktree, ↑ da inviare, ↓ da scaricare,
 * nuvola barrata se non è pubblicato, pallino se ci sono modifiche non committate. Senza `status` mostra solo il nome.
 */
export function GitStatusChip({ status, fallbackBranch, title, active, onClick }: { status: GitStatus | null; fallbackBranch: string | null; title?: string; active: boolean; onClick: () => void }) {
  const view = status ? describeGit(status) : null
  const name = view?.label ?? fallbackBranch
  if (!name) return null
  const aria = view ? view.aria : t('Branch {branch}', { branch: name })
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={aria}
        aria-pressed={active}
        onClick={onClick}
        className={cn(base, 'max-w-[240px] shrink text-muted-foreground', active && 'bg-accent text-foreground')}
      >
        <GitBranch aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className={cn('truncate', view?.detached && 'italic')}>{name}</span>
        {view && <GitMarks view={view} />}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {view ? (
          <div className="flex flex-col gap-0.5">
            {view.lines.map((line) => (
              <span key={line} className="break-words">{line}</span>
            ))}
          </div>
        ) : (
          <span className="break-all">{title ?? name}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Segni dentro il chip: solo forme e numeri, il colore non porta informazione da solo. */
function GitMarks({ view }: { view: GitStatusView }) {
  const marks = view.worktree || view.ahead > 0 || view.behind > 0 || view.unpublished || view.dirty > 0
  if (!marks) return null
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1.5 tabular-nums animate-in fade-in-0 duration-150 motion-reduce:animate-none">
      {view.worktree && <GitFork className="size-3 text-faint" strokeWidth={1.75} />}
      {view.ahead > 0 && (
        <span className="inline-flex items-center">
          <ArrowUp className="size-3" strokeWidth={2} />
          {view.ahead}
        </span>
      )}
      {view.behind > 0 && (
        <span className="inline-flex items-center">
          <ArrowDown className="size-3" strokeWidth={2} />
          {view.behind}
        </span>
      )}
      {view.unpublished && <CloudOff className="size-3" strokeWidth={1.75} />}
      {view.dirty > 0 && <span className="size-1.5 rounded-full bg-attention" />}
    </span>
  )
}

/** Pillola `+120 −34` delle modifiche non committate; `flash` la accende per un momento (solo opacity e transform). */
export function GitChangesPill({ status, active, flash, onClick }: { status: GitStatus; active: boolean; flash: boolean; onClick: () => void }) {
  const view = describeGit(status)
  if (view.dirty === 0) return null
  const label = changesLabel(view)
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(base, 'shrink-0 gap-1 tabular-nums text-muted-foreground', active && 'bg-accent text-foreground', flash && 'git-pill-flash')}
      >
        <span aria-hidden className="text-diff-added">+{view.added}</span>
        <span aria-hidden className="text-diff-removed">−{view.removed}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** True per un momento quando i file modificati passano da 0 a più di 0 (dopo il primo stato letto). */
export function useFirstChangeFlash(status: GitStatus | null): boolean {
  const prev = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)
  const dirty = status?.dirty ?? null
  useEffect(() => {
    if (dirty === null) return
    if (prev.current === 0 && dirty > 0) {
      setFlash(true)
      const id = window.setTimeout(() => setFlash(false), 900)
      prev.current = dirty
      return () => window.clearTimeout(id)
    }
    prev.current = dirty
  }, [dirty])
  return flash
}
