// First launch: "Other agents found on your Mac". Compact and skippable; appears only if `agents.detect` finds already installed CLIs.
// It does not block the screen: the read starts in the background and, with no results or with an error, the section does not exist.
import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { AgentCatalogEntry } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Button } from '@/components/ui/button'
import type { AgentCatalogActions } from '@/lib/agent-catalog'
import { useApp } from '@/store/app-store'

function Item({ entry, actions }: { entry: AgentCatalogEntry; actions: AgentCatalogActions }) {
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(entry.added)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const detail = entry.detected ? [entry.detected.path, entry.detected.version ? `v${entry.detected.version}` : null].filter(Boolean).join(' · ') : null
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <AgentMark agent={`acp:${entry.id}`} title={entry.name} size={16} className="text-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{entry.name}</span>
        {detail && <span title={detail} className="truncate font-mono text-xs text-faint">{detail}</span>}
        {problem && (
          <span role="alert" className="text-xs text-destructive">
            {problem}
          </span>
        )}
      </div>
      {added ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success">
          <Check aria-hidden className="size-3" />
          {t('Added')}
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-sm"
          disabled={busy}
          aria-label={t('Add {name}', { name: entry.name })}
          onClick={() => {
            setBusy(true)
            setProblem(null)
            actions
              .add(entry)
              .then(() => mounted.current && setAdded(true))
              .catch((e: Error) => mounted.current && setProblem(e.message))
              .finally(() => mounted.current && setBusy(false))
          }}
        >
          {busy ? t('Adding…') : t('Add')}
        </Button>
      )}
    </div>
  )
}

export function DetectedAgents({ actions }: { actions: AgentCatalogActions }) {
  const [found, setFound] = useState<AgentCatalogEntry[]>([])
  const hidden = useApp((s) => s.detectedAgentsHidden)
  const hide = useApp((s) => s.hideDetectedAgents)
  useEffect(() => {
    if (hidden) return
    let alive = true
    actions
      .detect()
      .then((list) => alive && setFound(list.filter((entry) => entry.state === 'detected' && entry.detected)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [actions, hidden])

  if (hidden || found.length === 0) return null
  return (
    <section aria-label={t('Other agents found on your Mac')} className="mt-6 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="px-1 text-xs font-semibold text-muted-foreground">{t('Other agents found on your Mac')}</h2>
        <Button variant="ghost" size="xs" className="text-xs text-muted-foreground" onClick={hide}>
          {t('Hide')}
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {found.map((entry) => (
          <Item key={entry.id} entry={entry} actions={actions} />
        ))}
      </div>
    </section>
  )
}
