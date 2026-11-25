// "Hand off to…": picks the agent that receives the work, with model, effort and an optional note. The current agent writes the summary,
// then the work continues in a linked session in the same folder. Opened from the session menu and by /handoff: driven by `handoffDialog` in the store.
import { useMemo, useRef, useState, type RefObject } from 'react'
import type { AgentId, Project } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentChoiceFields, Field, useAgentChoice } from '@/components/agent-fields'
import { useProjectSettings } from '@/components/main-views'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { supportsEffort } from '@/lib/agents'
import { handoffBlockedReason, handoffTargets } from '@/lib/handoff'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

const NOTE_MAX = 500

/** Mounted once in App: the content stays during the close animation. */
export function HandoffDialog() {
  const request_ = useApp((s) => s.handoffDialog)
  const setRequest = useApp((s) => s.setHandoffDialog)
  const shown = useRef(request_)
  if (request_) shown.current = request_
  const agentRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={request_ !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <DialogContent initialFocus={agentRef} className="gap-4 sm:max-w-[480px]">
        {/* The form mounts on every open: fields restart from their initial values. */}
        {request_ && shown.current && <HandoffForm key={shown.current.sessionId} agentRef={agentRef} seed={shown.current} onClose={() => setRequest(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function HandoffForm({ agentRef, seed, onClose }: { agentRef: RefObject<HTMLButtonElement | null>; seed: { sessionId: string; agent?: AgentId; note?: string }; onClose: () => void }) {
  const session = useApp((s) => s.sessions[seed.sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId) ?? null) as Project | null
  const agents = useApp((s) => s.agents)
  const settings = useProjectSettings(project)
  const targets = useMemo(() => (session ? handoffTargets(agents, session.agent, settings?.agents?.allowed ?? []) : []), [agents, session, settings])
  const blocked = session ? handoffBlockedReason(session) : t('This session no longer exists.')
  const choice = useAgentChoice(targets, seed.agent ?? null)
  const { agent, model, effort } = choice
  const [note, setNote] = useState(seed.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!session || !agent || busy || blocked) return
    setBusy(true)
    setError(null)
    try {
      await request({ type: 'session.handoff', sessionId: session.id, agent, model, effort: agent && supportsEffort(agent) ? effort : null, note: note.trim() || null })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unavailable = targets.length === 0 ? t('No other agent is available here. Check Settings or the project’s allowed agents.') : null
  const problem = blocked ?? unavailable

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-lg font-semibold">{t('Hand off to…')}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">{t('The current agent writes a summary, then the work continues in a linked session in the same folder.')}</DialogDescription>
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <AgentChoiceFields choice={choice} targets={targets} agentRef={agentRef} />
        </div>
        <Field label={t('What should it do next? (optional)')} htmlFor="handoff-note">
          <Textarea id="handoff-note" rows={3} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. Finish the tests and open a PR')} className="min-h-0 resize-none" />
        </Field>
      </div>

      {(problem || error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={busy || Boolean(problem) || !agent}>
          {busy ? t('Handing off…') : t('Hand off')}
        </Button>
      </div>
    </form>
  )
}
