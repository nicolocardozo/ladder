// "In attesa": richieste bloccanti di tutti i progetti, con le azioni, poi errori e risposte da leggere.
// Si apre dalla sidebar sopra la sessione che hai davanti: approvi e resti dove sei, con la bozza intatta.
import { ArrowUpRight, Check, CircleX, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { RequestResponse, SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { ChatContext, createToggleStore, useNow, type ChatActions } from '@/components/chat/chat-context'
import { formatSince } from '@/components/chat/format'
import { RequestCard } from '@/components/chat/request-card'
import { SessionGlyph } from '@/components/status'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { request } from '@/lib/host-client'
import { sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { isLiveSession, useApp } from '@/store/app-store'
import { Kbd } from '@/components/ui/kbd'

export interface InboxGroups {
  waiting: SessionSummary[]
  errors: SessionSummary[]
  unread: SessionSummary[]
}

/** Prima le richieste bloccanti per anzianità, poi gli errori, poi le risposte da leggere (le più recenti prima). */
export function useInboxGroups(): InboxGroups {
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  return useMemo(() => {
    const live = Object.values(sessions).filter((s) => isLiveSession({ projects }, s))
    return {
      waiting: live.filter((s) => s.run === 'waiting').sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0)),
      errors: live.filter((s) => s.run === 'error' && s.unread).sort((a, b) => b.activityAt - a.activityAt),
      unread: live.filter((s) => sessionState(s) === 'unread').sort((a, b) => b.activityAt - a.activityAt)
    }
  }, [sessions, projects])
}

const linkButton =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'

export function InboxPanel() {
  const { waiting, errors, unread } = useInboxGroups()
  const projects = useApp((s) => s.projects)
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const root = useRef<HTMLDivElement>(null)
  const total = waiting.length + errors.length + unread.length

  // Risposta data: la card sparisce e il focus passa alla prossima richiesta, così continui da tastiera.
  // Dopo l'ultima richiesta: il pannello si chiude e il focus torna dov'eri (il composer, con il cursore al suo posto).
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
          <Kbd>⌘⇧A</Kbd>
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
  const open = () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null)
  return (
    <div className="flex min-w-0 items-center gap-2 px-1.5">
      <span className="grid w-3 shrink-0 place-items-center">
        <SessionGlyph state={sessionState(session)} />
      </span>
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline" title={`${projectName} · ${session.title} · ${name}${model ? ` ${model}` : ''}`}>
        <span className="shrink-0 text-xs text-muted-foreground">{projectName}</span>
        <span className="truncate text-sm font-medium">{session.title}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <AgentMark agent={session.agent} size={12} />
          {model ?? name}
        </span>
      </button>
      <span className="shrink-0 text-xs text-faint tabular-nums">{formatSince(at, now)}</span>
      {trailing}
      <button type="button" onClick={open} className={linkButton} aria-label={t('Open {title}', { title: session.title })}>
        {t('Open')}
        <ArrowUpRight aria-hidden className="size-3" />
      </button>
    </div>
  )
}

/** Richiesta aperta: la stessa card della chat, con le stesse scorciatoie, inviata con via "inbox". */
function WaitingEntry({ session, projectName, first }: { session: SessionSummary; projectName: string; first: boolean }) {
  const actions = useMemo<ChatActions>(
    () => ({
      respond: (requestId: string, response: RequestResponse) => {
        request({ type: 'session.respond', sessionId: session.id, requestId, response, via: 'inbox' }).catch(() => undefined)
      },
      // Solo la prima card prende il focus quando si apre il pannello.
      canTakeFocus: () => first,
      openFile: () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null),
      openDiff: () => useApp.getState().openSessionAt(session.id, null),
      openSession: () => useApp.getState().openSessionAt(session.id, session.request?.id ?? null),
      toggles: createToggleStore(),
      surface: 'inbox'
    }),
    // La card si ricrea quando cambia la richiesta, non a ogni aggiornamento della sessione.
    [session.id, session.request?.id, first]
  )
  const terminal = session.mode === 'terminal'
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
            onClick={() => useApp.getState().openSessionAt(session.id, null)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-foreground bg-foreground px-[11px] text-sm font-[560] text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {terminal ? t('Go to terminal') : t('Open')}
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

