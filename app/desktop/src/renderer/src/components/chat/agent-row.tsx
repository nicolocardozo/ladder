// Riga di chat di un sotto-agente: una sola riga "titolo · tipo · modello · 5m 34s ✓", senza prompt e report.
// Il clic apre il dialogo di dettaglio; la riga funziona anche per i turni vecchi, senza SubagentInfo.
import { Bot } from 'lucide-react'
import { memo } from 'react'
import { t } from '@shared/i18n'
import { StatusMark, useAgentModel } from '@/components/subagent-bits'
import { agentElapsed, findAgentForTool, useSubagentDialog, useSubagentLists } from '@/lib/subagents'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { Spinner } from './bits'
import { useChatActions, useNow } from './chat-context'
import { formatDuration } from './format'
import type { ToolItem } from './turns'

const FROM_TOOL = { running: 'running', done: 'done', error: 'error', denied: 'stopped' } as const

export const AgentToolRow = memo(function AgentToolRow({ item }: { item: ToolItem }) {
  const { sessionId } = useChatActions()
  // Il selettore restituisce solo l'agente di questa riga: gli altri aggiornamenti dell'elenco non la ridisegnano.
  const info = useSubagentLists((s) => (sessionId ? findAgentForTool(s.lists[sessionId], item.id) : null))
  const sessionAgent = useApp((s) => (sessionId ? s.sessions[sessionId]?.agent : undefined))
  const sessionModel = useApp((s) => (sessionId ? (s.sessions[sessionId]?.model ?? null) : null))
  const open = useSubagentDialog((s) => s.open)
  const modelOf = useAgentModel(sessionAgent ?? 'claude-code', sessionModel)

  const status = info?.status ?? FROM_TOOL[item.status]
  const running = status === 'running'
  const now = useNow(1000, running)
  const elapsed = info ? agentElapsed(info, now) : (item.endedAt ?? (running ? now : item.at)) - item.at
  const title = info?.title ?? item.title
  // Senza SubagentInfo (turni vecchi, dopo un riavvio) il modello è quello salvato sulla riga.
  const model = modelOf(info ?? item.agent ?? { model: null })
  const meta = [info?.kind, model].filter(Boolean).join(' · ')

  const body = (
    <>
      <Bot aria-hidden className="size-[13px] shrink-0" strokeWidth={1.8} />
      <span className={cn('min-w-0 truncate', running && 'text-foreground/90')} title={title}>
        {title}
        {meta && <span className="text-faint"> · {meta}</span>}
      </span>
      <span className="flex-1" />
      <span className="shrink-0 font-mono text-xs text-faint tabular-nums">{formatDuration(elapsed)}</span>
      {running ? <Spinner label={t('Running')} /> : <StatusMark status={status} className="shrink-0" />}
    </>
  )
  const base = 'flex h-[22px] w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-sm text-muted-foreground'
  return (
    <div data-item-id={item.id} className="min-w-0">
      {sessionId ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={t('Subagent: {title}. Open details', { title })}
          onClick={() => open(sessionId, info?.id ?? item.id, { title: item.title, status, startedAt: item.at, endedAt: item.endedAt, agent: item.agent })}
          className={cn(base, 'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50')}
        >
          {body}
        </button>
      ) : (
        <div className={base}>{body}</div>
      )}
    </div>
  )
})
