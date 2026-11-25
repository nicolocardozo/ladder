// "Waiting": blocking requests from all projects, with actions, then errors and replies to read.
// It opens from the sidebar over the session in front of you: you approve and stay where you are, with the draft intact.
import { shortcutLabel } from '@shared/shortcuts'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { ArrowUpRight, Check, CircleX, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { RequestResponse, SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { ChatContext, createToggleStore, useNow, type ChatActions } from '@/components/chat/chat-context'
import { formatSince } from '@/components/chat/format'
import { RequestCard } from '@/components/chat/request-card'
import { SessionGlyph } from '@/components/status'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { useSessionProfileName } from '@/lib/profiles'
import { request } from '@/lib/host-client'
import { isUnreadState, needsYou, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { isLiveSession, useApp } from '@/store/app-store'
import { Kbd } from '@/components/ui/kbd'

export interface InboxGroups {
  waiting: SessionSummary[]
  errors: SessionSummary[]
  unread: SessionSummary[]
}

/** First blocking requests by age, then errors, then replies to read (most recent first). */
export function useInboxGroups(): InboxGroups {
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  return useMemo(() => {
    const live = Object.values(sessions).filter((s) => isLiveSession({ projects }, s) && !s.parent)
    return {
      waiting: live.filter(needsYou).sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0)),
      errors: live.filter((s) => s.run === 'error' && s.unread).sort((a, b) => b.activityAt - a.activityAt),
      unread: live.filter((s) => isUnreadState(sessionState(s))).sort((a, b) => b.activityAt - a.activityAt)
    }
  }, [sessions, projects])
}

const linkButton =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'

export function InboxPanel() {
  useShortcutsRevision()
  const { waiting, errors, unread } = useInboxGroups()
  const projects = useApp((s) => s.projects)
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const root = useRef<HTMLDivElement>(null)
  const total = waiting.length + errors.length + unread.length

  // Answer given: the card disappears and focus moves to the next request, so you carry on from the keyboard.
  // After the last request: the panel closes and focus returns to where you were (the composer, with the cursor in place).
  const previous = useRef(waiting.length)
  useEffect(() => {
    const answered = waiting.length < previous.current
    previous.current = waiting.length
    if (!answered) return
    if (waiting.length === 0) {
      useApp.getState().setInboxOpen(false)
      return
    }
    if (!root.current?.contains(document.activeElement)) {
      root.current?.querySelector<HTMLElement>('[data-primary]:not(:disabled)')?.focus({ preventScroll: true })
    }
  }, [waiting.length])

  return (
    <div ref={root} className="flex max-h-[min(78vh,760px)] min-h-0 flex-col">
      <div className="flex items-baseline gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-sm font-semibold">{t('Waiting')}</span>
        <span className="text-xs text-muted-foreground">
          {total === 0
            ? t('nothing to do')
            : [
                waiting.length && t('{n} waiting for you', { n: waiting.length }),
                errors.length && t('{n} with errors', { n: errors.length }),
                unread.length && t('{n} unread', { n: unread.length })
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Kbd>{shortcutLabel('session.nextWaiting')}</Kbd>
          {t('next')}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('No sessions are waiting for you. Agent requests from all projects show up here.')}</p>
        )}
        {waiting.length > 0 && (
          <Section label={t('Need you')} count={waiting.length}>
            {waiting.map((session, index) => (
              <WaitingEntry key={session.id} session={session} projectName={names.get(session.projectId) ?? ''} first={index === 0} />
            ))}
          </Section>
        )}
        {errors.length > 0 && (
          <Section label={t('Errors')} count={errors.length}>
            {errors.map((session) => (
              <SimpleEntry key={session.id} session={session} projectName={names.get(session.projectId) ?? ''} />
            ))}
          </Section>
        )}
        {unread.length > 0 && (
          <Section label={t('Unread')} count={unread.length}>
            {unread.slice(0, 30).map((session) => (
              <SimpleEntry key={session.id} session={session} projectName={names.get(session.projectId) ?? ''} />
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 px-2 pt-2.5 pb-1.5" aria-label={label}>
      <h3 className="px-1.5 text-xs font-semibold text-muted-foreground">
        {label} · {count}
      </h3>
      {children}
    </section>
  )
}

function EntryHeader({ session, projectName, at, trailing }: { session: SessionSummary; projectName: string; at: number; trailing?: ReactNode }) {
  const now = useNow(30_000)
  const { name, model } = useAgentLine(session.agent, session.model)
  const profile = useSessionProfileName(session)
  const open = () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null)
  // The whole row opens the session: the title button stretches over the entire row (after:inset-0); the actions on the right sit on top.
  return (
    <div className="group/entry relative flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60 has-[[data-entry-open]:focus-visible]:ring-2 has-[[data-entry-open]:focus-visible]:ring-ring/50">
      <span className="grid w-3 shrink-0 place-items-center">
        <SessionGlyph state={sessionState(session)} />
      </span>
      <button
        type="button"
        data-entry-open
        onClick={open}
        aria-label={t('Open {title}', { title: `${projectName} · ${session.title}` })}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none after:absolute after:inset-0 after:rounded-md"
      >
        <span className="shrink-0 text-xs text-muted-foreground">{projectName}</span>
        <span className="truncate text-sm font-medium">{session.title}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <AgentMark agent={session.agent} size={12} />
          {model ?? name}
          {profile && <span className="max-w-24 truncate text-faint">· {profile}</span>}
        </span>
      </button>
      <span className="shrink-0 text-xs text-faint tabular-nums">{formatSince(at, now)}</span>
      {trailing && <span className="relative z-10 flex shrink-0 items-center">{trailing}</span>}
      <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/entry:opacity-100 motion-reduce:transition-none" />
    </div>
  )
}

/** Open request: the same card as in the chat, with the same shortcuts, sent with via "inbox". */
function WaitingEntry({ session, projectName, first }: { session: SessionSummary; projectName: string; first: boolean }) {
  const actions = useMemo<ChatActions>(
    () => ({
      respond: (requestId: string, response: RequestResponse) => {
        request({ type: 'session.respond', sessionId: session.id, requestId, response, via: 'inbox' }).catch(() => undefined)
      },
      // Only the first card takes focus when the panel opens.
      canTakeFocus: () => first,
      openFile: () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null),
      openDiff: () => useApp.getState().openSessionAt(session.id, null),
      openSession: () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null),
      toggles: createToggleStore(),
      surface: 'inbox'
    }),
    // The card is recreated when the request changes, not on every session update.
    [session.id, session.request?.id, first]
  )
  const terminal = session.mode === 'terminal'
  // A plan waiting for your review: the button jumps to its card in the chat.
  const planCardId = useApp((s) => (session.planWaiting ? ([...(s.items[session.id] ?? [])].reverse().find((i) => i.kind === 'plan')?.id ?? null) : null))
  return (
    <div className="flex flex-col gap-1.5 rounded-lg px-0.5 pt-1.5 pb-2">
      <EntryHeader session={session} projectName={projectName} at={session.waitingSince ?? session.updatedAt} />
      {session.request ? (
        <ChatContext.Provider value={actions}>
          <div className="pl-6">
            <RequestCard key={session.request.id} item={session.request} />
            {session.openRequests > 1 && <p className="mt-1 text-xs text-muted-foreground">{plural(session.openRequests - 1, '+{n} more request in this session', '+{n} more requests in this session')}</p>}
          </div>
        </ChatContext.Provider>
      ) : (
        <div className="ml-6 flex flex-wrap items-center gap-2 rounded-[10px] border border-input bg-card px-3 py-2.5 text-sm">
          {terminal && <SquareTerminal aria-hidden className="size-3.5 text-muted-foreground" />}
          <span className="min-w-0 flex-1 text-secondary-foreground">
            {terminal
              ? t('{command} in the terminal: {label}', { command: session.command ?? 'claude', label: session.waitingLabel ?? t('request') })
              : (session.waitingLabel ?? t('Needs you'))}
            {session.estimated ? ` · ${t('estimated status')}` : ''}
          </span>
          <button
            type="button"
            data-primary
            onClick={() => useApp.getState().openSessionAt(session.id, planCardId)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-foreground bg-foreground px-[11px] text-sm font-[560] text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {terminal ? t('Go to terminal') : session.planWaiting ? t('Open the plan') : t('Open')}
          </button>
        </div>
      )}
    </div>
  )
}

function SimpleEntry({ session, projectName }: { session: SessionSummary; projectName: string }) {
  const error = session.run === 'error'
  return (
    <div className={cn('flex flex-col gap-0.5 rounded-lg py-1.5', error && 'pb-2')}>
      <EntryHeader
        session={session}
        projectName={projectName}
        at={session.activityAt}
        trailing={
          !error ? (
            <button type="button" onClick={() => useApp.getState().markRead(session.id)} className={linkButton} aria-label={t('Mark {title} as read', { title: session.title })} title={t('Mark as read')}>
              <Check aria-hidden className="size-3" />
            </button>
          ) : null
        }
      />
      {error && (
        <p className="ml-6 flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-destructive">
          <CircleX aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{session.activity ?? t('The turn stopped because of an error.')}</span>
        </p>
      )}
    </div>
  )
}

