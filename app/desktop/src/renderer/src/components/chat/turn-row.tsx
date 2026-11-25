// Un turno della conversazione: messaggio dell'utente, passaggi, risposta finale, modifiche.
import { Bot, Check, ChevronRight, CirclePause, CircleStop, CircleX, CornerDownRight, FoldVertical, Info, X } from 'lucide-react'
import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatItem, FileChange, RunState } from '@shared/protocol'
import { localeTag, plural, t } from '@shared/i18n'
import { isImagePlaceholder } from '@/components/composer/attachments'
import { cn } from '@/lib/utils'
import { AgentsFinishedLine } from './agents-lines'
import { AttachmentChips, NewDivider, Spinner } from './bits'
import { useChatActions, useNow, useToggle } from './chat-context'
import { formatDuration, turnSummary } from './format'
import { Markdown } from './markdown'
import { PlanCard } from './plan-card'
import { RequestCard, ResolvedRequest } from './request-card'
import { MonoTitle, ToolRow } from './tool-row'
import type { AgentStartItem, AssistantItem, CommandItem, CompactedItem, NoticeItem, PlanItem, Turn, TurnEndItem, UserItem } from './turns'

/** Nei turni in corso un gruppo lungo di strumenti mostra solo gli ultimi. */
const LIVE_GROUP_LIMIT = 8

const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const [expanded, toggle] = useToggle(`user:${item.id}`)
  const textRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const attachments = item.attachments ?? []
  // Con sole immagini il testo è un segnaposto: si mostrano solo i chip.
  const showText = !(attachments.length > 0 && isImagePlaceholder(item.text))

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
        className="w-fit max-w-[min(82%,100ch)] min-w-0 rounded-[12px] bg-muted px-3 py-2 font-[family-name:var(--font-chat)] text-[length:var(--chat-size)] leading-[var(--chat-leading)] text-foreground"
        title={new Date(item.at).toLocaleString(localeTag(), { dateStyle: 'short', timeStyle: 'short' })}
      >
        {showText ? (
          <div
            ref={textRef}
            className={cn('break-words whitespace-pre-wrap', !expanded && 'line-clamp-6')}
          >
            {item.text}
          </div>
        ) : null}
        {showText && (overflows || expanded) ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className="mt-1 rounded-[4px] text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {expanded ? t('Show less') : t('Show all')}
          </button>
        ) : null}
        {attachments.length > 0 ? (
          <div className={cn(showText && 'mt-1.5')}>
            <AttachmentChips attachments={attachments} />
          </div>
        ) : null}
        {item.steered ? (
          <p className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
            <CornerDownRight aria-hidden className="size-3" strokeWidth={2} />
            {t('Sent into the turn')}
          </p>
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
      <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-destructive">
        <CircleX aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={2} />
        <p className="min-w-0 break-words">
          <span className="font-semibold">{t('Error')}</span> · {item.text}
        </p>
      </div>
    )
  }
  return (
    <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
      <Info aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.9} />
      <p className="min-w-0 break-words">{item.text}</p>
    </div>
  )
})

/** Comando / eseguito dall'utente: riga di sistema compatta, non un messaggio. Lo stato ha forma ed etichetta. */
/** Turno aperto dall'agente (non da te): sta al posto del messaggio dell'utente. */
function AgentStartLine({ item }: { item: AgentStartItem }) {
  const text =
    item.reason === 'background-agents'
      ? item.finished !== null
        ? plural(item.finished, 'Started by the agent after 1 background agent finished', 'Started by the agent after {n} background agents finished')
        : t('Started by the agent after background agents finished')
      : t('Started by the agent')
  return (
    <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
      <span className="mt-[2px] flex size-[14px] shrink-0 items-center justify-center">
        <Bot aria-hidden className="size-3.5" strokeWidth={1.8} />
      </span>
      <p className="min-w-0 break-words">{text}</p>
    </div>
  )
}

const CommandLine = memo(function CommandLine({ item }: { item: CommandItem }) {
  return (
    <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
      <span className="mt-[2px] flex size-[14px] shrink-0 items-center justify-center">
        {item.status === 'running' ? (
          <Spinner label={t('Running')} />
        ) : item.status === 'done' ? (
          <Check role="img" aria-label={t('Completed')} className="size-3.5 text-success" strokeWidth={2.2} />
        ) : item.status === 'interrupted' ? (
          <CircleStop role="img" aria-label={t('Interrupted')} className="size-3.5" strokeWidth={1.9} />
        ) : (
          <X role="img" aria-label={t('Error')} className="size-3.5 text-destructive" strokeWidth={2.4} />
        )}
      </span>
      <p className="min-w-0 break-words">
        <code className="font-mono text-xs font-medium text-foreground">/{item.name}</code>
        {item.args ? (
          <>
            {' '}
            <span className="font-mono text-xs">{item.args}</span>
          </>
        ) : null}
        {item.status === 'running' ? <span> · {t('Running')}</span> : null}
        {item.status === 'interrupted' ? <span> · {t('Interrupted')}</span> : null}
        {item.status === 'error' ? (
          <span className="text-destructive">
            {' · '}
            <span className="font-semibold">{t('Error')}</span>
            {item.error ? <> · {item.error}</> : null}
          </span>
        ) : null}
      </p>
    </div>
  )
})

/** Token in forma compatta: 142k sopra i mille, il numero esatto sotto. */
const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Contesto compattato: con i token prima e dopo se l'agente li ha dati, "auto" se è partito da solo. */
const CompactedLine = memo(function CompactedLine({ item }: { item: CompactedItem }) {
  const both = item.preTokens !== null && item.postTokens !== null
  return (
    <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
      <FoldVertical aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.9} />
      <p className="min-w-0 break-words">
        {t('Context compacted')}
        {item.trigger === 'auto' ? <span> · {t('auto')}</span> : null}
        {both ? (
          <>
            {' · '}
            <span className="font-mono text-xs">{t('{before} → {after} tokens', { before: tokens(item.preTokens!), after: tokens(item.postTokens!) })}</span>
          </>
        ) : null}
      </p>
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
    <div className="chat-steps ml-[6px] grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[3px] border-l border-border py-1 pl-[14px] dark:border-input/70">
      {dividerIndex >= 0 && dividerIndex < hidden ? <NewDivider /> : null}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={toggleAll}
          className="h-[22px] w-fit rounded-[5px] text-left text-xs text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {plural(hidden, '{n} earlier step', '{n} earlier steps')}
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
          case 'compacted':
            node = <CompactedLine item={item} />
            break
          case 'user':
            node = <UserMessage item={item} />
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
  const text = activity ?? (run === 'starting' ? t('Starting session') : t('Working'))
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-secondary-foreground">
      <Spinner />
      <span className="min-w-0 truncate">
        <MonoTitle title={text} detail={detail} />
      </span>
      <span className="ml-auto shrink-0 pl-3 font-mono text-xs text-muted-foreground tabular-nums">
        {formatDuration(now - startedAt)}
      </span>
    </div>
  )
}

// Testo inglese: si traduce con t() dove si mostra.
const STATUS_LABEL: Record<FileChange['status'], string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed'
}

function ChangesCard({ end }: { end: TurnEndItem }) {
  const { openFile, openDiff } = useChatActions()
  // Chiusa per default; lo stato resta in memoria per turno.
  const [open, toggle] = useToggle(`chg:${end.turnId}`)
  const added = end.files.reduce((n, f) => n + f.added, 0)
  const removed = end.files.reduce((n, f) => n + f.removed, 0)
  const count = end.files.length
  const listId = `chg-${end.turnId}`
  return (
    <div data-item-id={end.id} className="grid min-w-0 gap-1">
      <div className="flex h-[22px] min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={listId}
          className="group flex h-[22px] min-w-0 flex-1 items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
            strokeWidth={2.2}
          />
          <span className="shrink-0">{plural(count, '{n} file changed', '{n} files changed')}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-diff-added">+{added}</span> <span className="text-diff-removed">−{removed}</span>
          </span>
          <span aria-hidden className="h-px min-w-4 flex-1 bg-border dark:bg-input/60" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            openDiff(end.turnId)
          }}
          className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {t('Review')}
        </button>
      </div>
      {open ? (
        <ul id={listId} className="overflow-hidden rounded-[10px] border border-border dark:border-input/70">
          {end.files.map((file) => {
            const slash = file.path.lastIndexOf('/')
            const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
            const base = slash >= 0 ? file.path.slice(slash + 1) : file.path
            return (
              <li key={file.path} className="border-b border-border last:border-b-0 dark:border-input/50">
                <button
                  type="button"
                  onClick={(event) => (event.altKey ? openFile(file.path, undefined, true) : openDiff(end.turnId, file.path))}
                  title={`${t(STATUS_LABEL[file.status])} · ${file.path}\n${t('Click to view the turn diff · ⌥-click to open in editor')}`}
                  className="flex w-full min-w-0 items-center gap-2.5 px-3 py-[5px] text-left font-mono text-xs text-foreground/85 outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <span aria-label={t(STATUS_LABEL[file.status])} className="w-3 shrink-0 text-faint">
                    {file.status}
                  </span>
                  <span className="flex min-w-0 flex-1">
                    {dir ? <span className="min-w-0 truncate text-muted-foreground">{dir}</span> : null}
                    <span className="shrink-0">{base}</span>
                  </span>
                  <span className="flex shrink-0 gap-2 tabular-nums">
                    {file.added > 0 ? <span className="text-diff-added">+{file.added}</span> : null}
                    {file.removed > 0 ? <span className="text-diff-removed">−{file.removed}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/** Turno finito senza modifiche, comandi, agenti né domande: lo dice, e propone di scrivere "Continue" nel composer (senza inviarlo). */
function StalledNote({ end, withId }: { end: TurnEndItem; withId: boolean }) {
  const { prefill } = useChatActions()
  return (
    <div data-item-id={withId ? end.id : undefined} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <div className="flex min-w-0 items-center gap-2 text-sm leading-[1.5] text-muted-foreground">
        <CirclePause aria-hidden className="size-[14px] shrink-0" strokeWidth={1.9} />
        <p className="min-w-0 break-words">
          {t('Stopped without asking anything')}
          <span className="text-faint"> · {t('Tell it to keep going')}</span>
        </p>
      </div>
      {prefill ? (
        <button
          type="button"
          onClick={() => prefill(t('Continue'))}
          className="rounded-[5px] px-1.5 py-0.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {t('Write “Continue”')}
        </button>
      ) : null}
    </div>
  )
}

function TurnFooter({ end }: { end: TurnEndItem }) {
  const stalled = end.stalled === true && end.status === 'completed'
  return (
    <>
      {end.files.length > 0 ? <ChangesCard end={end} /> : null}
      {end.status === 'error' ? (
        <div
          data-item-id={end.files.length > 0 ? undefined : end.id}
          className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-destructive"
        >
          <CircleX aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={2} />
          <p className="min-w-0 break-words">
            <span className="font-semibold">{t('Error')}</span> · {end.error ?? t('The turn stopped because of an error.')}
          </p>
        </div>
      ) : null}
      {end.status === 'interrupted' ? (
        <div
          data-item-id={end.files.length > 0 ? undefined : end.id}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <CircleStop aria-hidden className="size-[14px] shrink-0" strokeWidth={1.9} />
          {t('Interrupted')}
        </div>
      ) : null}
      {stalled ? <StalledNote end={end} withId={end.files.length === 0} /> : null}
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
        className="group flex h-6 w-full min-w-0 items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
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
  /** Seq dell'ultima riga "Started by the agent after background agents finished" (-1 se non c'è): una riga "picked up" prima di lei sarebbe un doppione. */
  bgStartSeq: number
}

export const TurnRow = memo(function TurnRow({ turn, live, run, activity, dividerBefore, bgStartSeq }: TurnRowProps) {
  const { end } = turn
  const { compact } = useChatActions()
  const parts: { key: string; ids: string[]; node: ReactNode }[] = []

  if (turn.user) parts.push({ key: turn.user.id, ids: [turn.user.id], node: <UserMessage item={turn.user} /> })

  if (turn.start) parts.push({ key: turn.start.id, ids: [turn.start.id], node: <AgentStartLine item={turn.start} /> })

  for (const command of turn.commands) parts.push({ key: command.id, ids: [command.id], node: <CommandLine item={command} /> })

  const summarize = end !== null && turn.toolCount > 0
  if (summarize) {
    // I messaggi inseriti nel turno restano visibili anche con il turno riassunto: dopo il riepilogo, in ordine.
    const inserted = turn.steps.filter((s): s is UserItem => s.kind === 'user')
    // Plan cards never collapse into the summary: they stay visible after it.
    const plans = turn.steps.filter((s): s is PlanItem => s.kind === 'plan')
    const summarized = inserted.length || plans.length ? { ...turn, steps: turn.steps.filter((s) => s.kind !== 'user' && s.kind !== 'plan') } : turn
    parts.push({ key: 'summary', ids: summarized.steps.map((s) => s.id), node: <SummaryRow turn={summarized} end={end} /> })
    for (const message of inserted) parts.push({ key: message.id, ids: [message.id], node: <UserMessage item={message} /> })
    for (const plan of plans) parts.push({ key: plan.id, ids: [plan.id], node: <PlanCard item={plan} /> })
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
      } else if (seg.item.kind === 'user') {
        parts.push({ key: seg.item.id, ids: [seg.item.id], node: <UserMessage item={seg.item} /> })
      } else if (seg.item.kind === 'compacted') {
        parts.push({ key: seg.item.id, ids: [seg.item.id], node: <CompactedLine item={seg.item} /> })
      } else if (seg.item.kind === 'plan') {
        parts.push({ key: seg.item.id, ids: [seg.item.id], node: <PlanCard item={seg.item} /> })
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
  for (const notice of turn.notices)
    parts.push({ key: notice.id, ids: [notice.id], node: notice.kind === 'compacted' ? <CompactedLine item={notice} /> : <NoticeLine item={notice} /> })
  if (end) parts.push({ key: end.id, ids: [end.id], node: <TurnFooter end={end} /> })
  for (const finished of turn.finished) {
    const node = <AgentsFinishedLine item={finished} hideResumed={finished.seq < bgStartSeq} />
    if (finished.state === 'dismissed' || (finished.state === 'resumed' && finished.seq < bgStartSeq)) continue
    parts.push({ key: finished.id, ids: [finished.id], node })
  }

  if (parts.length === 0) return null

  const dividerIndex = dividerBefore ? parts.findIndex((p) => p.ids.includes(dividerBefore)) : -1

  return (
    <div className="chat-col pb-7" data-compact={compact ? '' : undefined}>
      <div className="chat-text">
        <div className="chat-reset grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3.5">
          {parts.map((part, i) => (
            <Fragment key={part.key}>
              {i === dividerIndex ? <NewDivider /> : null}
              {part.node}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
})
