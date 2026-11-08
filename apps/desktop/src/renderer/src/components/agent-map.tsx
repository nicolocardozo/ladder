// Mappa degli agenti: i sotto-agenti che la sessione ha avviato, ad albero, con stato, durata e token.
// Si apre dal chip "N agents" sopra il composer; la sidebar ne mostra solo il conteggio.
import { useMemo } from 'react'
import { Check, ChevronDown, CircleX, Square } from 'lucide-react'
import { localeTag, plural, t } from '@shared/i18n'
import type { SessionSummary, SubagentInfo } from '@shared/protocol'
import { AgentMark, modelLabel, useAgentLine } from '@/components/agent-mark'
import { useNow } from '@/components/chat/chat-context'
import { RunningRing } from '@/components/status'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

export function runningSubagents(session: SessionSummary | null | undefined): number {
  return session?.subagents?.filter((a) => a.status === 'running').length ?? 0
}

/** "12s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function formatTokens(n: number): string {
  return new Intl.NumberFormat(localeTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

interface Node {
  agent: SubagentInfo
  children: Node[]
}

function buildTree(agents: SubagentInfo[]): Node[] {
  const nodes = new Map(agents.map((a) => [a.id, { agent: a, children: [] as Node[] }]))
  const roots: Node[] = []
  for (const node of nodes.values()) {
    const parent = node.agent.parentId ? nodes.get(node.agent.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: Node[]) => {
    list.sort((a, b) => a.agent.startedAt - b.agent.startedAt)
    for (const n of list) sort(n.children)
  }
  sort(roots)
  return roots
}

function StatusMark({ status }: { status: SubagentInfo['status'] }) {
  switch (status) {
    case 'running':
      return <RunningRing />
    case 'done':
      return <Check aria-label={t('Completed')} className="size-3.5 text-success" strokeWidth={2.4} />
    case 'error':
      return <CircleX aria-label={t('Error')} className="size-3.5 text-destructive" strokeWidth={2.2} />
    default:
      return <Square aria-label={t('Stopped')} className="size-3 text-muted-foreground" strokeWidth={2.4} />
  }
}

/** Chip sopra il composer: c'è solo quando la sessione ha avviato sotto-agenti. */
export function AgentMapChip({ session }: { session: SessionSummary }) {
  const agents = session.subagents ?? []
  if (!agents.length) return null
  const running = runningSubagents(session)
  const label = plural(agents.length, '1 agent', '{n} agents')
  const description = running
    ? t('{label}, {running} running', { label, running })
    : label
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t('Agent map: {description}', { description })}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-popup-open:bg-accent data-popup-open:text-foreground'
        )}
      >
        {running ? <RunningRing /> : <Check className="size-3.5 text-success" strokeWidth={2.4} aria-hidden />}
        <span>{label}</span>
        {running > 0 && running < agents.length && <span className="text-xs text-faint tabular-nums">{t('{running} running', { running })}</span>}
        <ChevronDown className="size-3.5 opacity-70" aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-[min(30rem,calc(100vw-2rem))] gap-0 p-0">
        <AgentMap session={session} />
      </PopoverContent>
    </Popover>
  )
}

export function AgentMap({ session }: { session: SessionSummary }) {
  const agents = session.subagents ?? []
  const running = agents.filter((a) => a.status === 'running').length
  const now = useNow(1000, running > 0)
  const tree = useMemo(() => buildTree(agents), [agents])
  const line = useAgentLine(session.agent, session.model)
  const done = agents.filter((a) => a.status === 'done').length
  const failed = agents.length - running - done
  const summary = [
    running && t('{n} running', { n: running }),
    done && t('{n} done', { n: done }),
    failed && t('{n} stopped', { n: failed })
  ].filter(Boolean).join(' · ')

  return (
    <div data-agent-map className="flex max-h-[min(70vh,560px)] min-h-0 flex-col">
      <div className="flex items-baseline gap-2 border-b border-border/60 px-3.5 py-2.5">
        <h3 className="text-sm font-semibold">{t('Agents')}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">{summary}</span>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 py-2">
        <div className="flex items-start gap-2.5 rounded-md px-1.5 py-1.5">
          <span className="grid size-4 shrink-0 place-items-center pt-0.5 text-muted-foreground">
            <AgentMark agent={session.agent} size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{t('Main session')}</div>
            <div className="truncate text-xs text-muted-foreground">
              {[line.name, line.model, session.run === 'running' ? session.activity : null].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
        <ul aria-label={t('Subagents')} className="ml-[13px] border-l border-border/70 pl-2">
          {tree.map((node) => (
            <AgentNode key={node.agent.id} node={node} now={now} session={session} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function AgentNode({ node, now, session }: { node: Node; now: number; session: SessionSummary }) {
  const a = node.agent
  const status = useApp((s) => s.agents.find((x) => x.agent === session.agent) ?? null)
  const model = modelLabel(status, a.model)
  const elapsed = (a.endedAt ?? (a.status === 'running' ? now : a.startedAt)) - a.startedAt
  const meta = [
    a.kind,
    model,
    a.background && t('background'),
    a.tokens != null && t('{tokens} tokens', { tokens: formatTokens(a.tokens) }),
    a.toolUses != null && a.toolUses > 0 && plural(a.toolUses, '1 tool', '{n} tools')
  ].filter(Boolean).join(' · ')
  return (
    <li>
      <div className="flex items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50">
        <span className="grid size-4 shrink-0 place-items-center pt-0.5">
          <StatusMark status={a.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm', a.status === 'running' ? 'text-foreground' : 'text-foreground/85')} title={a.title}>
              {a.title}
            </span>
            <span className="shrink-0 text-xs text-faint tabular-nums">{formatDuration(elapsed)}</span>
          </div>
          {a.status === 'running' && a.activity && <div className="truncate text-xs text-foreground/75">{a.activity}</div>}
          {meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
        </div>
      </div>
      {node.children.length > 0 && (
        <ul className="ml-[13px] border-l border-border/70 pl-2">
          {node.children.map((child) => (
            <AgentNode key={child.agent.id} node={child} now={now} session={session} />
          ))}
        </ul>
      )}
    </li>
  )
}
