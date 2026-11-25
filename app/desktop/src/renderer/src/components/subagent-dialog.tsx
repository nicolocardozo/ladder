// Detail of a subagent: prompt, report, model, effort, tokens, tools and duration.
// It opens from the composer popover and from the chat row; ↑ and ↓ move to the previous or next agent
// in the popover order, Esc closes. While the agent works the detail reloads by itself.
import { Ban, Check, ChevronDown, ChevronUp, CircleX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { localeTag, plural, t } from '@shared/i18n'
import type { SubagentDetail, SubagentInfo } from '@shared/protocol'
import { Spinner } from '@/components/chat/bits'
import { useNow } from '@/components/chat/chat-context'
import { formatDuration } from '@/components/chat/format'
import { Markdown } from '@/components/chat/markdown'
import { effortLabel, formatTokens, StatusMark, useAgentModel } from '@/components/subagent-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { agentElapsed, agentSignature, buildForest, findAgentForTool, loadSubagentDetail, orderedAgents, useSubagentDialog, useSubagentList, type SubagentHint } from '@/lib/subagents'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Reloads at most once in this interval while the agent changes. */
const RELOAD_MS = 900

/** Mounted once per session view: it opens only if the agent to show belongs to this session. */
export function SubagentDialog({ sessionId }: { sessionId: string }) {
  const target = useSubagentDialog((s) => s.target)
  const close = useSubagentDialog((s) => s.close)
  const mine = target && target.sessionId === sessionId ? target : null
  // The list serves the chat rows and the popover even when the dialog is closed: it is requested as soon as the session has subagents.
  const total = useApp((s) => s.sessions[sessionId]?.subagentCounts?.total ?? 0)
  useSubagentList(sessionId, total > 0)
  // If the session view goes away (tab closed, session switched) the dialog does not stay open.
  useEffect(
    () => () => {
      if (useSubagentDialog.getState().target?.sessionId === sessionId) useSubagentDialog.getState().close()
    },
    [sessionId]
  )  // The Dialog stays mounted and opens with `open`, like the Settings one: so the base-ui focus trap is active from the first instant.
  return (
    <Dialog open={mine !== null} onOpenChange={(open) => !open && close()}>
      {mine && <DetailBody sessionId={sessionId} id={mine.id} hint={mine.hint} returnFocus={mine.returnFocus} />}
    </Dialog>
  )
}

interface DetailState {
  id: string
  detail: SubagentDetail | null
  error: string | null
}

function useSubagentDetail(sessionId: string, id: string, signature: string) {
  const [state, setState] = useState<DetailState | null>(null)
  const seq = useRef(0)
  const load = useCallback(() => {
    const n = ++seq.current
    loadSubagentDetail(sessionId, id).then(
      (detail) => {
        if (seq.current === n) setState({ id, detail, error: null })
      },
      (error: unknown) => {
        if (seq.current !== n) return
        // A failed reload does not erase what is already shown.
        setState((prev) => ({ id, detail: prev?.id === id ? prev.detail : null, error: error instanceof Error ? error.message : String(error) }))
      }
    )
  }, [sessionId, id])

  const loadRef = useRef(load)
  loadRef.current = load
  const lastSignature = useRef(signature)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    lastSignature.current = signature
    load()
    return () => {
      seq.current++
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
    // The signal changes together with the id: only the id matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // The SubagentInfo changes on every agent step: reload at most once every RELOAD_MS, without stopping while it keeps changing.
  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    if (timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      loadRef.current()
    }, RELOAD_MS)
  }, [signature])

  const current = state?.id === id ? state : null
  return { detail: current?.detail ?? null, error: current?.error ?? null, loading: !current, retry: load }
}

function DetailBody({ sessionId, id, hint, returnFocus }: { sessionId: string; id: string; hint?: SubagentHint; returnFocus: HTMLElement | null }) {
  const show = useSubagentDialog((s) => s.show)
  const session = useApp((s) => s.sessions[sessionId])
  const agents = useSubagentList(sessionId, false)
  const info = useMemo(() => agents?.find((a) => a.id === id) ?? findAgentForTool(agents, id), [agents, id])
  const order = useMemo(() => orderedAgents(buildForest(agents ?? [])), [agents])
  const index = info ? order.findIndex((a) => a.id === info.id) : -1

  const { detail, error, loading, retry } = useSubagentDetail(sessionId, info?.id ?? id, agentSignature(info))
  // Real data from the host; for old turns, without SubagentInfo, the chat row's data remains.
  const real: SubagentInfo | null = info ?? detail?.info ?? null
  const fromRow: SubagentInfo | null = hint
    ? { id, parentId: null, title: hint.title, kind: null, model: hint.agent?.model ?? null, effort: hint.agent?.effort ?? null, status: hint.status, startedAt: hint.startedAt, endedAt: hint.endedAt, activity: null, tokens: null, toolUses: null, background: false }
    : null
  const shown = real ?? fromRow
  const modelOf = useAgentModel(session?.agent ?? 'claude-code', session?.model ?? null)
  const now = useNow(1000, shown?.status === 'running')

  const go = useCallback(
    (step: number) => {
      const next = order[index + step]
      if (next) show(next.id)
    },
    [order, index, show]
  )
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.metaKey || event.ctrlKey || event.shiftKey) return
    // On a scrollable area (body, prompt, tools) the arrows scroll; ⌥↑ and ⌥↓ change agent from anywhere.
    if (!event.altKey && (event.target as HTMLElement).closest('[data-scroll]')) return
    event.preventDefault()
    go(event.key === 'ArrowDown' ? 1 : -1)
  }

  // The body restarts from the top when switching to another agent.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [id])

  const title = shown?.title ?? t('Subagent')
  const running = shown?.status === 'running'
  const elapsed = shown ? agentElapsed(shown, now) : null
  const modelSource = real ?? fromRow
  const model = modelSource ? modelOf(modelSource) : null
  const effort = modelSource ? effortLabel(modelSource.effort) : null
  const statusText = shown ? { running: t('Running'), done: t('Completed'), error: t('Error'), stopped: t('Stopped') }[shown.status] : null
  const subtitle = [statusText, real?.kind, real?.background && t('background')].filter(Boolean).join(' · ')

  const facts: [string, ReactNode][] = []
  if (model) facts.push([t('Model'), model])
  if (effort) facts.push([t('Effort'), effort])
  if (real?.tokens != null) facts.push([t('Tokens'), formatTokens(real.tokens)])
  const toolCount = real?.toolUses ?? detail?.tools.length ?? null
  if (toolCount != null) facts.push([t('Tools'), String(toolCount)])
  if (elapsed != null) facts.push([t('Duration'), formatDuration(elapsed)])

  return (
    <DialogContent
      showCloseButton={false}
      finalFocus={() => (returnFocus?.isConnected ? returnFocus : true)}
      onKeyDown={onKeyDown}
      aria-describedby={undefined}
      className="flex max-h-[min(82vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]"
    >
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <span className="grid size-5 shrink-0 place-items-center pt-1">{shown ? <StatusMark status={shown.status} /> : <Spinner />}</span>
        <div className="min-w-0 flex-1">
          <DialogTitle className="line-clamp-2 text-lg leading-snug font-semibold break-words">{title}</DialogTitle>
          {subtitle && <DialogDescription className="mt-0.5 text-xs">{subtitle}</DialogDescription>}
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Previous agent')}
            disabled={index <= 0}
            focusableWhenDisabled
            onClick={() => go(-1)}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Next agent')}
            disabled={index < 0 || index >= order.length - 1}
            focusableWhenDisabled
            onClick={() => go(1)}
          >
            <ChevronDown aria-hidden />
          </Button>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t('Close')} />}>
            <X aria-hidden />
          </DialogClose>
        </div>
      </div>

      <div ref={bodyRef} data-scroll tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="truncate text-sm tabular-nums" title={typeof value === 'string' ? value : undefined}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {running && shown?.activity && (
          <Section label={t('Working on')}>
            <p className="text-sm break-words text-foreground/85">{shown.activity}</p>
          </Section>
        )}
        {loading && (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t('Loading…')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-sm text-destructive">
            {error}
            <Button variant="ghost" size="xs" onClick={retry}>
              {t('Try again')}
            </Button>
          </p>
        )}
        {detail?.prompt && (
          <Section label={t('Prompt')}>
            <div data-scroll tabIndex={0} className="max-h-44 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {detail.prompt}
            </div>
          </Section>
        )}
        {detail && (
          <Section label={t('Report')}>
            {detail.report ? (
              <Markdown text={detail.report} compact />
            ) : (
              <p className="text-sm text-muted-foreground">{running ? t('The report appears when the agent finishes.') : t('No report')}</p>
            )}
          </Section>
        )}
        {detail && detail.tools.length > 0 && (
          <Section label={plural(detail.tools.length, '1 tool used', '{n} tools used')}>
            <ul data-scroll tabIndex={0} className="max-h-48 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {detail.tools.map((tool, i) => (
                <li key={i} className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
                  <ToolStatus status={tool.status} />
                  <span className="shrink-0 font-mono text-foreground/85">{tool.name}</span>
                  <span className="min-w-0 flex-1 truncate" title={tool.title}>
                    {tool.title}
                  </span>
                  {shown && <span className="shrink-0 text-faint tabular-nums">{formatDuration(Math.max(0, tool.at - shown.startedAt))}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {detail && shown && <p className="mt-4 text-xs text-faint tabular-nums">{t('Started {time}', { time: new Date(shown.startedAt).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</p>}
      </div>

      {order.length > 1 && index >= 0 && (
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-border/60 px-5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd>
            {t('Previous and next agent')}
            <span className="text-faint">·</span>
            <Kbd>⌥↑↓</Kbd>
            {t('also from text areas')}
          </span>
          <span className="tabular-nums">{t('{n} of {total}', { n: index + 1, total: order.length })}</span>
        </div>
      )}
    </DialogContent>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{label}</h4>
      {children}
    </section>
  )
}

function ToolStatus({ status }: { status: SubagentDetail['tools'][number]['status'] }) {
  const icon = 'size-3 shrink-0'
  switch (status) {
    case 'running':
      return <Spinner label={t('Running')} className="size-[10px]" />
    case 'done':
      return <Check role="img" aria-label={t('Completed')} className={cn(icon, 'text-success')} strokeWidth={2.4} />
    case 'error':
      return <CircleX role="img" aria-label={t('Error')} className={cn(icon, 'text-destructive')} strokeWidth={2.2} />
    default:
      return <Ban role="img" aria-label={t('Denied')} className={cn(icon, 'text-muted-foreground')} strokeWidth={2} />
  }
}
