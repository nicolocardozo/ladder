// ⌘K, "Use plan template…": picks a saved template, asks for the goal and creates a plan in review in the open chat.
// Templates are deleted from the same list (with confirmation in the row).
import { Command as CommandPrimitive } from 'cmdk'
import { ChevronLeft, ListChecks, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PlanTemplate } from '@shared/plan'
import { plural, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { planButton, useExecutorParts } from '@/components/chat/plan-bits'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const itemClass = 'gap-2.5 px-2.5 py-[7px] text-sm data-selected:bg-accent'

function AgentName({ agent }: { agent: PlanTemplate['plan']['tasks'][number]['agent'] }) {
  return <>{useExecutorParts(agent, null, null).name}</>
}

/** "3 tasks" and the marks of the agents involved, each with its accessible name. */
function TemplateSummary({ template }: { template: PlanTemplate }) {
  const agents = [...new Set(template.plan.tasks.map((task) => task.agent))]
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {agents.map((agent) => (
        <AgentMark key={agent} agent={agent} size={12} />
      ))}
      <span>{plural(template.plan.tasks.length, '{n} task', '{n} tasks')}</span>
    </span>
  )
}

export function PlanTemplatePane({ sessionId, onBack, onClose }: { sessionId: string; onBack: () => void; onClose: () => void }) {
  const templates = useApp((s) => s.planTemplates)
  const loadTemplates = useApp((s) => s.loadPlanTemplates)
  const deleteTemplate = useApp((s) => s.deletePlanTemplate)
  const startFromTemplate = useApp((s) => s.startPlanFromTemplate)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<PlanTemplate | null>(null)
  const [goal, setGoal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadTemplates().then((result) => {
      if (!result.ok) setError(result.error)
    })
  }, [loadTemplates])

  const shown = useMemo(() => {
    const tokens = normalize(query).split(/\s+/).filter(Boolean)
    // Newest first: it is the one highlighted on open.
    return [...(templates ?? [])].sort((a, b) => b.createdAt - a.createdAt).filter((template) => tokens.every((token) => normalize(`${template.name} ${template.plan.goal} ${template.plan.tasks.map((x) => x.title).join(' ')}`).includes(token)))
  }, [templates, query])

  // On open (and when the list changes) the first, the newest, is highlighted.
  const [active, setActive] = useState('')
  const firstValue = shown[0] ? `template:${shown[0].id}` : ''
  useEffect(() => {
    if (!shown.some((x) => `template:${x.id}` === active)) setActive(firstValue)
  }, [shown, active, firstValue])

  const create = async () => {
    if (!chosen || !goal.trim() || busy) return
    setBusy(true)
    setError(null)
    const result = await startFromTemplate(sessionId, chosen.id, goal.trim())
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  const remove = async (template: PlanTemplate) => {
    setError(null)
    const result = await deleteTemplate(template.id)
    if (!result.ok) setError(result.error)
    setConfirming(null)
  }

  if (chosen) {
    return (
      <div className="flex min-w-0 flex-col bg-popover">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          <button
            type="button"
            aria-label={t('Back to the templates')}
            onClick={() => {
              setChosen(null)
              setError(null)
            }}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronLeft aria-hidden className="size-4" strokeWidth={1.9} />
          </button>
          <ListChecks aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{chosen.name}</span>
          <TemplateSummary template={chosen} />
        </div>
        <div className="grid gap-3 px-4 py-3.5">
          <ol className="grid gap-0.5 text-sm">
            {chosen.plan.tasks.map((task, i) => (
              <li key={task.id} className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <AgentMark agent={task.agent} size={12} />
                  <AgentName agent={task.agent} />
                </span>
              </li>
            ))}
          </ol>
          <label className="grid gap-1">
            <span className="text-xs font-semibold text-muted-foreground">{t('Goal')}</span>
            <input
              autoFocus
              value={goal}
              maxLength={500}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void create()
                }
              }}
              placeholder={t('What should the plan achieve?')}
              className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => void create()} disabled={!goal.trim() || busy} className={planButton.primary}>
              {busy ? t('Creating…') : t('Create plan')}
              {!busy && <Kbd className="text-primary-foreground [&_kbd]:bg-transparent [&_kbd]:ring-1 [&_kbd]:ring-primary-foreground/70 [&_kbd]:ring-inset">↵</Kbd>}
            </button>
          </div>
        </div>
        <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-xs text-faint">
          <span>{t('Nothing runs until you approve the plan.')}</span>
          <span className="ml-auto shrink-0">
            <Kbd>esc</Kbd> {t('to close')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <Command shouldFilter={false} loop value={active} onValueChange={setActive} label={t('Plan templates')} className="rounded-none! bg-popover p-0">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          aria-label={t('Back to search')}
          onClick={onBack}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronLeft aria-hidden className="size-4" strokeWidth={1.9} />
        </button>
        <CommandPrimitive.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t('Search plan templates…')}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
      </div>
      <CommandList className="max-h-[min(440px,58vh)] px-1.5 py-1.5">
        {templates === null && !error && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            {t('Loading templates…')}
          </p>
        )}
        {templates !== null && (
          <CommandEmpty className="px-6 py-8 text-sm text-muted-foreground">
            {templates.length === 0 ? t('No plan templates yet. Finish a plan and press “Save as template” on its card.') : t('No templates match “{query}”.', { query: query.trim() })}
          </CommandEmpty>
        )}
        {shown.length > 0 && (
          <CommandGroup heading={t('Plan templates')}>
            {shown.map((template) => (
              <CommandItem key={template.id} value={`template:${template.id}`} className={itemClass} onSelect={() => confirming !== template.id && setChosen(template)}>
                <ListChecks aria-hidden className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
                {confirming === template.id ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{t('Delete “{name}”?', { name: template.name })}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void remove(template)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      className={cn(planButton.destructive, 'h-6 px-2 text-xs')}
                    >
                      {t('Delete')}
                    </button>
                    <button
                      type="button"
                      autoFocus
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirming(null)
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setConfirming(null)
                        }
                      }}
                      className={cn(planButton.secondary, 'h-6 px-2 text-xs')}
                    >
                      {t('Cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{template.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{template.plan.tasks.map((task) => task.title).join(' → ')}</span>
                    </span>
                    <TemplateSummary template={template} />
                    <button
                      type="button"
                      aria-label={t('Delete template “{name}”', { name: template.name })}
                      title={t('Delete template')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirming(template.id)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Trash2 aria-hidden className="size-3.5" strokeWidth={1.8} />
                    </button>
                  </>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-xs text-faint">
        <span role={error ? 'alert' : undefined} className={error ? 'text-destructive' : undefined}>
          {error ?? (
            <>
              <Kbd>↑↓</Kbd> {t('to select')}
            </>
          )}
        </span>
        {!error && (
          <span>
            <Kbd>↵</Kbd> {t('to use')}
          </span>
        )}
        <span className="ml-auto">
          <Kbd>esc</Kbd> {t('to close')}
        </span>
      </div>
    </Command>
  )
}
