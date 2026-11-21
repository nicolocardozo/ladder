// Righe di sistema dei sotto-agenti in background: "in attesa di N agenti" sotto l'ultimo turno
// e la fine degli agenti con il coordinatore fermo (riga con "Continue").
import { Bot, CornerDownRight } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { plural, t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Spinner } from './bits'
import { useChatActions } from './chat-context'
import type { AgentsFinishedItem } from './turns'

/** Il coordinatore è fermo ma N agenti in background lavorano: la sessione aspetta loro, non te. */
export function WaitingAgentsLine({ count }: { count: number }) {
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <Spinner label={t('Running')} />
      <span className="min-w-0 truncate">{plural(count, 'Waiting for 1 background agent', 'Waiting for {n} background agents')}</span>
    </div>
  )
}

/** Dopo il clic il pulsante resta spento finché l'host non aggiorna la riga; se non lo fa si riaccende dopo qualche secondo. */
const RETRY_AFTER_MS = 4000

function ContinueButton({ itemId }: { itemId: string }) {
  const { continueSession } = useChatActions()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!pending) return
    const id = window.setTimeout(() => setPending(false), RETRY_AFTER_MS)
    return () => window.clearTimeout(id)
  }, [pending])
  if (!continueSession) return null
  const run = () => {
    if (pending) return
    setPending(true)
    setError(null)
    continueSession(itemId).catch((e: unknown) => {
      setPending(false)
      setError(e instanceof Error ? e.message : t('Couldn’t continue the session.'))
    })
  }
  return (
    <>
      <Button type="button" size="sm" variant="secondary" disabled={pending} aria-busy={pending} onClick={run} className="ml-auto h-7 shrink-0 text-sm font-medium">
        {t('Continue')}
      </Button>
      {error ? (
        <p role="alert" className="basis-full pl-[22px] text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}

/** Fine dei sotto-agenti in background. 'dismissed' non si vede; 'resumed' sparisce se il turno aperto dall'agente ha già la sua riga. */
export const AgentsFinishedLine = memo(function AgentsFinishedLine({ item, hideResumed }: { item: AgentsFinishedItem; hideResumed: boolean }) {
  if (item.state === 'dismissed') return null
  if (item.state === 'resumed' && hideResumed) return null

  if (item.state === 'continued') {
    return (
      <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
        <CornerDownRight aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.9} />
        <p className="min-w-0">{t('Continued')}</p>
      </div>
    )
  }

  if (item.state === 'resumed') {
    return (
      <div data-item-id={item.id} className="flex min-w-0 items-start gap-2 text-sm leading-[1.5] text-muted-foreground">
        <Bot aria-hidden className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.8} />
        <p className="min-w-0 break-words">
          {plural(item.finished, 'The agent picked up after 1 background agent finished', 'The agent picked up after {n} background agents finished')}
        </p>
      </div>
    )
  }

  return (
    <div data-item-id={item.id} role="group" aria-label={t('Background agents finished')} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <div className="flex min-w-0 items-center gap-2 text-sm leading-[1.5] text-muted-foreground">
        <Bot aria-hidden className="size-[14px] shrink-0" strokeWidth={1.8} />
        <p className="min-w-0 break-words">
          {plural(item.finished, '1 background agent finished', '{n} background agents finished')}
          {item.failed > 0 ? (
            <span className="text-destructive">
              {' · '}
              {plural(item.failed, '1 failed', '{n} failed')}
            </span>
          ) : null}
        </p>
      </div>
      <ContinueButton itemId={item.id} />
      <p className="basis-full pl-[22px] text-xs text-muted-foreground">{t('The agent didn’t start again on its own, so it’s waiting for you.')}</p>
    </div>
  )
})
