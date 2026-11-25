// Settings → New sessions → Session profiles: list of session profiles with create, edit, reorder and delete.
import { useState } from 'react'
import { ArrowDown, ArrowUp, EllipsisVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SessionPreset } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { PresetDialog } from '@/components/preset-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePrefs } from '@/hooks/use-prefs'
import { PRESET_MAX, presetSummary, setProjectDefaultPreset } from '@/lib/session-presets'
import { useApp } from '@/store/app-store'

const EMPTY: SessionPreset[] = []

export function PresetsSection() {
  const [prefs, update] = usePrefs()
  const presets = prefs?.presets ?? EMPTY
  const agents = useApp((s) => s.agents)
  const projects = useApp((s) => s.projects)
  const selected = useApp((s) => s.selection.projectId)
  const project = projects.find((p) => p.id === selected) ?? null
  const defaultId = useApp((s) => (project ? s.ui[project.id]?.defaultPreset : undefined))
  // The dialog lives inside this section, so inside the settings dialog: no sibling modal windows.
  const [editor, setEditor] = useState<{ presetId: string | null } | null>(null)
  const [last, setLast] = useState<{ presetId: string | null }>({ presetId: null })
  const open = (presetId: string | null) => {
    setLast({ presetId })
    setEditor({ presetId })
  }

  const move = (index: number, delta: number) => {
    const next = [...presets]
    next.splice(index + delta, 0, ...next.splice(index, 1))
    update({ presets: next })
  }

  if (!prefs) return null
  return (
    <section className="mt-10 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-semibold">{t('Session profiles')}</h3>
        <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={presets.length >= PRESET_MAX} onClick={() => open(null)}>
          <Plus />
          {t('New profile')}
        </Button>
      </div>
      <p className="max-w-[62ch] text-sm text-muted-foreground">
        {t('Saved combinations of agent, account, model, effort and permissions. Pick one in the new chat, or from ⌘K, to start with a click. Save one from any session menu too.')}
      </p>

      {presets.length === 0 ? (
        <p className="mt-2 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">{t('No profiles yet.')}</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
          {presets.map((preset, index) => (
            <li key={preset.id} className="flex items-center gap-3 px-4 py-2.5">
              <AgentMark agent={preset.agent} size={14} className="shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{preset.name}</span>
                  {project && defaultId === preset.id && (
                    <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/10 px-1 text-xs leading-none text-muted-foreground">{t('Default for {project}', { project: project.name })}</span>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">{presetSummary(preset, agents)}</span>
                {preset.note && <span className="truncate text-xs text-faint">{preset.note}</span>}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t('Actions for {name}', { name: preset.name })}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent"
                >
                  <EllipsisVertical className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onClick={() => open(preset.id)}>
                    <Pencil />
                    {t('Edit')}
                  </DropdownMenuItem>
                  {project && (
                    <DropdownMenuItem onClick={() => setProjectDefaultPreset(project.id, defaultId === preset.id ? null : preset.id)}>
                      {defaultId === preset.id ? t('Stop using it as default for {project}', { project: project.name }) : t('Use as default for {project}', { project: project.name })}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp />
                    {t('Move up')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={index === presets.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown />
                    {t('Move down')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => update({ presets: presets.filter((p) => p.id !== preset.id) })}>
                    <Trash2 />
                    {t('Delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <PresetDialog open={editor !== null} onOpenChange={(next) => !next && setEditor(null)} presetId={last.presetId} />
    </section>
  )
}
