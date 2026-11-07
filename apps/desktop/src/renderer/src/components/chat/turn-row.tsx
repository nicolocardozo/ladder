// Un turno della conversazione: messaggio dell'utente, passaggi, risposta finale, modifiche.
import { ChevronRight, CircleStop, CircleX, FileDiff, Info } from 'lucide-react'
import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatItem, FileChange, RunState } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { NewDivider, Spinner } from './bits'
import { useChatActions, useNow, useToggle } from './chat-context'
import { formatDuration, turnSummary } from './format'
import { Markdown } from './markdown'
import { RequestCard, ResolvedRequest } from './request-card'
import { MonoTitle, ToolRow } from './tool-row'
import type { AssistantItem, NoticeItem, Turn, TurnEndItem, UserItem } from './turns'

/** Nei turni in corso un gruppo lungo di strumenti mostra solo gli ultimi. */
const LIVE_GROUP_LIMIT = 8

const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const [expanded, toggle] = useToggle(`user:${item.id}`)
  const textRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, item.text])

  return (
    <div data-item-id={item.id} className="flex justify-end">
      <div
        className="w-fit max-w-[82%] min-w-0 rounded-[12px] bg-muted px-3 py-2 text-[13px] leading-[1.5] text-foreground"
        title={new Date(item.at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
      >
        <div
          ref={textRef}
          className={cn('break-words whitespace-pre-wrap', !expanded && 'line-clamp-6')}
        >
          {item.text}
        </div>
        {overflows || expanded ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className="mt-1 rounded-[4px] text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {expanded ? 'Mostra meno' : 'Mostra tutto'}
          </button>
        ) : null}
      </div>
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({ item, compact }: { item: AssistantItem; compact?: boolean }) {
  if (!item.text && item.streaming) return null
  return (
    <div data-item-id={item.id} className={cn('min-w-0', compact && 'py-1')}>
      <Markdown text={item.text} streaming={item.streaming} compact={compact} />
    </div>
  )
})

const NoticeLine = memo(function NoticeLine({ item }: { item: NoticeItem }) {
  if (item.tone === 'error') {
    return (
      <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[1.5] text-destructive">
        <CircleX aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={2} />
        <p className="min-w-0 break-words">
          <span className="font-semibold">Errore</span> · {item.text}
        </p>
      </div>
    )
  }
  return (
    <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[1.5] text-muted-foreground">
      <Info aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.9} />
      <p className="min-w-0 break-words">{item.text}</p>
    </div>
  )
})

/** Elenco dei passaggi con la linea verticale a sinistra, come nel mockup. */
function StepsList({
  items,
  limit,
  groupKey,
  dividerBefore = null
}: {
  items: ChatItem[]
  limit?: number
  groupKey: string
  dividerBefore?: string | null
}) {
  const [showAll, toggleAll] = useToggle(`grp:${groupKey}`)
  const hidden = limit && !showAll && items.length > limit ? items.length - limit : 0
  const shown = hidden > 0 ? items.slice(hidden) : items
  const dividerIndex = dividerBefore ? items.findIndex((i) => i.id === dividerBefore) : -1
  return (
    <div className="ml-[6px] grid min-w-0 gap-[3px] border-l border-border py-1 pl-[14px] dark:border-input/70">
      {dividerIndex >= 0 && dividerIndex < hidden ? <NewDivider /> : null}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={toggleAll}
          className="h-[22px] w-fit rounded-[5px] text-left text-[12px] text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {hidden === 1 ? '1 passaggio precedente' : `${hidden} passaggi precedenti`}
        </button>
      ) : null}
      {shown.map((item) => {
        let node: ReactNode = null
        switch (item.kind) {
          case 'tool':
            node = <ToolRow item={item} />
            break
          case 'request':
            node = <ResolvedRequest item={item} />
            break
          case 'assistant':
            node = <AssistantMessage item={item} compact />
            break
          case 'notice':
            node = <NoticeLine item={item} />
            break
        }
        return (
          <Fragment key={item.id}>
            {item.id === dividerBefore && dividerIndex >= hidden ? <NewDivider /> : null}
            {node}
          </Fragment>
        )
      })}
    </div>
  )
}

type Segment = { kind: 'group'; items: ChatItem[] } | { kind: 'item'; item: ChatItem }

/** Raggruppa gli strumenti e le richieste chiuse consecutive; testi e avvisi restano a sé. */
function segment(steps: ChatItem[]): Segment[] {
  const out: Segment[] = []
  for (const item of steps) {
    if (item.kind === 'tool' || item.kind === 'request') {
      const last = out[out.length - 1]
      if (last && last.kind === 'group') last.items.push(item)
      else out.push({ kind: 'group', items: [item] })
    } else {
      out.push({ kind: 'item', item })
    }
  }
  return out
}

function LiveLine({ activity, detail, startedAt, run }: { activity: string | null; detail: string | null; startedAt: number; run: RunState }) {
  const now = useNow(1000)
  const text = activity ?? (run === 'starting' ? 'Avvio della sessione' : 'Sta lavorando')
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-secondary-foreground">
      <Spinner />
      <span className="min-w-0 truncate">
        <MonoTitle title={text} detail={detail} />
      </span>
      <span className="ml-auto shrink-0 pl-3 font-mono text-[11px] text-muted-foreground tabular-nums">
        {formatDuration(now - startedAt)}
      </span>
    </div>
  )
}

const STATUS_LABEL: Record<FileChange['status'], string> = {
  A: 'Aggiunto',
  M: 'Modificato',
  D: 'Eliminato',
  R: 'Rinominato'
}

function ChangesCard({ end }: { end: TurnEndItem }) {
  const { openFile } = useChatActions()
  const added = end.files.reduce((n, f) => n + f.added, 0)
  const removed = end.files.reduce((n, f) => n + f.removed, 0)
  const count = end.files.length
  return (
    <div data-item-id={end.id} className="overflow-hidden rounded-[10px] border border-border dark:border-input/70">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12.5px] font-semibold text-foreground dark:border-input/70">
        <FileDiff aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.9} />
        {count === 1 ? '1 file modificato' : `${count} file modificati`}
        <span className="ml-auto font-mono text-[11.5px] font-medium">
          <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
        </span>
      </div>
      <ul>
        {end.files.map((file) => {
          const slash = file.path.lastIndexOf('/')
          const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
          const base = slash >= 0 ? file.path.slice(slash + 1) : file.path
          return (
            <li key={file.path} className="border-b border-border last:border-b-0 dark:border-input/50">
              <button
                type="button"
                onClick={() => openFile(file.path)}
                title={`${STATUS_LABEL[file.status]} · ${file.path}`}
                className="flex w-full min-w-0 items-center gap-2.5 px-3 py-[5px] text-left font-mono text-[11.5px] text-foreground/85 outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span aria-label={STATUS_LABEL[file.status]} className="w-3 shrink-0 text-faint">
                  {file.status}
                </span>
                <span className="flex min-w-0 flex-1">
                  {dir ? <span className="min-w-0 truncate text-muted-foreground">{dir}</span> : null}
                  <span className="shrink-0">{base}</span>
                </span>
                <span className="flex shrink-0 gap-2 tabular-nums">
                  {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                  {file.removed > 0 ? <span className="text-destructive">−{file.removed}</span> : null}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TurnFooter({ end }: { end: TurnEndItem }) {
  return (
    <>
      {end.files.length > 0 ? <ChangesCard end={end} /> : null}
      {end.status === 'error' ? (
        <div
          data-item-id={end.files.length > 0 ? undefined : end.id}
          className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[1.5] text-destructive"
        >
          <CircleX aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={2} />
          <p className="min-w-0 break-words">
            <span className="font-semibold">Errore</span> · {end.error ?? 'Il turno si è fermato per un errore.'}
          </p>
        </div>
      ) : null}
      {end.status === 'interrupted' ? (
        <div
          data-item-id={end.files.length > 0 ? undefined : end.id}
          className="flex items-center gap-2 text-[12.5px] text-muted-foreground"
        >
          <CircleStop aria-hidden className="size-[14px] shrink-0" strokeWidth={1.9} />
          Interrotto
        </div>
      ) : null}
    </>
  )
}

function SummaryRow({ turn, end }: { turn: Turn; end: TurnEndItem }) {
  const [open, toggle] = useToggle(`sum:${turn.id}`)
  return (
    <div className="grid min-w-0 gap-1">
      <button
        type="button"
        data-item-id={turn.steps[0]?.id}
        onClick={toggle}
        aria-expanded={open}
        className="group flex h-6 w-full min-w-0 items-center gap-[7px] rounded-[5px] text-left text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
          strokeWidth={2.2}
        />
        <span className="shrink-0">{turnSummary(end)}</span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border dark:bg-input/60" />
      </button>
      {open ? <StepsList items={turn.steps} groupKey={`${turn.id}:all`} /> : null}
    </div>
  )
}

export interface TurnRowProps {
  turn: Turn
  /** Il turno è quello in corso: mostra la riga live e i passaggi aperti. */
  live: boolean
  run: RunState
  activity: string | null
  /** Id dell'elemento davanti al quale va il divisore "Nuovo". */
  dividerBefore: string | null
}

export const TurnRow = memo(function TurnRow({ turn, live, run, activity, dividerBefore }: TurnRowProps) {
  const { end } = turn
  const parts: { key: string; ids: string[]; node: ReactNode }[] = []

  if (turn.user) parts.push({ key: turn.user.id, ids: [turn.user.id], node: <UserMessage item={turn.user} /> })

  const summarize = end !== null && turn.toolCount > 0
  if (summarize) {
    parts.push({ key: 'summary', ids: turn.steps.map((s) => s.id), node: <SummaryRow turn={turn} end={end} /> })
  } else {
    for (const seg of segment(turn.steps)) {
      if (seg.kind === 'group') {
        const first = seg.items[0].id
        // Il divisore "Nuovo" va dentro l'elenco, davanti alla riga giusta.
        const inside = dividerBefore && seg.items.some((i) => i.id === dividerBefore) ? dividerBefore : null
        parts.push({
          key: `g:${first}`,
          ids: [],
          node: (
            <StepsList
              items={seg.items}
              limit={live ? LIVE_GROUP_LIMIT : undefined}
              groupKey={first}
              dividerBefore={inside}
            />
          )
        })
      } else if (seg.item.kind === 'assistant') {
        parts.push({ key: seg.item.id, ids: [seg.item.id], node: <AssistantMessage item={seg.item} /> })
      } else if (seg.item.kind === 'notice') {
        parts.push({ key: seg.item.id, ids: [seg.item.id], node: <NoticeLine item={seg.item} /> })
      }
    }
  }

  if (turn.final) parts.push({ key: turn.final.id, ids: [turn.final.id], node: <AssistantMessage item={turn.final} /> })

  if (live && turn.open.length === 0 && run !== 'waiting' && run !== 'idle' && run !== 'error') {
    const runningTool = [...turn.steps].reverse().find((s) => s.kind === 'tool' && s.status === 'running')
    const detail = runningTool && runningTool.kind === 'tool' ? runningTool.detail : null
    parts.push({
      key: 'live',
      ids: [],
      node: <LiveLine activity={activity} detail={detail} startedAt={turn.startedAt} run={run} />
    })
  }

  for (const request of turn.open) parts.push({ key: request.id, ids: [request.id], node: <RequestCard item={request} /> })
  for (const notice of turn.notices) parts.push({ key: notice.id, ids: [notice.id], node: <NoticeLine item={notice} /> })
  if (end) parts.push({ key: end.id, ids: [end.id], node: <TurnFooter end={end} /> })

  const dividerIndex = dividerBefore ? parts.findIndex((p) => p.ids.includes(dividerBefore)) : -1

  return (
    <div className="mx-auto w-full max-w-[680px] px-6 pb-7">
      <div className="grid min-w-0 gap-3.5">
        {parts.map((part, i) => (
          <Fragment key={part.key}>
            {i === dividerIndex ? <NewDivider /> : null}
            {part.node}
          </Fragment>
        ))}
      </div>
    </div>
  )
})
