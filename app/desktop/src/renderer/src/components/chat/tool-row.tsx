// Riga compatta di uno strumento: icona del tipo, titolo, durata, stato. L'output si apre con un clic.
import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  Search,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { ToolKind } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { browserToolOf, browserToolView } from '@/lib/browser-agent'
import { cn } from '@/lib/utils'
import { ChildSessionLink } from '@/components/session-origin'
import { AgentToolRow } from './agent-row'
import { Spinner } from './bits'
import { useToggle } from './chat-context'
import { formatShortDuration } from './format'
import type { ToolItem } from './turns'

const kindIcon: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePenLine,
  search: Search,
  web: Globe,
  agent: Bot,
  plan: ListChecks,
  other: Wrench
}

const OUTPUT_LINES = 30

/** Il titolo con la parte che coincide con il comando o il percorso in monospazio: "Esegue `pnpm test`". */
export function MonoTitle({ title, detail }: { title: string; detail: string | null }): ReactNode {
  if (detail && detail.length > 0 && detail !== title) {
    const at = title.indexOf(detail)
    if (at >= 0) {
      return (
        <>
          {title.slice(0, at)}
          <code className="font-mono text-[0.93em] text-foreground/85">{detail}</code>
          {title.slice(at + detail.length)}
        </>
      )
    }
  }
  return title
}

function StatusGlyph({ status }: { status: ToolItem['status'] }) {
  switch (status) {
    case 'running':
      return <Spinner label={t('Running')} />
    case 'done':
      return <Check role="img" aria-label={t('Completed')} className="size-3.5 shrink-0 text-success" strokeWidth={2.2} />
    case 'error':
      return <X role="img" aria-label={t('Error')} className="size-3.5 shrink-0 text-destructive" strokeWidth={2.4} />
    case 'denied':
      return <Ban role="img" aria-label={t('Denied')} className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
  }
}

function ToolOutput({ item }: { item: ToolItem }) {
  const [all, toggleAll] = useToggle(`out:${item.id}`)
  const lines = item.output ? item.output.replace(/\n+$/, '').split('\n') : []
  const truncated = lines.length > OUTPUT_LINES
  // Per i comandi conta la coda (riepilogo dei test, errori); per il resto l'inizio.
  const tail = item.tool === 'command'
  const shown = !truncated || all ? lines : tail ? lines.slice(-OUTPUT_LINES) : lines.slice(0, OUTPUT_LINES)
  const isDiff = item.tool === 'edit' && lines.some((l) => /^[+-]/.test(l))
  const hidden = lines.length - shown.length

  const more = truncated ? (
    <button
      type="button"
      onClick={toggleAll}
      className="w-full border-border px-2.5 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground dark:border-input/60"
    >
      {all ? t('Show less') : `${plural(hidden, '{n} line hidden', '{n} lines hidden')} · ${t('Show all')}`}
    </button>
  ) : null

  return (
    <div className="chat-wide-sym mt-1 mb-1.5 overflow-hidden rounded-[7px] border border-border bg-[var(--chat-code-bg)] dark:border-input/60">
      {item.detail && (
        <div className="border-b border-border px-2.5 py-1.5 font-mono text-xs leading-[1.5] break-all whitespace-pre-wrap text-foreground/85 last:border-b-0 dark:border-input/60">
          {item.tool === 'command' ? <span className="text-faint select-none">$ </span> : null}
          {item.detail}
        </div>
      )}
      {truncated && tail && !all ? <div className="border-b border-inherit">{more}</div> : null}
      {lines.length > 0 && (
        <pre className="m-0 overflow-x-auto px-2.5 py-2 font-mono text-xs leading-[1.55] text-muted-foreground">
          {shown.map((line, i) => (
            <span
              key={i}
              className={cn(
                'block min-h-[1.55em]',
                isDiff && line.startsWith('+') && 'text-success',
                isDiff && line.startsWith('-') && 'text-destructive'
              )}
            >
              {line}
            </span>
          ))}
        </pre>
      )}
      {lines.length === 0 && !item.detail ? <p className="px-2.5 py-1.5 text-xs text-faint">{t('No output')}</p> : null}
      {truncated && (!tail || all) ? <div className="border-t border-border dark:border-input/60">{more}</div> : null}
    </div>
  )
}

/** Un sotto-agente è una riga sola che apre il dettaglio; gli altri strumenti si espandono sul posto. */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  return item.tool === 'agent' ? <AgentToolRow item={item} /> : <PlainToolRow item={item} />
})

/** Strumenti del browser dell'agente: etichetta leggibile e niente testo digitato (né nel dettaglio né nell'esito). */
function withBrowserLabel(item: ToolItem): ToolItem {
  const tool = browserToolOf(item.name)
  if (!tool) return item
  const view = browserToolView(tool, item.detail)
  return { ...item, tool: 'web', title: view.title, detail: view.detail, output: view.hideOutput ? null : item.output }
}

function PlainToolRow({ item: raw }: { item: ToolItem }) {
  const item = withBrowserLabel(raw)
  const [open, toggle] = useToggle(`tool:${item.id}`)
  const expandable = Boolean(item.output || (item.detail && item.detail !== item.title))
  const Icon = kindIcon[item.tool] ?? Wrench
  const duration = item.endedAt ? formatShortDuration(item.endedAt - item.at) : null

  // Le righe senza dettagli non sono pulsanti: niente tappe inutili con Tab.
  const Row = expandable ? 'button' : 'div'
  return (
    <div data-item-id={item.id} className="min-w-0">
      <Row
        type={expandable ? 'button' : undefined}
        onClick={expandable ? toggle : undefined}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          'group flex h-[22px] w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-sm text-muted-foreground outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring/50',
          expandable && 'hover:text-foreground'
        )}
      >
        <Icon aria-hidden className="size-[13px] shrink-0" strokeWidth={1.8} />
        <span className={cn('min-w-0 truncate', item.status === 'running' && 'text-foreground/90')}>
          <MonoTitle title={item.title} detail={item.detail} />
        </span>
        {item.status === 'error' ? <span className="shrink-0 text-destructive">· {t('error')}</span> : null}
        {item.status === 'denied' ? <span className="shrink-0">· {t('denied')}</span> : null}
        <span className="flex-1" />
        {duration ? <span className="shrink-0 font-mono text-xs text-faint tabular-nums">{duration}</span> : null}
        <StatusGlyph status={item.status} />
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-faint transition-transform motion-reduce:transition-none',
            !expandable && 'invisible',
            expandable && !open && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
            open && 'rotate-90'
          )}
        />
      </Row>
      {open && expandable ? <ToolOutput item={item} /> : null}
      <ChildSessionLink name={item.name} output={item.output} />
    </div>
  )
}
