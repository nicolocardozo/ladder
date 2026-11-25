// Agent handoff separator: outgoing in the source session, incoming in the target one.
import { ArrowRightLeft, Check, CircleAlert, CircleStop, CircleX, Clock, Gauge } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { plural, t } from '@shared/i18n'
import type { AgentResult } from '@shared/protocol'
import { useAgentLine } from '@/components/agent-mark'
import { usePeerSession } from '@/components/handoff-bits'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { Spinner } from './bits'
import { ActionError, cardButton, Disclosure, Head, linkClass, ReassignForm, StopButton, useHostAction } from './card-bits'
import { ChangedFileList } from './changed-files'
import { useChatActions, useToggle } from './chat-context'
import { Markdown } from './markdown'
import type { HandoffChatItem } from './turns'

/** Outcome of report_result: status with shape and label (never color alone), expandable markdown summary and files. */
function ResultBlock({ id, agent, result }: { id: string; agent: string; result: AgentResult }) {
  const [summaryOpen, toggleSummary] = useToggle(`ho:res:${id}`)
  const summaryId = `ho-res-${id}`
  const state = {
    done: { icon: <Check aria-hidden className="size-3 text-success" strokeWidth={2.4} />, label: t('Done'), tone: 'text-muted-foreground' },
    blocked: { icon: <CircleAlert aria-hidden className="size-3 text-attention" strokeWidth={2.2} />, label: t('Blocked'), tone: 'font-medium text-attention' },
    failed: { icon: <CircleX aria-hidden className="size-3" strokeWidth={2.2} />, label: t('Failed'), tone: 'font-medium text-destructive' }
  }[result.status]
  const files = result.files ?? []
  return (
    <section aria-label={t('Result from {agent}', { agent })} className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-border px-3 py-2 dark:border-input/70">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="min-w-[7rem] flex-1 text-sm font-medium break-words text-foreground">{t('Result from {agent}', { agent })}</h4>
        <span className={cn('flex shrink-0 items-center gap-1 text-xs', state.tone)}>
          {state.icon}
          {state.label}
        </span>
      </header>
      {result.summary.trim() ? (
        <>
          <Disclosure id={summaryId} open={summaryOpen} onToggle={toggleSummary}>
            {t('Summary')}
          </Disclosure>
          {summaryOpen ? (
            <div id={summaryId} className="min-w-0 overflow-x-auto">
              <Markdown text={result.summary} compact />
            </div>
          ) : null}
        </>
      ) : null}
      {files.length > 0 ? (
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{plural(files.length, '{n} file', '{n} files')}</p>
          <ul className="mt-0.5 min-w-0 list-none p-0">
            {files.map((file) => (
              <li key={file} className="truncate font-mono text-xs leading-[1.6] text-foreground/85" title={file}>
                {file}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

export const HandoffLine = memo(function HandoffLine({ item }: { item: HandoffChatItem }) {
  const { sessionId, openFile } = useChatActions()
  const own = useApp((s) => (sessionId ? s.sessions[sessionId]?.agent : undefined))
  const { name: peerName } = useAgentLine(item.agent, null)
  const { name: ownName } = useAgentLine(own ?? 'claude-code', null)
  const { open } = usePeerSession(item.peerSessionId)
  const [summaryOpen, toggleSummary] = useToggle(`ho:sum:${item.id}`)
  const [filesOpen, toggleFiles] = useToggle(`ho:files:${item.id}`)
  const [reassigning, setReassigning] = useState(false)
  // On closing the form focus returns to "Reassign…", which was unmounted meanwhile.
  const reassignRef = useRef<HTMLButtonElement>(null)
  const [restore, setRestore] = useState(false)
  useEffect(() => {
    if (restore && !reassigning) {
      reassignRef.current?.focus()
      setRestore(false)
    }
  }, [restore, reassigning])
  const { busy, error: actionError, run } = useHostAction()

  // "Implement with…" carries a plan in place of the summary.
  const implement = item.reason === 'implement'
  // Requested by the agent with the handoff tool, summary written by it.
  const byAgent = item.reason === 'agent'
  // Plan limit reached, summary composed by Ladder.
  const limit = item.reason === 'limit'
  const summaryId = `ho-sum-${item.id}`
  const filesId = `ho-files-${item.id}`
  const summaryLabel = implement ? t('Plan') : t('Summary')
  const agentNote = byAgent && item.note ? (
    <p className="min-w-0 text-sm leading-[1.5] break-words whitespace-pre-wrap text-foreground">
      <span className="text-muted-foreground">{t('Note')} · </span>
      {item.note}
    </p>
  ) : null
  const summaryBlock = item.summary ? (
    <>
      <Disclosure id={summaryId} open={summaryOpen} onToggle={toggleSummary}>
        {summaryLabel}
      </Disclosure>
      {summaryOpen ? (
        <div id={summaryId} className="min-w-0 overflow-x-auto rounded-[10px] border border-border px-3 py-2 dark:border-input/70">
          <Markdown text={item.summary} compact />
        </div>
      ) : null}
    </>
  ) : null

  const openLink = open ? (
    <button type="button" onClick={open} className={linkClass}>
      {t('Open session')}
    </button>
  ) : null

  if (item.direction === 'out') {
    if (item.state === 'summarizing' || item.state === 'pending') {
      const stop = sessionId ? <StopButton busy={busy !== null} onClick={() => void run('stop', { type: 'session.handoff.stop', sessionId, itemId: item.id })} /> : null
      const summarizing = item.state === 'summarizing'
      return (
        <div data-item-id={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <Head
            icon={summarizing ? <Spinner label={t('Running')} /> : <Clock aria-hidden className="size-[14px]" strokeWidth={1.9} />}
            action={stop}
          >
            {limit
              ? t('Continuing with {to}: {from} reached its limit', { from: ownName, to: peerName })
              : summarizing
                ? t('{from} is writing the handoff summary for {to}…', { from: ownName, to: peerName })
                : t('Hands off to {agent} when this turn ends', { agent: peerName })}
          </Head>
          {!summarizing && agentNote ? <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 pl-[22px]">{agentNote}</div> : null}
          <ActionError error={actionError} className="pl-[22px]" />
        </div>
      )
    }
    if (item.state === 'done') {
      const lead = limit
        ? t('Continued with {to}: {from} reached its limit', { from: ownName, to: peerName })
        : implement
        ? t('Plan handed to {agent}', { agent: peerName })
        : byAgent
          ? t('{from} asked to hand off to {to}', { from: ownName, to: peerName })
          : t('Handed off to {agent}', { agent: peerName })
      const showSummary = (implement || byAgent || limit) && summaryBlock
      const hasBody = Boolean(showSummary || agentNote || item.result)
      return (
        <div data-item-id={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <Head icon={limit ? <Gauge aria-hidden className="size-[14px]" strokeWidth={1.9} /> : <ArrowRightLeft aria-hidden className="size-[14px]" strokeWidth={1.9} />} action={openLink}>
            {lead}
          </Head>
          {hasBody ? (
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 pl-[22px]">
              {agentNote}
              {showSummary ? <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">{summaryBlock}</div> : null}
              {item.result ? <ResultBlock id={item.id} agent={peerName} result={item.result} /> : null}
            </div>
          ) : null}
        </div>
      )
    }
    const failed = item.state === 'error'
    const headline = failed ? (
      <span className="text-destructive">
        <span className="font-semibold">{t('Handoff to {agent} failed', { agent: peerName })}</span>
        {item.error ? <> · {item.error}</> : null}
      </span>
    ) : (
      <>
        {t('Handoff to {agent} interrupted', { agent: peerName })}
        {item.error ? <> · {item.error}</> : null}
      </>
    )
    const icon = failed ? <CircleX aria-hidden className="size-[14px] text-destructive" strokeWidth={2} /> : <CircleStop aria-hidden className="size-[14px]" strokeWidth={1.9} />
    if (!item.resumable || !sessionId) {
      return (
        <div data-item-id={item.id}>
          <Head icon={icon}>{headline}</Head>
        </div>
      )
    }
    // Can be resumed, also with another agent. With the saved summary the delivery is immediate.
    return (
      <div data-item-id={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
        <Head icon={icon}>{headline}</Head>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 pl-[22px]">
          <p className="min-w-0 text-sm leading-[1.5] break-words text-muted-foreground">
            {item.summary ? t('The summary is saved, so {agent} can pick it up right away.', { agent: peerName }) : t('The summary was not written yet. Ladder will ask {agent} for it again.', { agent: ownName })}
          </p>
          {summaryBlock}
          {reassigning ? (
            <ReassignForm sessionId={sessionId} itemId={item.id} own={own ?? 'claude-code'} failed={item.agent} onClose={() => {
              setReassigning(false)
              setRestore(true)
            }} />
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === 'resume'} onClick={() => void run('resume', { type: 'session.handoff.resume', sessionId, itemId: item.id })} className={cardButton}>
                {t('Resume handoff')}
              </Button>
              <Button ref={reassignRef} type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => setReassigning(true)} className={cardButton}>
                {t('Reassign…')}
              </Button>
            </div>
          )}
          <ActionError error={actionError} />
        </div>
      </div>
    )
  }

  return (
    <div data-item-id={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <Head icon={<ArrowRightLeft aria-hidden className="size-[14px]" strokeWidth={1.9} />} action={openLink}>
        {limit ? t('Continued from {agent}: it reached its limit', { agent: peerName }) : implement ? t('Plan from {agent}', { agent: peerName }) : byAgent ? t('Handed off by {agent}', { agent: peerName }) : t('Handed off from {agent}', { agent: peerName })}
      </Head>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 pl-[22px]">
        {item.note ? (
          <p className="min-w-0 text-sm leading-[1.5] break-words whitespace-pre-wrap text-foreground">
            <span className="text-muted-foreground">{t('Note')} · </span>
            {item.note}
          </p>
        ) : null}
        {summaryBlock}
        {item.files.length > 0 ? (
          <>
            <Disclosure id={filesId} open={filesOpen} onToggle={toggleFiles}>
              {plural(item.files.length, '{n} file changed', '{n} files changed')}
            </Disclosure>
            {filesOpen ? <ChangedFileList id={filesId} files={item.files} hint={t('Click to open the file')} onPick={(file, alt) => openFile(file.path, undefined, alt)} /> : null}
          </>
        ) : null}
        {item.checkpoint ? (
          <p className="text-xs text-muted-foreground">
            {t('Checkpoint')} · <span className="font-mono">{item.checkpoint.slice(0, 7)}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
})
