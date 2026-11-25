// New chat with a new worktree: which branch it starts from and the name of the new branch (empty = generated name).
import { useState, type ReactNode } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import type { LocalBranch } from '@shared/protocol'
import { validBranchName } from '@shared/branch-name'
import { t } from '@shared/i18n'
import { BranchList } from '@/components/branch-switcher'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Message for a hand-written branch name, or null if it is fine (empty is fine: the host generates it). */
export function branchNameProblem(name: string, existing: LocalBranch[]): string | null {
  const value = name.trim()
  if (!value) return null
  if (!validBranchName(value)) return t('Use letters, digits and . _ / @ + -, with no spaces.')
  if (existing.some((b) => b.name === value)) return t('A branch named “{name}” already exists.', { name: value })
  return null
}

/**
 * Button of the context row (shown only with a new worktree, not from an issue or a PR): opens the choice of the starting branch
 * and the name field. The default is the current branch of the main checkout.
 */
export function WorktreeStart({
  branches,
  base,
  onBase,
  name,
  onName,
  prefix,
  className,
  children
}: {
  branches: LocalBranch[]
  /** Starting branch in use. */
  base: string | null
  onBase: (branch: LocalBranch) => void
  name: string
  onName: (name: string) => void
  prefix: string
  className: string
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const problem = branchNameProblem(name, branches)
  const label = name.trim() ? t('{name} from {base}', { name: name.trim(), base: base ?? 'HEAD' }) : t('From {base}', { base: base ?? 'HEAD' })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(className, 'max-w-[300px]', problem && 'text-destructive')} aria-label={t('Start point and name of the new branch')}>
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-faint" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-0">
        <p className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{t('Start from')}</p>
        <BranchList
          branches={branches}
          selected={base}
          maxHeight="max-h-48"
          onPick={(b) => {
            onBase(b)
          }}
        />
        <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2.5">
          <label htmlFor="new-branch-name" className="text-xs font-medium text-muted-foreground">
            {t('Branch name (optional)')}
          </label>
          <input
            id="new-branch-name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !problem) setOpen(false)
            }}
            placeholder={`${prefix}…`}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby="new-branch-name-hint"
            className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 font-mono text-[0.8125rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive"
          />
          <p id="new-branch-name-hint" className={cn('text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>
            {problem ?? t('Used as typed. Leave it empty for a generated name.')}
          </p>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  )
}
