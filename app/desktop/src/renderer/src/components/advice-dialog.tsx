// "Ask for advice…": picks who gives read-only advice on the session work, one agent (/advisor) or 2 to 4 different ones (/committee).
// Opened from the session menu and by /advisor without an agent or /committee: driven by `adviceDialog` in the store.
import { Check } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { AgentId, AgentStatus, Project } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { useProjectSettings } from '@/components/main-views'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { adviceAgents, adviceBlockedReason, COMMITTEE_MAX, committeeBlockedReason } from '@/lib/advice'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const QUESTION_MAX = 1000

/** Mounted once in App: the content stays during the close animation. */
export function AdviceDialog() {
  const seed = useApp((s) => s.adviceDialog)
  const setSeed = useApp((s) => s.setAdviceDialog)
  const shown = useRef(seed)
  if (seed) shown.current = seed
  const listRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={seed !== null} onOpenChange={(open) => !open && setSeed(null)}>
      <DialogContent initialFocus={() => listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? listRef.current ?? true} className="gap-4 sm:max-w-[480px]">
        {/* The form mounts on every open: fields restart from their initial values. */}
        {seed && shown.current && <AdviceForm key={`${shown.current.sessionId}:${shown.current.mode}`} listRef={listRef} seed={shown.current} onClose={() => setSeed(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function AdviceForm({ listRef, seed, onClose }: { listRef: React.RefObject<HTMLDivElement | null>; seed: { sessionId: string; mode: 'advisor' | 'committee'; question?: string }; onClose: () => void }) {
  const session = useApp((s) => s.sessions[seed.sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId) ?? null) as Project | null
  const agents = useApp((s) => s.agents)
  const settings = useProjectSettings(project)
  const eligible = useMemo(() => adviceAgents(agents, settings?.agents?.allowed ?? []), [agents, settings])
  const committee = seed.mode === 'committee'
  // Committee: all allowed agents (up to 4) preselected. Single: the first.
  const [picked, setPicked] = useState<AgentId[]>(() => eligible.slice(0, committee ? COMMITTEE_MAX : 1).map((a) => a.agent))
  const [question, setQuestion] = useState(seed.question ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const blocked = session ? adviceBlockedReason(session) : t('This session no longer exists.')
  const unavailable = committee ? committeeBlockedReason(eligible) : eligible.length === 0 ? t('No agent is available here. Check Settings or the project’s allowed agents.') : null
  const problem = blocked ?? unavailable
  // Allowed agents can arrive after opening: the selection keeps only those still valid.
  const valid = picked.filter((id) => eligible.some((a) => a.agent === id))
  const count = valid.length
  const tooFew = committee && count < 2
  const full = committee && count >= COMMITTEE_MAX

  const toggle = (id: AgentId) => {
    if (!committee) return setPicked([id])
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : current.length < COMMITTEE_MAX ? [...current, id] : current))
  }

  const submit = async () => {
    if (!session || busy || problem || count === 0 || tooFew) return
    setBusy(true)
    setError(null)
    try {
      await request({ type: 'session.advise', sessionId: session.id, agents: valid.map((agent) => ({ agent })), question: question.trim() })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-lg font-semibold">{committee ? t('Ask a committee') : t('Ask for advice')}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {committee
            ? t('Two to four different agents read the work and the diff, each on their own, and give an opinion. Nothing is edited.')
            : t('Another agent reads the work and the diff and gives an opinion. Nothing is edited.')}
        </DialogDescription>
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="advice-agents" className="text-xs font-semibold text-muted-foreground">
            {committee ? t('Agents ({n} of {max})', { n: count, max: COMMITTEE_MAX }) : t('Agent')}
          </span>
          <div
            ref={listRef}
            tabIndex={-1}
            role={committee ? 'group' : 'radiogroup'}
            aria-labelledby="advice-agents"
            className="flex flex-col gap-1 outline-none"
            onKeyDown={(e) => {
              // Single choice: one Tab stop (the selected entry) and arrow keys move selection and focus.
              if (committee || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) || eligible.length === 0) return
              e.preventDefault()
              const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
              const at = Math.max(0, eligible.findIndex((a) => a.agent === valid[0]))
              const next = eligible[(at + step + eligible.length) % eligible.length]
              setPicked([next.agent])
              window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-agent="${next.agent}"]`)?.focus())
            }}
          >
            {eligible.map((a, i) => (
              <AgentRow
                key={a.agent}
                agent={a}
                committee={committee}
                checked={valid.includes(a.agent)}
                tabStop={committee || (valid.length > 0 ? valid[0] === a.agent : i === 0)}
                disabled={committee && full && !valid.includes(a.agent)}
                onToggle={() => toggle(a.agent)}
              />
            ))}
          </div>
          {committee && !problem && <p className="text-xs text-muted-foreground">{tooFew ? t('Choose at least two agents.') : t('Up to {max} agents.', { max: COMMITTEE_MAX })}</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="advice-question" className="text-xs font-semibold text-muted-foreground">
            {t('What should they look at? (optional)')}
          </label>
          <Textarea id="advice-question" rows={3} value={question} maxLength={QUESTION_MAX} onChange={(e) => setQuestion(e.target.value)} placeholder={t('e.g. Is this the right approach?')} className="min-h-0 resize-none" />
          {!question.trim() && <p className="text-xs text-muted-foreground">{t('Without a question they give a general review of the current work.')}</p>}
        </div>
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
        <Button type="submit" disabled={busy || Boolean(problem) || count === 0 || tooFew} aria-busy={busy}>
          {busy ? t('Asking…') : committee ? t('Ask the committee') : t('Ask')}
        </Button>
      </div>
    </form>
  )
}

/** Row for an agent: multiple (committee) or single choice. State is in the mark, not only the color. */
function AgentRow({ agent, committee, checked, tabStop, disabled, onToggle }: { agent: AgentStatus; committee: boolean; checked: boolean; tabStop: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role={committee ? 'checkbox' : 'radio'}
      aria-checked={checked}
      data-agent={agent.agent}
      tabIndex={tabStop ? 0 : -1}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onToggle()}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-md border border-border px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-input/70',
        checked && 'bg-accent/60',
        disabled && 'opacity-50 hover:bg-transparent'
      )}
    >
      <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center border border-input', committee ? 'rounded-[4px]' : 'rounded-full', checked && 'border-primary bg-primary text-primary-foreground')}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <AgentMark agent={agent.agent} size={14} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
    </button>
  )
}
