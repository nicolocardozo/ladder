// ⌘⇧N: nuova sessione da una issue o una PR di GitHub, da una issue di Linear o da un branch.
// La scelta prepara la nuova chat: prompt già scritto (modificabile), worktree e branch giusti.
import { useEffect, useMemo, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { CircleDot, GitBranch, GitPullRequest, Search, SquareKanban, type LucideIcon } from 'lucide-react'
import type { IssueItem, IssueList } from '@shared/protocol'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { request } from '@/lib/host-client'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

type Source = IssueItem['source']

const SOURCES: { id: Source; label: string; icon: LucideIcon }[] = [
  { id: 'github-issue', label: 'Issue GitHub', icon: CircleDot },
  { id: 'github-pr', label: 'PR GitHub', icon: GitPullRequest },
  { id: 'linear', label: 'Linear', icon: SquareKanban },
  { id: 'branch', label: 'Branch', icon: GitBranch }
]

export const SOURCE_ICON: Record<Source, LucideIcon> = Object.fromEntries(SOURCES.map((s) => [s.id, s.icon])) as Record<Source, LucideIcon>
export const SOURCE_LABEL: Record<Source, string> = { 'github-issue': 'issue', 'github-pr': 'PR', linear: 'Linear', branch: 'branch' }

const LAST_KEY = 'ladder.new-from'

function lastSource(): Source {
  try {
    const value = localStorage.getItem(LAST_KEY) as Source | null
    return SOURCES.some((s) => s.id === value) ? value! : 'github-issue'
  } catch {
    return 'github-issue'
  }
}

export function NewFromDialog() {
  const open = useApp((s) => s.newFromOpen)
  const setOpen = useApp((s) => s.setNewFromOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-[620px]">
        <DialogTitle className="sr-only">Nuova sessione da…</DialogTitle>
        <DialogDescription className="sr-only">Issue e PR di GitHub, issue di Linear o un branch del progetto.</DialogDescription>
        <NewFromBody onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function NewFromBody({ onClose }: { onClose: () => void }) {
  const projectId = useApp((s) => s.selection.projectId)
  const project = useApp((s) => s.projects.find((p) => p.id === s.selection.projectId) ?? null)
  const [source, setSource] = useState<Source>(lastSource)
  const [query, setQuery] = useState('')
  const [lists, setLists] = useState<Partial<Record<Source, IssueList | 'loading'>>>({})
  const current = lists[source]

  useEffect(() => {
    try {
      localStorage.setItem(LAST_KEY, source)
    } catch {
      // Solo una comodità.
    }
  }, [source])

  // Ogni fonte si legge una volta all'apertura; Linear di nuovo quando scrivi un identificativo (ABC-123).
  const linearId = source === 'linear' && /^[a-z][a-z0-9]*-\d+$/i.test(query.trim()) ? query.trim() : ''
  useEffect(() => {
    if (!projectId) return
    if (lists[source] && !(source === 'linear' && linearId)) return
    let cancelled = false
    setLists((l) => ({ ...l, [source]: l[source] && l[source] !== 'loading' ? l[source] : 'loading' }))
    const load =
      source === 'linear'
        ? (window.ladder?.linear.issues(linearId) ?? Promise.resolve<IssueList>({ items: [], problem: 'Linear è disponibile solo nell’app.' }))
        : request<IssueList>({ type: 'issues.list', projectId, source })
    const timer = window.setTimeout(() => {
      load
        .then((list) => !cancelled && setLists((l) => ({ ...l, [source]: list })))
        .catch((e: Error) => !cancelled && setLists((l) => ({ ...l, [source]: { items: [], problem: e.message } })))
    }, linearId ? 250 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, source, linearId])

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const items = useMemo(() => {
    if (!current || current === 'loading') return []
    return current.items.filter((item) => tokens.every((t) => `${item.ref} ${item.title} ${item.branch ?? ''}`.toLowerCase().includes(t))).slice(0, 60)
  }, [current, tokens.join(' ')])

  const choose = (item: IssueItem) => {
    if (!projectId) return
    const state = useApp.getState()
    state.setNewSource({ projectId, item })
    state.select({ kind: 'new', projectId })
    onClose()
  }

  const cycle = (delta: number) => {
    const index = SOURCES.findIndex((s) => s.id === source)
    setSource(SOURCES[(index + delta + SOURCES.length) % SOURCES.length].id)
  }

  return (
    <Command
      shouldFilter={false}
      loop
      label="Nuova sessione da…"
      onKeyDown={(e) => {
        // ⌘← e ⌘→, oppure Tab, cambiano fonte.
        if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.metaKey) {
          e.preventDefault()
          cycle(e.key === 'ArrowRight' ? 1 : -1)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          cycle(e.shiftKey ? -1 : 1)
        }
      }}
      className="rounded-none! bg-popover p-0"
    >
      <div className="flex items-center gap-1 border-b border-border px-3 pt-3 pb-2" role="tablist" aria-label="Fonte">
        <span className="mr-2 text-[12.5px] font-semibold">Nuova sessione da…</span>
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={source === s.id}
            onClick={() => setSource(s.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              source === s.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <s.icon className="size-3.5" />
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex h-11 items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder={source === 'linear' ? 'Titolo, oppure un identificativo come LIN-42' : source === 'branch' ? 'Nome del branch' : 'Numero o titolo'}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        />
        {project && <span className="shrink-0 text-[11.5px] text-muted-foreground">{project.name}</span>}
      </div>
      <CommandList className="max-h-[min(440px,56vh)] px-1.5 py-1.5">
        <CommandEmpty className="px-4 py-8 text-center text-[13px] text-muted-foreground">
          {!current || current === 'loading' ? 'Leggo…' : current.problem ?? (query ? `Niente corrisponde a “${query}”.` : 'Niente di aperto.')}
        </CommandEmpty>
        {items.map((item) => (
          <CommandItem key={`${item.source}:${item.ref}`} value={`${item.source}:${item.ref}`} onSelect={() => choose(item)} className="gap-2.5 px-2.5 py-[7px] text-[13px] data-selected:bg-accent">
            <span className="w-[74px] shrink-0 truncate font-mono text-[12px] text-muted-foreground">{item.source === 'branch' ? '' : item.ref}</span>
            <span className="min-w-0 flex-1 truncate">{item.source === 'branch' ? <span className="font-mono text-[12.5px]">{item.ref}</span> : item.title}</span>
            {item.source === 'branch' && <span className="max-w-[40%] min-w-0 truncate text-[12px] text-muted-foreground">{item.title}</span>}
            {item.state && <span className="shrink-0 text-[11.5px] text-muted-foreground">{item.state}</span>}
            {item.updatedAt && <span className="w-10 shrink-0 text-right text-[11.5px] text-faint">{relativeAge(item.updatedAt)}</span>}
          </CommandItem>
        ))}
      </CommandList>
      <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-[11.5px] text-faint">
        <span>
          <kbd className="font-mono">↵</kbd> prepara la sessione
        </span>
        <span>
          <kbd className="font-mono">⇥</kbd> cambia fonte
        </span>
        <span className="ml-auto">{source === 'branch' ? 'Lavora in un worktree sul branch' : source === 'github-pr' ? 'Worktree sul branch della PR' : 'Prompt modificabile prima di inviare'}</span>
      </div>
    </Command>
  )
}
