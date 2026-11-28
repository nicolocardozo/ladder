// Sessions started outside the interface (from the `ladder` CLI or by an agent with the MCP tools): where they come from shows
// in the sidebar (mark), at the top of the chat (row with the link to the parent) and in the row of the tool that started them.
import { ArrowUpLeft, ArrowUpRight, Bot, SquareTerminal } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { planButton } from '@/components/chat/plan-bits'
import { useAgentLine } from '@/components/agent-mark'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Full origin text: "Started from the terminal" or "Started by Claude Code in “title”". */
export function useOriginText(session: Pick<SessionSummary, 'origin'>): string | null {
  const origin = session.origin ?? null
  const agent = useAgentLine(origin?.kind === 'agent' ? origin.agent : 'claude-code', null).name
  const parentTitle = useApp((s) => (origin?.kind === 'agent' ? (s.sessions[origin.sessionId]?.title ?? null) : null))
  if (!origin) return null
  if (origin.kind === 'cli') return t('Started from the terminal')
  return parentTitle ? t('Started by {agent} in “{title}”', { agent, title: parentTitle }) : t('Started by {agent}', { agent })
}

/** Mark in the sidebar row: icon and short label, the full text is in the tooltip. */
export function OriginMark({ session, className }: { session: SessionSummary; className?: string }) {
  const text = useOriginText(session)
  const origin = session.origin
  if (!origin || !text) return null
  const Icon = origin.kind === 'cli' ? SquareTerminal : Bot
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)} title={text}>
      <Icon aria-hidden className="size-3 shrink-0" strokeWidth={1.9} />
      <span className="min-w-0 truncate">{origin.kind === 'cli' ? t('From terminal') : t('By agent')}</span>
      <span className="sr-only">{text}</span>
    </span>
  )
}

/** Thin row at the top of the chat: who started the session, with the link to the parent session. */
export function OriginBanner({ session, compact }: { session: SessionSummary; compact?: boolean }) {
  const text = useOriginText(session)
  const origin = session.origin
  const parent = useApp((s) => (origin?.kind === 'agent' ? (s.sessions[origin.sessionId] ?? null) : null))
  if (!origin || !text) return null
  const Icon = origin.kind === 'cli' ? SquareTerminal : Bot
  return (
    <div className="chat-col chat-gutter pb-1" data-compact={compact ? '' : undefined}>
      <div className="chat-measure chat-bleed">
        <div className="chat-reset">
          <div role="group" aria-label={t('Where this session started')} className="flex min-h-8 min-w-0 items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
            <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.9} />
            <span title={text} className="line-clamp-2 min-w-0 flex-1 break-words">{text}</span>
            {parent && !parent.archived && (
              <button type="button" onClick={() => useApp.getState().openSessionAt(parent.id, null)} className={cn(planButton.ghost, 'h-6 shrink-0 px-2 text-xs')}>
                <ArrowUpLeft aria-hidden className="size-3" strokeWidth={2} />
                {t('Open parent session')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Name of the Ladder MCP tool that starts or waits for a session (with or without the server prefix). */
const SESSION_TOOL = /(?:^|[_.:/-])ladder_(?:start_session|wait|send|send_message|session)$/

/** The sessionId in the tool result: JSON or text with `"sessionId": "…"`. */
function sessionIdOf(output: string | null): string | null {
  if (!output) return null
  try {
    const value = JSON.parse(output) as { sessionId?: unknown }
    if (typeof value?.sessionId === 'string') return value.sessionId
  } catch {
    // Not JSON: search the text.
  }
  return /"?sessionId"?\s*[:=]\s*"?([\w-]+)"?/.exec(output)?.[1] ?? null
}

/** Below the `ladder_start_session` and `ladder_wait` row: the child session, with a link to open it. Nothing if the result has no known one. */
export function ChildSessionLink({ name, output }: { name: string; output: string | null }) {
  const id = SESSION_TOOL.test(name) ? sessionIdOf(output) : null
  const child = useApp((s) => (id ? (s.sessions[id] ?? null) : null))
  if (!child || child.archived) return null
  return (
    <div className="pl-[21px]">
      <button
        type="button"
        onClick={() => useApp.getState().openSessionAt(child.id, null)}
        aria-label={t('Open the session “{title}”', { title: child.title })}
        className="inline-flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-[5px] text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ArrowUpRight aria-hidden className="size-3 shrink-0" strokeWidth={2} />
        <span className="min-w-0 truncate">{child.title}</span>
        <span className="shrink-0 text-xs text-primary">{t('Open session')}</span>
      </button>
    </div>
  )
}
