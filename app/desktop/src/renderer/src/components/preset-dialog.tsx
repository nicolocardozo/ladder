// Create, edit or save as a session profile. The same form serves "Save as profile" (from the session menu
// and ⌘K, with the session's values already in) and the profiles section in settings.
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentId, Effort, PermissionLevel, SessionPreset } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark, modelLabel } from '@/components/agent-mark'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { usePrefs } from '@/hooks/use-prefs'
import { EFFORTS, levelLabel, permissionLevels, supportsEffort } from '@/lib/agents'
import { agentStatusFor, isProfileAgent, normalizeProfileId, useProfiles } from '@/lib/profiles'
import { resolveSessionDefaults } from '@/lib/session-defaults'
import { PRESET_MAX, PRESET_NAME_MAX, PRESET_NOTE_MAX, PRESET_PROMPT_MAX, presetNameError } from '@/lib/session-presets'
import { useApp } from '@/store/app-store'

const NONE = '__none'

function Field({ label, htmlFor, error, errorId, children }: { label: string; htmlFor?: string; error?: string | null; errorId?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-muted-foreground">
        {label}
      </label>
      {children}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Controlled dialog. `presetId` edits a profile, otherwise it creates a new one from `seed`. */
export function PresetDialog({ open, onOpenChange, presetId, seed }: { open: boolean; onOpenChange: (open: boolean) => void; presetId?: string | null; seed?: Partial<SessionPreset> }) {
  // Initial focus is given by the Dialog (initialFocus): so it remembers the element that opened it and restores it on close.
  const nameRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={nameRef} className="gap-4 sm:max-w-[540px]">
        {/* The form mounts on every open: the fields restart from the starting values. */}
        {open && <PresetForm nameRef={nameRef} presetId={presetId ?? null} seed={seed} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** The window opened from outside settings (session menu, ⌘K): driven by the store's `presetEditor`. */
export function SavePresetDialog() {
  const editor = useApp((s) => s.presetEditor)
  const setEditor = useApp((s) => s.setPresetEditor)
  // The content stays mounted during the closing animation.
  const shown = useRef(editor)
  if (editor) shown.current = editor
  return <PresetDialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)} presetId={shown.current?.presetId} seed={shown.current?.seed} />
}

function PresetForm({ nameRef, presetId, seed, onClose }: { nameRef: RefObject<HTMLInputElement | null>; presetId: string | null; seed?: Partial<SessionPreset>; onClose: () => void }) {
  const [prefs, update] = usePrefs()
  const presets = prefs?.presets ?? []
  const existing = presetId ? (presets.find((p) => p.id === presetId) ?? null) : null
  const agents = useApp((s) => s.agents)
  const globalDefaults = prefs?.defaults

  // Starting values: the profile being edited, then the seed (session), then the global defaults.
  const initial = useMemo<Partial<SessionPreset>>(() => {
    if (existing) return existing
    if (seed?.agent) return seed
    const resolved = resolveSessionDefaults({ agents, global: globalDefaults })
    return { agent: resolved.agent ?? agents[0]?.agent, model: resolved.model, effort: resolved.effort, permission: resolved.permission, ...seed }
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [name, setName] = useState(initial.name ?? '')
  const [note, setNote] = useState(initial.note ?? '')
  const [agent, setAgent] = useState<AgentId>(initial.agent ?? 'claude-code')
  const [profileId, setProfileId] = useState<string | null>(initial.profileId ?? null)
  const [model, setModel] = useState<string | null>(initial.model ?? null)
  const [effort, setEffort] = useState<Effort | null>(initial.effort ?? null)
  const [permission, setPermission] = useState<PermissionLevel>(initial.permission ?? 'edit')
  const [worktree, setWorktree] = useState(initial.worktree ?? false)
  const [prompt, setPrompt] = useState(initial.prompt ?? '')
  const [submitted, setSubmitted] = useState(false)

  const accounts = useProfiles(agent)
  const status = useApp((s) => agentStatusFor(s, agent, profileId && isProfileAgent(agent) ? normalizeProfileId(agent, profileId) : null)) ?? agents.find((a) => a.agent === agent) ?? null
  // A saved account that no longer exists stays visible, so it can be removed; it is not rewritten on save.
  const accountGone = Boolean(profileId && isProfileAgent(agent) && !accounts.some((p) => p.id === normalizeProfileId(agent, profileId)))
  const showAccount = accounts.length > 1 || accountGone
  // The profile you are editing is gone (deleted from another window): saving it would recreate it.
  const gone = presetId !== null && existing === null
  // A saved model that the agent no longer offers stays visible, so it doesn't vanish without saying so.
  const modelKnown = !model || !status || status.models.length === 0 || status.models.some((m) => m.id === model)
  const modelEfforts = status?.models.find((m) => m.id === model)?.efforts
  const effortLevels = EFFORTS.filter((e) => (modelEfforts ? modelEfforts.includes(e.id) : true))

  const nameError = presetNameError(name, presets, existing?.id, submitted)
  const full = !existing && presets.length >= PRESET_MAX
  const nameId = 'preset-name'

  const chooseAgent = (next: AgentId) => {
    if (next === agent) return
    // Account, model and effort only make sense with their agent.
    setAgent(next)
    setProfileId(null)
    setModel(null)
    setEffort(null)
  }
  const chooseModel = (next: string | null) => {
    setModel(next)
    const accepted = status?.models.find((m) => m.id === next)?.efforts
    if (effort && accepted && !accepted.includes(effort)) setEffort(null)
  }

  const save = () => {
    setSubmitted(true)
    if (full || gone || presetNameError(name, presets, existing?.id, true) || !prefs) return
    const next: SessionPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      agent,
      permission,
      worktree
    }
    if (note.trim()) next.note = note.trim()
    if (profileId && isProfileAgent(agent) && !accountGone) next.profileId = profileId
    if (model) next.model = model
    if (effort && supportsEffort(agent)) next.effort = effort
    if (prompt.trim()) next.prompt = prompt
    update({ presets: existing ? presets.map((p) => (p.id === existing.id ? next : p)) : [...presets, next] })
    onClose()
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-lg font-semibold">{presetId !== null ? t('Edit session profile') : t('Save as session profile')}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">{t('Agent, account, model, effort and permissions you can start a new chat with in one click.')}</DialogDescription>
      </div>

      <div className="flex max-h-[60vh] flex-col gap-3.5 overflow-y-auto px-0.5 py-0.5">
        <Field label={t('Name')} htmlFor={nameId} error={nameError} errorId={`${nameId}-error`}>
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            maxLength={PRESET_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('e.g. Quick review')}
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? `${nameId}-error` : undefined}
          />
        </Field>
        <Field label={t('Note (optional)')} htmlFor="preset-note">
          <Textarea id="preset-note" rows={2} value={note} maxLength={PRESET_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={t('What it is for, in a sentence or two')} className="min-h-0 resize-none" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Agent')}>
            <Select value={agent} onValueChange={(value) => chooseAgent(String(value) as AgentId)}>
              <SelectTrigger aria-label={t('Agent')} className="w-full">
                <AgentMark agent={agent} size={14} />
                <SelectValue>{(value: string) => agents.find((a) => a.agent === value)?.name ?? value.replace(/^acp:/, '')}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {!agents.some((a) => a.agent === agent) && <SelectItem value={agent}>{agent.replace(/^acp:/, '')}</SelectItem>}
                {agents.map((a) => (
                  <SelectItem key={a.agent} value={a.agent} disabled={!a.available && a.agent !== agent}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {showAccount && isProfileAgent(agent) && (
            <Field label={t('Account')}>
              <Select value={profileId ?? NONE} onValueChange={(value) => setProfileId(value === NONE ? null : String(value))}>
                <SelectTrigger aria-label={t('Account')} className="w-full">
                  <SelectValue>{(value: string) => (value === NONE ? t('Project account') : (accounts.find((p) => p.id === value)?.name ?? t('Account no longer available')))}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value={NONE}>{t('Project account')}</SelectItem>
                  {accounts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  {profileId && !accounts.some((p) => p.id === profileId) && <SelectItem value={profileId}>{t('Account no longer available')}</SelectItem>}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label={t('Model')}>
            <Select value={model ?? NONE} disabled={!status || (status.models.length === 0 && !model)} onValueChange={(value) => chooseModel(value === NONE ? null : String(value))}>
              <SelectTrigger aria-label={t('Model')} className="w-full">
                <SelectValue>{(value: string) => (value === NONE ? t('Default model') : (modelLabel(status, value) ?? value))}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={NONE}>{t('Default model')}</SelectItem>
                {!modelKnown && model && <SelectItem value={model}>{model}</SelectItem>}
                {status?.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {supportsEffort(agent) && (
            <Field label={t('Effort')}>
              <Select value={effort ?? NONE} onValueChange={(value) => setEffort(value === NONE ? null : (String(value) as Effort))}>
                <SelectTrigger aria-label={t('Effort')} className="w-full">
                  <SelectValue>{(value: string) => (value === NONE ? t('Default effort') : t(EFFORTS.find((e) => e.id === value)?.label ?? value))}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value={NONE}>{t('Default effort')}</SelectItem>
                  {effortLevels.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {t(e.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label={t('Permissions')}>
            <Select value={permission} onValueChange={(value) => setPermission(String(value) as PermissionLevel)}>
              <SelectTrigger aria-label={t('Permissions')} className="w-full">
                <SelectValue>{(value: string) => levelLabel(value as PermissionLevel)}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {permissionLevels.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {levelLabel(p.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
          {t('Work in a new worktree')}
        </label>

        <Field label={t('Starting prompt (optional)')} htmlFor="preset-prompt">
          <Textarea
            id="preset-prompt"
            rows={3}
            value={prompt}
            maxLength={PRESET_PROMPT_MAX}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('Appears in the composer as a draft; it never sends by itself')}
            className="min-h-0 resize-y"
          />
        </Field>
      </div>

      {gone && <p role="alert" className="text-xs text-destructive">{t('This profile no longer exists, so it can’t be saved. Close this window and start again.')}</p>}
      {full && <p className="text-xs text-destructive">{t('You can keep up to {n} profiles. Delete one to add another.', { n: PRESET_MAX })}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={full || gone || !prefs}>
          {presetId !== null ? t('Save changes') : t('Save profile')}
        </Button>
      </div>
    </form>
  )
}
