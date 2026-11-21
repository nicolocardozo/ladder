// Mappa degli agenti: il badge nella barra del composer e il popover con i sotto-agenti della sessione.
// Con centinaia di agenti resta leggibile: in corso, poi errori, poi i completati in un gruppo chiuso;
// figli sotto il genitore, ricerca e filtri oltre 15 agenti, lista virtualizzata.
import { useVirtualizer } from '@tanstack/react-virtual'
import { Bot, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { plural, t } from '@shared/i18n'
import type { AgentId, SessionSummary, SubagentInfo } from '@shared/protocol'
import { useNow } from '@/components/chat/chat-context'
import { formatDuration } from '@/components/chat/format'
import { effortLabel, formatTokens, StatusMark, useAgentModel } from '@/components/subagent-bits'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RunningRing } from '@/components/status'
import { Spinner } from '@/components/chat/bits'
import { agentElapsed, bucketOf, buildForest, orderedAgents, useSubagentDialog, useSubagentList, type AgentNode, type Bucket } from '@/lib/subagents'
import { cn } from '@/lib/utils'

/** Agenti in corso, anche in background: il conteggio della sidebar. */
export function runningSubagents(session: SessionSummary | null | undefined): number {
  return session?.subagentCounts?.running ?? 0
}

/** Agenti in corso che tengono occupata la sessione (non in background): "N agents working" sopra la coda. */
export function runningForegroundSubagents(session: SessionSummary | null | undefined): number {
  return session?.subagentCounts?.runningForeground ?? 0
}

/** Oltre questo numero compaiono ricerca e filtri. */
const FILTER_FROM = 16
const ALL = '__all__'

/** Badge nella barra in basso del composer: c'è solo se la sessione ha avviato sotto-agenti. */
export function AgentBadge({
  sessionId,
  counts,
  agent,
  model,
  compact = false
}: {
  sessionId: string
  counts: NonNullable<SessionSummary['subagentCounts']>
  agent: AgentId
  model: string | null
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  if (!counts.total) return null
  const { running, total } = counts
  const failed = counts.error
  const count = running || total
  const label = running ? t('{n} running', { n: running }) : plural(total, '1 agent', '{n} agents')
  const description = failed ? t('{label}, {failed} with errors', { label, failed }) : label
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={trigger}
        aria-label={t('Agents: {description}', { description })}
        className={cn(
          'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground tabular-nums outline-none transition-colors',
          'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground'
        )}
      >
        {running ? <RunningRing /> : <Bot aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.8} />}
        <span>{compact ? count : label}</span>
        {failed > 0 && <span aria-hidden className="size-1.5 rounded-full bg-destructive" />}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-[min(34rem,calc(100vw-2rem))] gap-0 p-0">
        <AgentMap sessionId={sessionId} agent={agent} model={model} onPick={() => setOpen(false)} returnFocus={() => trigger.current} />
      </PopoverContent>
    </Popover>
  )
}

type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'group'; key: string; count: number; open: boolean }
  | { kind: 'agent'; key: string; agent: SubagentInfo; depth: number; childCount: number; collapsed: boolean }

const ROW_HEIGHT = { header: 28, group: 32, agent: 44 } as const

function countSubtree(node: AgentNode, depth = 0): number {
  return 1 + (depth < 64 ? node.children.reduce((n, c) => n + countSubtree(c, depth + 1), 0) : 0)
}

interface RowOptions {
  collapsed: Set<string>
  doneOpen: boolean
  filtered: SubagentInfo[] | null
}

function buildRows(forest: AgentNode[], agents: SubagentInfo[], { collapsed, doneOpen, filtered }: RowOptions): Row[] {
  const rows: Row[] = []
  const labels: Record<Bucket, (n: number) => string> = {
    running: (n) => t('{n} running', { n }),
    failed: (n) => t('{n} failed or stopped', { n }),
    done: (n) => t('{n} completed', { n })
  }

  if (filtered) {
    // Con un filtro la lista è piatta: l'albero nasconderebbe chi corrisponde sotto un genitore che non corrisponde.
    for (const bucket of ['running', 'failed', 'done'] as const) {
      const list = filtered.filter((a) => bucketOf(a) === bucket)
      if (!list.length) continue
      rows.push({ kind: 'header', key: `h:${bucket}`, label: labels[bucket](list.length) })
      for (const a of list) rows.push({ kind: 'agent', key: `a:${a.id}`, agent: a, depth: 0, childCount: 0, collapsed: false })
    }
    return rows
  }

  const walk = (list: AgentNode[], depth: number) => {
    for (const node of list) {
      const isCollapsed = collapsed.has(node.agent.id)
      rows.push({ kind: 'agent', key: `a:${node.agent.id}`, agent: node.agent, depth, childCount: node.children.length, collapsed: isCollapsed })
      if (!isCollapsed && depth < 64) walk(node.children, depth + 1)
    }
  }
  for (const bucket of ['running', 'failed', 'done'] as const) {
    const roots = forest.filter((n) => n.bucket === bucket)
    if (!roots.length) continue
    if (bucket === 'done') {
      const count = roots.reduce((n, r) => n + countSubtree(r), 0)
      rows.push({ kind: 'group', key: 'g:done', count, open: doneOpen })
      if (doneOpen) walk(roots, 0)
    } else {
      const own = agents.filter((a) => (bucket === 'running' ? a.status === 'running' : a.status === 'error' || a.status === 'stopped')).length
      rows.push({ kind: 'header', key: `h:${bucket}`, label: labels[bucket](own) })
      walk(roots, 0)
    }
  }
  return rows
}

function AgentMap({
  sessionId,
  agent,
  model,
  onPick,
  returnFocus
}: {
  sessionId: string
  agent: AgentId
  model: string | null
  onPick: () => void
  returnFocus: () => HTMLElement | null
}) {
  const openDialog = useSubagentDialog((s) => s.open)
  // Si rilegge a ogni apertura del popover: l'elenco in memoria può essere in ritardo su un evento perso.
  const list = useSubagentList(sessionId, true, 1)
  const agents = useMemo(() => list ?? [], [list])
  const modelOf = useAgentModel(agent, model)
  const running = useMemo(() => agents.filter((a) => a.status === 'running').length, [agents])
  const failed = useMemo(() => agents.filter((a) => a.status === 'error' || a.status === 'stopped').length, [agents])
  const now = useNow(1000, running > 0)
  const forest = useMemo(() => buildForest(agents), [agents])

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [doneOpen, setDoneOpen] = useState(false)

  const canFilter = agents.length >= FILTER_FROM
  const kinds = useMemo(() => [...new Set(agents.map((a) => a.kind).filter((k): k is string => Boolean(k)))].sort(), [agents])
  const needle = query.trim().toLowerCase()
  const filtering = canFilter && (needle !== '' || kind !== ALL || status !== ALL)
  const filtered = useMemo(() => {
    if (!filtering) return null
    return orderedAgents(forest).filter(
      (a) =>
        (kind === ALL || a.kind === kind) &&
        (status === ALL || bucketOf(a) === status) &&
        (needle === '' || a.title.toLowerCase().includes(needle) || (a.kind ?? '').toLowerCase().includes(needle))
    )
  }, [filtering, forest, kind, status, needle])

  const rows = useMemo(() => buildRows(forest, agents, { collapsed, doneOpen, filtered }), [forest, agents, collapsed, doneOpen, filtered])

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ROW_HEIGHT[rows[i].kind],
    getItemKey: (i) => rows[i].key,
    overscan: 8
  })

  const toggleChildren = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  // Frecce su e giù spostano il focus fra le righe; la lista è virtualizzata, quindi si scorre prima fino alla riga.
  // Dal campo di ricerca solo ↓ entra nella lista (↑, Home e End restano del testo); dalla prima riga ↑ torna alla ricerca.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const target = event.target as HTMLElement
    const inSearch = target === searchRef.current
    const current = target.closest<HTMLElement>('[data-row]')
    if (!inSearch && !current) return
    if (inSearch && event.key !== 'ArrowDown') return
    const navigable = rows.map((r, i) => (r.kind === 'header' ? -1 : i)).filter((i) => i >= 0)
    if (!navigable.length) return
    const at = current ? navigable.indexOf(Number(current.dataset.row)) : -1
    if (event.key === 'ArrowUp' && at <= 0 && searchRef.current) {
      event.preventDefault()
      searchRef.current.focus()
      return
    }
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = navigable.length - 1
    else next = Math.min(navigable.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    const index = navigable[next]
    virtualizer.scrollToIndex(index)
    // Dopo un salto lungo la riga si monta con qualche fotogramma di ritardo: si riprova finché c'è.
    let tries = 0
    const focusRow = () => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${index}"] [data-main]`)
      if (el) el.focus()
      else if (++tries < 12) window.requestAnimationFrame(focusRow)
    }
    window.requestAnimationFrame(focusRow)
  }

  const statusLabel = (value: string) => (value === ALL ? t('All statuses') : value === 'running' ? t('Running') : value === 'failed' ? t('Failed or stopped') : t('Completed'))
  const summary = [running > 0 && t('{n} running', { n: running }), failed > 0 && t('{n} failed or stopped', { n: failed })].filter(Boolean).join(' · ')

  return (
    <div data-agent-map onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
      <div className="flex items-baseline gap-2 px-3.5 pt-3 pb-2">
        <h3 className="text-sm font-semibold">{t('Agents')}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {plural(agents.length, '1 agent', '{n} agents')}
          {summary && ` · ${summary}`}
        </span>
      </div>
      {canFilter && (
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('Search agents')}
              placeholder={t('Search agents')}
              className="h-7 rounded-md pl-7 text-sm md:text-sm"
            />
          </div>
          <Select value={kind} onValueChange={(value) => setKind(String(value))}>
            <SelectTrigger aria-label={t('Filter by type')} className="h-7 w-[7.5rem] shrink-0 text-xs">
              <SelectValue>{(value: string) => (value === ALL ? t('All types') : value)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={ALL}>{t('All types')}</SelectItem>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(String(value))}>
            <SelectTrigger aria-label={t('Filter by status')} className="h-7 w-[7.5rem] shrink-0 text-xs">
              <SelectValue>{statusLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {[ALL, 'running', 'failed', 'done'].map((value) => (
                <SelectItem key={value} value={value}>
                  {statusLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div
        ref={scrollRef}
        role="list"
        aria-label={t('Subagents')}
        className="max-h-[min(60vh,440px)] min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {list === undefined ? (
          <p className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Spinner />
            {t('Loading…')}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('No agents match')}</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              return (
                <div
                  key={item.key}
                  role="listitem"
                  data-row={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === 'header' ? (
                    <div className="flex h-full items-end px-2 pb-1 text-xs font-semibold text-muted-foreground tabular-nums">{row.label}</div>
                  ) : row.kind === 'group' ? (
                    <button
                      type="button"
                      data-main
                      aria-expanded={row.open}
                      onClick={() => setDoneOpen((v) => !v)}
                      className="flex h-full w-full items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-muted-foreground tabular-nums outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {row.open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                      {t('{n} completed', { n: row.count })}
                    </button>
                  ) : (
                    <AgentRow
                      row={row}
                      now={now}
                      model={modelOf(row.agent)}
                      onToggle={() => toggleChildren(row.agent.id)}
                      onOpen={() => {
                        onPick()
                        openDialog(sessionId, row.agent.id, undefined, returnFocus())
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentRow({
  row,
  now,
  model,
  onToggle,
  onOpen
}: {
  row: Extract<Row, { kind: 'agent' }>
  now: number
  model: string | null
  onToggle: () => void
  onOpen: () => void
}) {
  const a = row.agent
  const meta = [a.kind, model, effortLabel(a.effort), a.background && t('background')].filter(Boolean).join(' · ')
  const stats = [a.tokens != null && t('{tokens} tokens', { tokens: formatTokens(a.tokens) })].filter(Boolean).join(' · ')
  return (
    <div className="flex h-full items-center rounded-md hover:bg-accent/50" style={{ paddingLeft: Math.min(row.depth, 6) * 14 }}>
      {row.childCount > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!row.collapsed}
          aria-label={row.collapsed ? t('Show {n} subagents of {title}', { n: row.childCount, title: a.title }) : t('Hide subagents of {title}', { title: a.title })}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight aria-hidden className={cn('size-3.5 transition-transform motion-reduce:transition-none', !row.collapsed && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        data-main
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-start gap-2.5 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="grid size-4 shrink-0 place-items-center pt-1">
          <StatusMark status={a.status} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm', a.status === 'running' ? 'text-foreground' : 'text-foreground/85')} title={a.title}>
              {a.title}
            </span>
            <span className="shrink-0 text-xs text-faint tabular-nums">{formatDuration(agentElapsed(a, now))}</span>
          </span>
          <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{meta}</span>
            {stats && <span className="shrink-0 tabular-nums">{stats}</span>}
          </span>
        </span>
      </button>
    </div>
  )
}
