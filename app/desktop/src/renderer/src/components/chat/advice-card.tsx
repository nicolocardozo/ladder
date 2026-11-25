// Card of /advisor and /committee: the question, one entry per agent with its advice, and actions to stop, send or open.
import { Check, ChevronRight, CircleAlert, CircleStop, CircleX, MessagesSquare, Send, TriangleAlert } from 'lucide-react'
import { memo, useId, useState } from 'react'
import type { AgentId } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { AgentMark, modelLabel, useAgentLine } from '@/components/agent-mark'
import { usePeerSession } from '@/components/handoff-bits'
import { Button } from '@/components/ui/button'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { Spinner } from './bits'
import { useChatActions, useToggle } from './chat-context'
import { Markdown } from './markdown'
import type { AdviceChatItem } from './turns'

type Entry = AdviceChatItem['entries'][number]

/** Above this length the advice starts collapsed and opens with "Show full advice". */
const COLLAPSE_CHARS = 420

const linkClass = 'shrink-0 rounded-[5px] px-1.5 py-0.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

/** Agent name as the sidebar writes it, hook-free so it can be used in a list. */
function useAgentNames() {
  const agents = useApp((s) => s.agents)
  return (id: AgentId) => agents.find((a) => a.agent === id)?.name ?? (id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : id.replace(/^acp:/, ''))
}

/** Entry state: shape, label and color together (never color alone). */
function EntryState({ state }: { state: Entry['state'] }) {
  switch (state) {
    case 'running':
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner label={t('Running')} />
          {t('Running')}
        </span>
      )
    case 'done':
      return (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Check aria-hidden className="size-3 text-success" strokeWidth={2.4} />
          {t('Done')}
        </span>
      )
    case 'error':
      return (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-destructive">
          <CircleX aria-hidden className="size-3" strokeWidth={2.2} />
          {t('Error')}
        </span>
      )
    case 'stopped':
      return (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <CircleStop aria-hidden className="size-3" strokeWidth={2} />
          {t('Stopped')}
        </span>
      )
  }
}

/** Cross-review verdict: shape, label and color together (never color alone). */
function VerdictBadge({ verdict }: { verdict: NonNullable<AdviceChatItem['verdict']> }) {
  const view = {
    ok: { icon: <Check aria-hidden className="size-3" strokeWidth={2.4} />, label: t('No issues'), tone: 'border-success/40 text-success' },
    minor: { icon: <CircleAlert aria-hidden className="size-3" strokeWidth={2.2} />, label: t('Minor issues'), tone: 'border-border text-foreground dark:border-input' },
    serious: { icon: <TriangleAlert aria-hidden className="size-3" strokeWidth={2.2} />, label: t('Serious issues'), tone: 'border-destructive/50 bg-destructive/10 font-semibold text-destructive' }
  }[verdict]
  return (
    <span className={cn('flex h-[20px] shrink-0 items-center gap-1 rounded-[6px] border px-1.5 text-xs font-medium', view.tone)}>
      {view.icon}
      {view.label}
    </span>
  )
}

function AdviceEntry({ item, entry, index }: { item: AdviceChatItem; entry: Entry; index: number }) {
  const { name, model } = useAgentLine(entry.agent, entry.model)
  const status = useApp((s) => s.agents.find((a) => a.agent === entry.agent) ?? null)
  const label = model ?? modelLabel(status, entry.model)
  const { open } = usePeerSession(entry.sessionId)
  const textId = useId()
  const [expanded, toggle] = useToggle(`adv:${item.id}:${index}`)
  const long = (entry.text?.length ?? 0) > COLLAPSE_CHARS
  const clipped = long && !expanded
  return (
    <section aria-label={t('Advice from {agent}', { agent: name })} className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border px-3 py-2.5 dark:border-input/70">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AgentMark agent={entry.agent} size={14} className="text-muted-foreground" />
        <h4 className="min-w-[7rem] flex-1 text-sm font-medium break-words text-foreground">
          {name}
          {label ? <span className="font-normal text-muted-foreground"> · {label}</span> : null}
        </h4>
        <EntryState state={entry.state} />
      </header>
      {entry.state === 'error' || (entry.state === 'stopped' && entry.error) ? (
        <p role={entry.state === 'error' ? 'alert' : undefined} className={cn('min-w-0 text-sm leading-[1.5] break-words', entry.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {entry.error ?? t('The advice could not be completed.')}
        </p>
      ) : entry.text ? (
        <>
          <div id={textId} className={cn('relative min-w-0', clipped && 'max-h-[168px] overflow-hidden')}>
            <Markdown text={entry.text} compact />
            {clipped ? <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" /> : null}
          </div>
          {long ? (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              aria-controls={textId}
              className="flex h-[22px] w-fit items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} strokeWidth={2.2} />
              {expanded ? t('Show less') : t('Show full advice')}
            </button>
          ) : null}
        </>
      ) : entry.state === 'running' ? (
        <p className="text-sm text-muted-foreground">{t('Reading the code…')}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('No advice was written.')}</p>
      )}
      {open ? (
        <div className="-mb-1 flex justify-end">
          <button type="button" onClick={open} className={linkClass} aria-label={t('Open the session of {agent}', { agent: name })}>
            {t('Open')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

export const AdviceCard = memo(function AdviceCard({ item }: { item: AdviceChatItem }) {
  const { sessionId } = useChatActions()
  const own = useApp((s) => (sessionId ? s.sessions[sessionId]?.agent : undefined))
  const { name: ownName } = useAgentLine(own ?? 'claude-code', null)
  const nameOf = useAgentNames()
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<'stop' | 'forward' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const noteId = useId()

  const running = item.entries.filter((e) => e.state === 'running').length
  const ready = item.entries.filter((e) => e.state === 'done' && e.text).length
  const committee = item.mode === 'committee'
  // Automatic cross-review at the end of a turn with changes; with a severe verdict the advice goes to the coordinator on its own.
  const review = item.mode === 'review'
  const names = item.entries.map((e) => nameOf(e.agent))
  const title = review ? t('Cross-review by {agent}', { agent: names[0] ?? '' }) : committee ? plural(item.entries.length, 'Committee of {n} agent', 'Committee of {n} agents') : t('Advice from {agent}', { agent: names[0] ?? '' })

  const run = async (kind: 'stop' | 'forward') => {
    if (!sessionId || pending) return
    setPending(kind)
    setError(null)
    try {
      if (kind === 'stop') await request({ type: 'session.advice.stop', sessionId, itemId: item.id })
      else {
        await request({ type: 'session.advice.forward', sessionId, itemId: item.id, note: note.trim() || null })
        setNoting(false)
        setNote('')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  return (
    <div data-item-id={item.id} className="grid min-w-0 gap-1.5">
      <div className="flex min-h-[22px] min-w-0 items-center gap-2 text-sm leading-[1.5] text-muted-foreground">
        <span className="flex size-[14px] shrink-0 items-center justify-center">
          {running > 0 ? <Spinner label={t('Running')} /> : <MessagesSquare aria-hidden className="size-[14px]" strokeWidth={1.9} />}
        </span>
        <p className="min-w-0 break-words">
          {title}
          {committee ? <span className="text-faint"> · {names.join(', ')}</span> : null}
        </p>
        {review && item.verdict ? <VerdictBadge verdict={item.verdict} /> : null}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border dark:bg-input/60" />
      </div>
      <p className="min-w-0 pl-[22px] text-sm leading-[1.5] break-words whitespace-pre-wrap text-foreground">
        {item.question ? <>{item.question}</> : <span className="text-muted-foreground">{review ? t('Changes from the last turn') : t('General review of the current work')}</span>}
      </p>
      <div className={cn('grid min-w-0 gap-2 pl-[22px]', committee ? 'chat-wide grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))]' : 'grid-cols-1')}>
        {item.entries.map((entry, i) => (
          <AdviceEntry key={`${entry.agent}:${i}`} item={item} entry={entry} index={i} />
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-[22px]">
        {running > 0 ? (
          <Button type="button" size="sm" variant="secondary" disabled={pending !== null} aria-busy={pending === 'stop'} onClick={() => void run('stop')} className="h-7 text-sm font-medium">
            <CircleStop aria-hidden />
            {t('Stop')}
          </Button>
        ) : null}
        {ready > 0 && !item.forwarded ? (
          <Button type="button" size="sm" variant="secondary" aria-expanded={noting} aria-controls={noteId} onClick={() => setNoting((v) => !v)} className="h-7 text-sm font-medium">
            <Send aria-hidden />
            {t('Send to {agent}', { agent: ownName })}
          </Button>
        ) : null}
        {item.forwarded ? (
          <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check aria-hidden className="size-3.5 text-success" strokeWidth={2.2} />
            {review && item.verdict === 'serious' ? t('Sent to {agent} automatically', { agent: ownName }) : t('Sent to {agent}', { agent: ownName })}
          </span>
        ) : null}
      </div>
      {noting && !item.forwarded ? (
        <form
          id={noteId}
          className="grid min-w-0 gap-1.5 pl-[22px]"
          onSubmit={(e) => {
            e.preventDefault()
            void run('forward')
          }}
        >
          <label htmlFor={`${noteId}-note`} className="text-xs font-semibold text-muted-foreground">
            {t('Add a note for {agent} (optional)', { agent: ownName })}
          </label>
          <textarea
            id={`${noteId}-note`}
            autoFocus
            rows={2}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setNoting(false)
              }
            }}
            placeholder={t('e.g. Follow the first suggestion')}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending !== null} aria-busy={pending === 'forward'} className="h-7 text-sm font-medium">
              {t('Send')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNoting(false)} className="h-7 text-sm font-medium">
              {t('Cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="pl-[22px] text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
})
