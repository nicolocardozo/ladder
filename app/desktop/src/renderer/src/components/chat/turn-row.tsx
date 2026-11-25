// A conversation turn: user message, steps, final reply, changes.
import { Bot, Check, ChevronRight, CirclePause, CircleStop, CircleX, CornerDownRight, FoldVertical, Info, X } from 'lucide-react'
import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatItem, RunState } from '@shared/protocol'
import { localeTag, plural, t } from '@shared/i18n'
import { isImagePlaceholder } from '@/components/composer/attachments'
import { planOfTool } from '@/lib/plan'
import { cn } from '@/lib/utils'
import { AgentsFinishedLine } from './agents-lines'
import { AdviceCard } from './advice-card'
import { AttachmentChips, NewDivider, Spinner } from './bits'
import { ChangedFileList } from './changed-files'
import { HandoffLine } from './handoff-line'
import { LimitCard, ResumeCard } from './system-cards'
import { useChatActions, useNow, useToggle } from './chat-context'
import { formatDuration, turnSummary } from './format'
import { Markdown } from './markdown'
import { FinalPlanAction, OpenPlanButton } from './plan-bits'
import { PlanCard } from './plan-card'
import { RequestCard, ResolvedRequest } from './request-card'
import { MonoTitle, ToolRow } from './tool-row'
import type { AgentStartItem, AssistantItem, CommandItem, CompactedItem, NoticeItem, PlanItem, Turn, TurnEndItem, UserItem } from './turns'

/** In running turns a long group of tools shows only the last ones. */
const LIVE_GROUP_LIMIT = 8

const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const [expanded, toggle] = useToggle(`user:${item.id}`)
  const textRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const attachments = item.attachments ?? []
  // With images only, the text is a placeholder: only the chips are shown.
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

/** Command / run by the user: a compact system row, not a message. Status has a shape and a label. */
/** Turn opened by the agent (not by you): it takes the place of the user message. */
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

/** Tokens in compact form: 142k above a thousand, the exact number below. */
const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Compacted context: with tokens before and after if the agent gave them, "auto" if it started on its own. */
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

/** List of steps with the vertical line on the left, as in the mockup. */
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

/** Groups consecutive tools and closed requests; texts and notices stay on their own. */
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

function ChangesCard({ end }: { end: TurnEndItem }) {
  const { openFile, openDiff } = useChatActions()
  // Closed by default; the state is kept in memory per turn.
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
        <ChangedFileList
          id={listId}
          files={end.files}
          hint={t('Click to view the turn diff · ⌥-click to open in editor')}
          onPick={(file, altKey) => (altKey ? openFile(file.path, undefined, true) : openDiff(end.turnId, file.path))}
        />
      ) : null}
    </div>
  )
}

/** Turn finished with no changes, commands, agents or questions: it says so, and offers to write "Continue" in the composer (without sending it). */
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
  /** The turn is the current one: it shows the live row and the open steps. */
  live: boolean
  run: RunState
  activity: string | null
  /** Id of the element the "New" divider goes in front of. */
  dividerBefore: string | null
  /** Seq of the last "Started by the agent after background agents finished" row (-1 if none): a "picked up" row before it would be a duplicate. */
  bgStartSeq: number
  /** Last turn of the conversation (not counting advice cards): only its final answer can be the plan. */
  last?: boolean
}

export const TurnRow = memo(function TurnRow({ turn, live, run, activity, dividerBefore, bgStartSeq, last = false }: TurnRowProps) {
  const { end } = turn
  const { compact } = useChatActions()
  const parts: { key: string; ids: string[]; node: ReactNode }[] = []

  if (turn.user) parts.push({ key: turn.user.id, ids: [turn.user.id], node: <UserMessage item={turn.user} /> })

  if (turn.start) parts.push({ key: turn.start.id, ids: [turn.start.id], node: <AgentStartLine item={turn.start} /> })

  if (turn.handoff) parts.push({ key: turn.handoff.id, ids: [turn.handoff.id], node: <HandoffLine item={turn.handoff} /> })

  for (const command of turn.commands) parts.push({ key: command.id, ids: [command.id], node: <CommandLine item={command} /> })

  for (const advice of turn.advice) parts.push({ key: advice.id, ids: [advice.id], node: <AdviceCard item={advice} /> })

  for (const card of turn.cards) parts.push({ key: card.id, ids: [card.id], node: card.kind === 'resume' ? <ResumeCard item={card} /> : <LimitCard item={card} /> })

  const summarize = end !== null && turn.toolCount > 0
  if (summarize) {
    // Messages inserted into the turn stay visible even with the turn summarized: after the summary, in order.
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
        // The "New" divider goes inside the list, in front of the right row.
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
  // Plan in a Plan session without ExitPlanMode (Codex, ACP): the final answer of the last finished turn is the plan.
  const planText = turn.steps.reduce<string | null>((found, s) => (s.kind === 'tool' ? (planOfTool(s) ?? found) : found), null)
  if (planText && summarize) parts.push({ key: 'plan-tool', ids: [], node: <div className="flex"><OpenPlanButton text={planText} /></div> })
  else if (!planText && turn.final && last) parts.push({ key: `plan:${turn.final.id}`, ids: [], node: <FinalPlanAction text={turn.final.text} /> })

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
