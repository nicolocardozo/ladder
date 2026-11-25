// Chat system cards: interrupted delegation to resume and plan limit reached or reset.
import { ArrowRightLeft, Check, CircleStop, CircleX, Gauge, Handshake, RotateCcw } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { AgentId, Project } from '@shared/protocol'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { usePeerSession } from '@/components/handoff-bits'
import { useProjectSettings } from '@/components/main-views'
import { resetsWhen } from '@/components/composer/usage-button'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { handoffTargets } from '@/lib/handoff'
import { useApp } from '@/store/app-store'
import { ActionError, cardButton, Head, linkClass, useAgentNames, useHostAction } from './card-bits'
import { useChatActions } from './chat-context'
import type { LimitChatItem, ResumeChatItem } from './turns'

// ── Interrupted delegation ───────────────────────────────────────────────────────

export const ResumeCard = memo(function ResumeCard({ item }: { item: ResumeChatItem }) {
  const { sessionId } = useChatActions()
  const { name } = useAgentLine(item.agent, null)
  const { open } = usePeerSession(item.childSessionId)
  const { busy, error, run } = useHostAction()
  const openLink = open ? (
    <button type="button" onClick={open} aria-label={t('Open the session of {agent}', { agent: name })} className={linkClass}>
      {t('Open child session')}
    </button>
  ) : null
  const act = (action: 'resume' | 'dismiss') => {
    if (sessionId) void run(action, { type: 'session.delegation.resume', sessionId, itemId: item.id, action })
  }

  if (item.state === 'dismissed') {
    return (
      <div data-item-id={item.id}>
        <Head icon={<Handshake aria-hidden className="size-[14px]" strokeWidth={1.9} />}>{t('Delegation to {agent} dismissed', { agent: name })}</Head>
      </div>
    )
  }
  if (item.state === 'resumed') {
    return (
      <div data-item-id={item.id}>
        <Head icon={<RotateCcw aria-hidden className="size-[14px]" strokeWidth={1.9} />} action={openLink}>
          {t('Delegation to {agent} resumed', { agent: name })}
        </Head>
      </div>
    )
  }
  if (item.state === 'done') {
    return (
      <div data-item-id={item.id}>
        <Head icon={<Check aria-hidden className="size-[14px] text-success" strokeWidth={2.2} />} action={openLink}>
          {t('Delegation to {agent} finished', { agent: name })}
        </Head>
      </div>
    )
  }

  // 'open' and 'error' (retry possible): explanation, actions and optional error.
  const failed = item.state === 'error'
  return (
    <div data-item-id={item.id} role="group" aria-label={t('Interrupted delegation to {agent}', { agent: name })} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <Head icon={failed ? <CircleX aria-hidden className="size-[14px] text-destructive" strokeWidth={2} /> : <CircleStop aria-hidden className="size-[14px]" strokeWidth={1.9} />}>
        {failed ? (
          <span className="text-destructive">
            <span className="font-semibold">{t('Could not resume the delegation to {agent}', { agent: name })}</span>
          </span>
        ) : (
          <>
            {t('Delegation to {agent} interrupted', { agent: name })}
            {item.reason ? <> · {item.reason}</> : null}
          </>
        )}
      </Head>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pl-[22px]">
        <p className="min-w-0 text-sm leading-[1.5] break-words text-muted-foreground">
          {t('Resume it to restart the work of {agent} and get its result here.', { agent: name })}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy !== null || !sessionId} aria-busy={busy === 'resume'} onClick={() => act('resume')} className={cardButton}>
            {t('Resume delegation')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null || !sessionId} aria-busy={busy === 'dismiss'} onClick={() => act('dismiss')} className={cardButton}>
            {t('Dismiss')}
          </Button>
          {openLink}
        </div>
        <ActionError error={error ?? (failed ? item.error : null)} />
      </div>
    </div>
  )
})

// ── Plan limit ────────────────────────────────────────────────────────

/** "5-hour limit" → "5-hour limit" (translated, lowercase to fit in the sentence). */
const windowName = (window: string) => t(window).toLowerCase()

/** Choice of another agent in place of the proposed one: opens from the "Choose another agent…" button. */
function PickAgent({ item, sessionId, onClose }: { item: LimitChatItem; sessionId: string; onClose: () => void }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId) ?? null) as Project | null
  const agents = useApp((s) => s.agents)
  const settings = useProjectSettings(project)
  const targets = handoffTargets(agents, item.agent, settings?.agents?.allowed ?? [])
  const [picked, setPicked] = useState<AgentId | null>(null)
  const agent = picked && targets.some((a) => a.agent === picked) ? picked : (targets.find((a) => a.agent === item.target) ?? targets[0])?.agent ?? null
  const names = useAgentNames()
  const { busy, error, run } = useHostAction()
  const id = useId()
  return (
    <form
      aria-label={t('Choose another agent')}
      className="grid min-w-0 gap-2 rounded-[10px] border border-border px-3 py-2.5 dark:border-input/70"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (agent) void run('pick', { type: 'session.limit.respond', sessionId, itemId: item.id, action: 'switch', agent })
      }}
    >
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('No other agent is available here. Check Settings or the project’s allowed agents.')}</p>
      ) : (
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
            {t('Agent')}
          </label>
          <Select value={agent ?? ''} onValueChange={(value) => setPicked(String(value) as AgentId)}>
            <SelectTrigger id={id} aria-label={t('Agent')} autoFocus className="w-full max-w-[260px]">
              {agent && <AgentMark agent={agent} size={14} />}
              <SelectValue>{(value: string) => names(value as AgentId)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {targets.map((a) => (
                <SelectItem key={a.agent} value={a.agent}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <ActionError error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy !== null || !agent} aria-busy={busy === 'pick'} className={cardButton}>
          {agent ? t('Continue with {agent}', { agent: names(agent) }) : t('Continue')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} className={cardButton}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  )
}

export const LimitCard = memo(function LimitCard({ item }: { item: LimitChatItem }) {
  const { sessionId } = useChatActions()
  const names = useAgentNames()
  const { name } = useAgentLine(item.agent, null)
  const { session: peer, open } = usePeerSession(item.peerSessionId)
  const { busy, error, run } = useHostAction()
  const [picking, setPicking] = useState(false)
  // On closing the choice focus returns to the button that opened it (unmounted meanwhile).
  const pickRef = useRef<HTMLButtonElement>(null)
  const [restore, setRestore] = useState(false)
  useEffect(() => {
    if (restore && !picking) {
      pickRef.current?.focus()
      setRestore(false)
    }
  }, [restore, picking])
  const target = item.target ? names(item.target) : null
  const arrived = peer ? names(peer.agent) : target
  const openLink = open ? (
    <button type="button" onClick={open} className={linkClass}>
      {t('Open session')}
    </button>
  ) : null
  const respond = (action: 'switch' | 'return' | 'dismiss') => {
    if (sessionId) void run(action, { type: 'session.limit.respond', sessionId, itemId: item.id, action })
  }
  const resets = item.resetsAt !== null ? resetsWhen(item.resetsAt, Date.now() / 1000) : null

  if (item.state === 'dismissed') return null

  if (item.phase === 'reset') {
    if (item.state === 'returned') {
      return (
        <div data-item-id={item.id}>
          <Head icon={<ArrowRightLeft aria-hidden className="size-[14px]" strokeWidth={1.9} />} action={openLink}>
            {t('Went back to {agent}', { agent: name })}
          </Head>
        </div>
      )
    }
    return (
      <div data-item-id={item.id} role="group" aria-label={t('{agent} is available again', { agent: name })} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
        <Head icon={<Gauge aria-hidden className="size-[14px]" strokeWidth={1.9} />}>
          {t('{agent} is available again', { agent: name })}
        </Head>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pl-[22px]">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy !== null || !sessionId} aria-busy={busy === 'return'} onClick={() => respond('return')} className={cardButton}>
              <AgentMark agent={item.agent} size={14} />
              {t('Go back to {agent}', { agent: name })}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null || !sessionId} onClick={() => respond('dismiss')} className={cardButton}>
              {t('Dismiss')}
            </Button>
          </div>
          <ActionError error={error ?? item.error} />
        </div>
      </div>
    )
  }

  const reached = (
    <>
      {t('{agent} reached its {window}', { agent: name, window: windowName(item.window) })}
      {resets ? <span className="text-faint"> · {t('resets at {when}', { when: resets })}</span> : null}
    </>
  )

  if (item.state === 'switched' || item.state === 'returned') {
    return (
      <div data-item-id={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
        <Head icon={<ArrowRightLeft aria-hidden className="size-[14px]" strokeWidth={1.9} />} action={openLink}>
          {arrived
            ? item.automatic
              ? t('Switched to {agent} automatically', { agent: arrived })
              : t('Switched to {agent}', { agent: arrived })
            : t('Switched to another agent')}
        </Head>
        <p className="min-w-0 pl-[22px] text-xs leading-[1.5] break-words text-muted-foreground">{reached}</p>
      </div>
    )
  }

  // 'proposed' and 'error' (retry possible).
  const failed = item.state === 'error'
  return (
    <div data-item-id={item.id} role="group" aria-label={t('{agent} reached its {window}', { agent: name, window: windowName(item.window) })} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <Head icon={<Gauge aria-hidden className="size-[14px] text-attention" strokeWidth={1.9} />}>{reached}</Head>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pl-[22px]">
        {picking && sessionId ? (
          <PickAgent item={item} sessionId={sessionId} onClose={() => {
            setPicking(false)
            setRestore(true)
          }} />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {item.target ? (
              <Button type="button" size="sm" disabled={busy !== null || !sessionId} aria-busy={busy === 'switch'} onClick={() => respond('switch')} className={cardButton}>
                <AgentMark agent={item.target} size={14} />
                {t('Continue with {agent}', { agent: target ?? '' })}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t('No other agent is available right now.')}</p>
            )}
            <Button ref={pickRef} type="button" size="sm" variant="secondary" disabled={busy !== null || !sessionId} onClick={() => setPicking(true)} className={cardButton}>
              {item.target ? t('Choose another agent…') : t('Choose an agent…')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null || !sessionId} onClick={() => respond('dismiss')} className={cardButton}>
              {t('Dismiss')}
            </Button>
          </div>
        )}
        <ActionError error={error ?? (failed ? item.error : null)} />
        {!failed && !error && item.error ? <p className="min-w-0 text-xs break-words text-muted-foreground">{item.error}</p> : null}
      </div>
    </div>
  )
})
