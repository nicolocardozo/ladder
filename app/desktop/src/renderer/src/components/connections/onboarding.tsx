// Primo avvio: "Collega i tuoi abbonamenti". Una schermata, tre righe, saltabile; si ritrova in Impostazioni → Abbonamenti.
import type { ConnectionId, ConnectionStatus } from '@shared/protocol'
import { t } from '@shared/i18n'
import { LadderMark } from '@/components/brand/logo'
import { DetectedAgents } from '@/components/agents/detected-agents'
import { Button } from '@/components/ui/button'
import { liveAgentCatalogActions, type AgentCatalogActions } from '@/lib/agent-catalog'
import { liveConnectionActions, type ConnectionActions } from '@/lib/connections'
import { useApp } from '@/store/app-store'
import { ConnectionList } from './connection-list'

export function Onboarding({ statuses, actions = liveConnectionActions, agentActions = liveAgentCatalogActions, onDone }: {
  statuses?: Partial<Record<ConnectionId, ConnectionStatus>>
  actions?: ConnectionActions
  /** Detection of the other installed CLIs (web preview: fake host). */
  agentActions?: AgentCatalogActions
  onDone: () => void
}) {
  const stored = useApp((s) => s.connections)
  const agents = useApp((s) => s.agents)
  const list = statuses ?? stored
  const ready = [list['claude-code'], list.codex].some((c) => c?.state === 'connected' && !c.login) || (!statuses && agents.some((a) => a.kind === 'acp' && a.available))

  return (
    <main className="drag flex min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-8">
      <div className="no-drag my-auto flex w-full max-w-[560px] flex-col py-14">
        <LadderMark className="mb-8 h-14 w-auto self-start" />
        <h1 className="text-2xl font-semibold tracking-tight">{t('Connect your subscriptions')}</h1>
        <p className="mt-2 max-w-[52ch] text-sm text-muted-foreground">
          {t('Ladder works with the plans you already pay for. Signing in opens your browser, and you come back here connected. No Terminal needed.')}
        </p>
        <div className="mt-8">
          <ConnectionList statuses={statuses} actions={actions} />
        </div>
        <DetectedAgents actions={agentActions} />
        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">{t('You can do this later in Settings → Subscriptions.')}</p>
          <Button variant={ready ? 'default' : 'ghost'} className="shrink-0 text-sm" onClick={onDone}>
            {ready ? t('Continue') : t('Skip for now')}
          </Button>
        </div>
      </div>
    </main>
  )
}
