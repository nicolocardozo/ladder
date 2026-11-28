// Settings → Workspace: external editor and worktrees (folder and branch prefix, then script, wait and copied files per project).
import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { t, plural } from '@shared/i18n'
import type { EditorAvailability, EditorId, Project, ProjectSettings, WorktreeFiles, WorktreeSettingsPatch } from '@shared/protocol'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EDITOR_NAME, EDITORS } from '@/components/inspector/open-file'
import { useProjectSettings } from '@/components/main-views'
import { ChoiceGroup, Outcome, SettingRow, SettingsBlock, settingsButton, settingsField, type Choice } from '@/components/settings-parts'
import { ServicesBlock, type PersonalService } from '@/components/settings-services'
import { WorktreesOnDisk } from '@/components/settings-worktrees'
import { usePrefs } from '@/hooks/use-prefs'
import { request } from '@/lib/host-client'
import { system } from '@/lib/system-bridge'
import { useApp } from '@/store/app-store'

export function WorkspaceSection() {
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Workspace')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Where files open outside Ladder and where sessions that work in their own copy of the project keep it.')}
      </DialogDescription>
      {/* From 820 px: editor and worktree folder side by side; the project settings, taller, stay full width below. */}
      <div className="grid items-start gap-x-10 @[820px]:grid-cols-2">
        <EditorBlock />
        <WorktreesBlock />
      </div>
      <ProjectWorktreeBlock />
      <WorktreesOnDisk />
    </>
  )
}

// ── External editor ─────────────────────────────────────────────────────────

function EditorBlock() {
  const [prefs, update] = usePrefs()
  const [installed, setInstalled] = useState<EditorAvailability | null>(null)
  useEffect(() => {
    let cancelled = false
    void system.editors().then((found) => !cancelled && setInstalled(found))
    return () => {
      cancelled = true
    }
  }, [])
  if (!prefs) return null
  const choices: Choice<EditorId>[] = EDITORS.map((id) => ({
    id,
    label: EDITOR_NAME[id],
    badge: id === 'cursor' ? t('default') : undefined,
    note: installed && !installed[id] ? t('not installed') : undefined
  }))
  const missing = installed && !installed[prefs.editor]
  const firstInstalled = installed ? EDITORS.find((id) => installed[id]) : undefined
  return (
    <SettingsBlock id="editor-title" title={t('External editor')} description={t('Used by “Open in editor” for files and project folders. A project can pick its own from its menu in the sidebar.')}>
      <ChoiceGroup label={t('External editor')} value={prefs.editor} choices={choices} onChange={(editor) => update({ editor })} minWidth={150} />
      {missing && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {firstInstalled ? t('{editor} isn’t installed: Ladder opens {other} instead.', { editor: EDITOR_NAME[prefs.editor], other: EDITOR_NAME[firstInstalled] }) : t('None of these editors is installed: Ladder opens files with the app macOS picks.')}
        </p>
      )}
    </SettingsBlock>
  )
}

// ── Worktree: folder and prefix ──────────────────────────────────────────

function WorktreesBlock() {
  const [prefs, update] = usePrefs()
  const [draft, setDraft] = useState<string | null>(null)
  if (!prefs) return null
  const shown = draft ?? prefs.branchPrefix
  const cleaned = cleanBranchPrefix(shown)
  // cleanBranchPrefix falls back to the default if the value is invalid: we say so instead of saving something else.
  const invalid = shown.trim() !== '' && cleaned !== shown.trim()
  const commit = () => {
    if (draft === null) return
    if (!invalid && cleaned !== prefs.branchPrefix) update({ branchPrefix: cleaned })
    if (!invalid) setDraft(null)
  }
  const choose = async () => {
    const path = await system.pickFolder()
    if (path) update({ worktreesDir: path })
  }
  return (
    <SettingsBlock id="worktrees-title" title={t('Worktrees')} description={t('A worktree is a separate copy of the project for one session, on its own branch. These apply to new ones; existing worktrees stay where they are.')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t('Folder')} hint={prefs.worktreesDir ? undefined : t('Default: ~/Developer/.ladder/worktrees, or ~/.ladder/worktrees without a Developer folder')}>
          <span className="max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={prefs.worktreesDir ?? undefined}>
            {prefs.worktreesDir ?? t('Default location')}
          </span>
          <button type="button" onClick={() => void choose()} className={settingsButton}>
            <FolderOpen aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
            {t('Choose…')}
          </button>
          {prefs.worktreesDir && (
            <button type="button" onClick={() => update({ worktreesDir: null })} className={settingsButton}>
              {t('Use default')}
            </button>
          )}
        </SettingRow>
        <SettingRow
          label={t('Branch prefix')}
          hint={t('New branches are named {example}.', { example: `${invalid ? DEFAULT_BRANCH_PREFIX : cleaned}fix-login` })}
          warning={invalid ? t('Not a valid prefix for a git branch. Use letters, digits, dots, dashes and slashes, for example “{example}”.', { example: 'nico/' }) : null}
        >
          <input
            value={shown}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            aria-label={t('Branch prefix')}
            aria-invalid={invalid || undefined}
            placeholder={DEFAULT_BRANCH_PREFIX}
            spellCheck={false}
            autoComplete="off"
            className={`${settingsField} w-[160px] font-mono`}
          />
        </SettingRow>
      </div>
    </SettingsBlock>
  )
}

// ── Worktree: per project ─────────────────────────────────────────────────

function ProjectWorktreeBlock() {
  const projects = useApp((s) => s.projects).filter((p) => p.isGit)
  const selectedId = useApp((s) => s.selection.projectId)
  const [chosen, setChosen] = useState<string | null>(null)
  const project = projects.find((p) => p.id === chosen) ?? projects.find((p) => p.id === selectedId) ?? projects[0] ?? null
  return (
    <SettingsBlock id="project-worktree-title" title={t('Worktrees of a project')} description={t('Script, wait and files for new worktrees of one project. Saved in .ladder/settings.local.toml: personal, and kept out of git.')}>
      {projects.length === 0 || !project ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('Add a git project to set these.')}</p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm font-medium">{t('Project')}</span>
            <Select value={project.id} onValueChange={(value) => setChosen(String(value))}>
              <SelectTrigger aria-label={t('Project')} className="w-[240px]">
                <SelectValue>{(value: string) => projects.find((p) => p.id === value)?.name ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ProjectWorktreeFields key={project.id} project={project} />
        </>
      )}
    </SettingsBlock>
  )
}

function ProjectWorktreeFields({ project }: { project: Project }) {
  const fromFile = useProjectSettings(project)
  // Last host response to a save: valid until the project is reread.
  const [saved, setSaved] = useState<ProjectSettings | null>(null)
  useEffect(() => setSaved(null), [fromFile])
  const settings = saved ?? fromFile
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<WorktreeFiles | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)

  const loadFiles = useMemo(
    () => () => {
      setFilesError(null)
      request<WorktreeFiles>({ type: 'project.worktreeFiles', projectId: project.id })
        .then(setFiles)
        .catch((e: Error) => setFilesError(e.message))
    },
    [project.id]
  )
  useEffect(loadFiles, [loadFiles])

  // Queued saves: one at a time, so none starts from an outdated list. `latest` is the host's last response
  // (or the last read of the file): service lists are built on that, never on an old copy.
  const latest = useRef<ProjectSettings | null>(settings)
  useEffect(() => {
    if (fromFile) latest.current = fromFile
  }, [fromFile])
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job)
    queue.current = run.catch(() => undefined)
    return run
  }
  const send = async (patch: WorktreeSettingsPatch) => {
    const next = await request<ProjectSettings>({ type: 'project.worktree.set', projectId: project.id, patch })
    latest.current = next
    setSaved(next)
    // The folders to copy change the preview.
    if (patch.copy) loadFiles()
  }
  const save = (patch: WorktreeSettingsPatch) => {
    setError(null)
    return enqueue(() => send(patch)).catch((e: Error) => setError(e.message))
  }
  /** Changes the personal list of services: `change` receives the host's current one and returns the new one, which is sent in full. Null = ok, otherwise the error. */
  const saveServices = (change: (personal: PersonalService[]) => PersonalService[]): Promise<string | null> => {
    setError(null)
    return enqueue(async () => {
      const current = latest.current?.worktree.personalServices
      if (!current) throw new Error(t('Reading the project settings…'))
      await send({ services: change(current.map((entry) => ({ ...entry }))) })
    }).then(
      () => null,
      (e: Error) => e.message
    )
  }

  if (!settings) return <p className="mt-3 text-sm text-muted-foreground">{t('Reading the project settings…')}</p>
  const wait = settings.worktree.setupWait
  return (
    <div className="mt-3 flex flex-col gap-5">
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        <ScriptRow
          key={`setup-${settings.worktree.setup ?? ''}`}
          label={t('Setup script')}
          hint={t('Runs in a “setup” terminal when a worktree is created, with LADDER_PORT set. For example install dependencies.')}
          placeholder="pnpm install"
          value={settings.worktree.setup}
          onSave={(setup) => save({ setup })}
        />
        <ScriptRow
          key={`archive-${settings.worktree.archive ?? ''}`}
          label={t('Cleanup script')}
          hint={t('Runs when a session with a worktree is archived.')}
          placeholder="docker compose down"
          value={settings.worktree.archive}
          onSave={(archive) => save({ archive })}
        />
      </div>

      <ServicesBlock services={settings.worktree.services} onChange={saveServices} />

      <div>
        <h4 className="text-sm font-medium">
          {t('When the setup script runs')}
        </h4>
        <ChoiceGroup
          label={t('When the setup script runs')}
          value={wait ? 'wait' : 'now'}
          choices={[
            { id: 'now', label: t('The session starts right away'), hint: t('The script runs alongside the first message.') },
            { id: 'wait', label: t('Wait for the script'), hint: t('The first message goes out when the script is done.') }
          ]}
          onChange={(value) => void save({ setupWait: value === 'wait' })}
          minWidth={260}
        />
        {!settings.worktree.setup && <p className="mt-2 text-xs text-muted-foreground">{t('Without a setup script this changes nothing yet.')}</p>}
      </div>

      <FilesPreview key={settings.worktree.copy.join('\n')} settings={settings} files={files} error={filesError} onSaveCopy={(copy) => save({ copy })} />
      {error && <Outcome tone="error">{error}</Outcome>}
    </div>
  )
}

/** Script field: saved on blur; empty = no script. */
function ScriptRow({ label, hint, placeholder, value, onSave }: { label: string; hint: string; placeholder: string; value: string | null; onSave: (value: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? '')
  const commit = () => {
    const next = draft.trim() === '' ? null : draft.trim()
    if (next !== value) onSave(next)
  }
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`${settingsField} w-full font-mono`}
      />
    </div>
  )
}

const FILES_SHOWN = 12

/** What is copied from the main checkout into a new worktree: rules from .worktreeinclude (or `.env*`), files found and extra paths. */
function FilesPreview({ settings, files, error, onSaveCopy }: { settings: ProjectSettings; files: WorktreeFiles | null; error: string | null; onSaveCopy: (copy: string[]) => void }) {
  const [extra, setExtra] = useState(settings.worktree.copy.join('\n'))
  const commitExtra = () => {
    const next = extra
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (next.join('\n') !== settings.worktree.copy.join('\n')) onSaveCopy(next)
  }
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{t('Files copied into a new worktree')}</h4>
      <p className="max-w-[62ch] text-xs text-muted-foreground">
        {t('Ignored files like .env that a fresh checkout doesn’t have. List them in a .worktreeinclude file at the project root, with the same syntax as .gitignore; only files git ignores are copied. node_modules is never copied.')}
      </p>
      <div className="rounded-lg border border-border px-4 py-3" aria-live="polite">
        {error ? (
          <Outcome tone="error">{error}</Outcome>
        ) : !files ? (
          <p className="text-xs text-muted-foreground">{t('Looking for files…')}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {files.source === 'file' ? t('From .worktreeinclude') : t('No .worktreeinclude file: copying .env* files')}
              {files.patterns.length > 0 && <span className="font-mono"> · {files.patterns.join(' ')}</span>}
            </p>
            {files.files.length === 0 ? (
              <p className="mt-2 text-sm">{t('Nothing would be copied.')}</p>
            ) : (
              <>
                <p className="mt-2 text-sm font-medium">{plural(files.files.length, '{n} file would be copied', '{n} files would be copied')}</p>
                <ul className="mt-1 flex flex-col font-mono text-xs text-muted-foreground">
                  {files.files.slice(0, FILES_SHOWN).map((file) => (
                    <li key={file} className="truncate leading-5">
                      {file}
                    </li>
                  ))}
                </ul>
                {files.files.length > FILES_SHOWN && <p className="mt-1 text-xs text-faint">{t('and {n} more', { n: files.files.length - FILES_SHOWN })}</p>}
              </>
            )}
          </>
        )}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('More paths to copy')}</span>
        <span className="text-xs text-muted-foreground">{t('One per line, relative to the project root. Added to the list above.')}</span>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onBlur={commitExtra}
          rows={3}
          spellCheck={false}
          placeholder={'config/local.json'}
          className="min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </label>
    </div>
  )
}
