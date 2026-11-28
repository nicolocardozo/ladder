// Fake host and system to try the Workspace and Data and system sections and the request sound in the web preview:
// it answers project.settings, project.worktree.set, project.worktreeFiles and data.*, and replaces the folder and save dialogs.
import type { DataInfo, EditorAvailability, HostCommand, ProjectSettings, WorktreeEntry, WorktreeFiles, WorktreeService } from '@shared/protocol'
import { overrideSystemBridge } from '@/lib/system-bridge'
import { installOthersPreview } from './others-preview'
import { installRemotePreview } from './remote-preview'
import { emitPreviewEvent, installShortcutsHost, registerPreviewHandler } from './shortcuts-preview'

let installed = false

const DAY = 86_400_000

/** Preview of .worktreeinclude: two rules and the ignored files they find. */
const WORKTREE_FILES: WorktreeFiles = {
  source: 'file',
  patterns: ['.env*', 'apps/*/.env.local', 'certs/'],
  files: ['.env', '.env.local', 'apps/web/.env.local', 'apps/api/.env.local', 'certs/dev.pem', 'certs/dev-key.pem']
}

export function installSettingsPreview(): void {
  if (installed) return
  installed = true
  installShortcutsHost()
  installOthersPreview()
  installRemotePreview()

  // Like the host: the project file (read only) and the personal one (the list the UI rewrites in full) stay separate and
  // `services` is derived from merging them by name. A personal entry with an empty command disables the project's service of the same name.
  type ServiceEntry = { name: string; command: string; port: boolean }
  const projectServicesOf = (projectId: string): ServiceEntry[] =>
    projectId === 'api' ? [] : [{ name: 'Web', command: 'pnpm --filter web dev --port $LADDER_PORT', port: true }, { name: 'Worker', command: 'pnpm worker', port: false }]
  const personalOf = new Map<string, ServiceEntry[]>()
  const base = new Map<string, Omit<ProjectSettings, 'worktree'> & { worktree: Omit<ProjectSettings['worktree'], 'services' | 'personalServices'> }>()

  const mergeServices = (project: ServiceEntry[], personal: ServiceEntry[]): { services: WorktreeService[]; personalServices: ServiceEntry[] } => {
    const services: WorktreeService[] = project.map((from) => {
      const own = personal.find((m) => m.name === from.name)
      if (!own) return { ...from, source: 'project', disabled: false }
      if (!own.command) return { ...from, source: 'both', disabled: true, projectCommand: from.command }
      return { ...own, source: 'both', disabled: false, projectCommand: from.command }
    })
    for (const own of personal) if (own.command && !project.some((p) => p.name === own.name)) services.push({ ...own, source: 'personal', disabled: false })
    return { services, personalServices: personal }
  }

  const settingsOf = (projectId: string): ProjectSettings => {
    let found = base.get(projectId)
    if (!found) {
      found = {
        worktree: { setup: projectId === 'api' ? null : 'pnpm install && pnpm build:shared', setupWait: true, copy: [], ports: 3, archive: null },
        run: [],
        prompts: {},
        agents: {
          allowed: [],
          default: null,
          permissionsMax: null,
          // Project "api" has them off; the other starts with automatic handoff to Codex.
          autoSwitch: projectId === 'api' ? null : 'codex',
          crossReview: null,
          // Project "api" has none: the empty state with the example is shown.
          delegates:
            projectId === 'api'
              ? []
              : [
                  { name: 'reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'high', permission: 'plan', note: 'Reviews and second opinions' },
                  { name: 'researcher', agent: 'claude-code', model: null, effort: null, permission: 'plan', note: 'Reads the codebase and answers questions, never edits' }
                ]
        },
        sources: [],
        errors: []
      }
      base.set(projectId, found)
    }
    return { ...found, worktree: { ...found.worktree, ...mergeServices(projectServicesOf(projectId), personalOf.get(projectId) ?? []) } }
  }

  const now = Date.now()
  let data: DataInfo = {
    dir: '/Users/dev/Library/Application Support/Ladder',
    dbPath: '/Users/dev/Library/Application Support/Ladder/ladder.db',
    dbBytes: 48_300_000,
    backups: [{ path: '/Users/dev/Library/Application Support/Ladder/backups/ladder-20261119-091500.db', bytes: 47_900_000, at: now - 2 * DAY }]
  }

  // Worktrees on disk (Settings → Workspace): one in use, one dirty, one merged, one with commits only on its branch.
  const wt = (name: string, patch: Partial<WorktreeEntry>): WorktreeEntry => ({ path: `/Users/dev/.ladder/worktrees/acme-monorepo/${name}`, projectId: 'p-acme', projectName: 'acme-monorepo', branch: `ladder/${name}`, openSessions: [], archivedSessions: 1, busy: false, dirty: 0, unpushed: 0, merged: false, orphanCommits: 0, bytes: 1_400_000_000, ...patch })
  let worktrees: WorktreeEntry[] = [
    wt('upgrade-sdk-0f1a', { openSessions: [{ id: 's1', title: 'Upgrade the SDK' }], archivedSessions: 0, bytes: 1_493_000_000 }),
    wt('fix-login-91c2', { dirty: 3, bytes: 980_000_000 }),
    wt('delegate-api-fixes-8003', { merged: true, bytes: 2_067_000_000 }),
    wt('try-new-router-2b7e', { unpushed: 2, bytes: 1_210_000_000 })
  ]

  registerPreviewHandler((command: HostCommand) => {
    switch (command.type) {
      case 'project.settings':
        return { ok: true, data: settingsOf(command.projectId) }
      case 'project.worktree.set': {
        const { patch } = command
        let personal = personalOf.get(command.projectId) ?? []
        if (patch.services !== undefined) {
          if (patch.services.some((s) => !s.name.trim())) return { ok: false, error: 'A service needs a name.' }
          // Repeated name: the last entry wins, in the position of the first.
          const byName = new Map<string, ServiceEntry>()
          for (const s of patch.services) byName.set(s.name.trim(), { name: s.name.trim(), command: s.command.trim(), port: s.port !== false })
          personal = [...byName.values()]
          personalOf.set(command.projectId, personal)
        }
        const current = settingsOf(command.projectId)
        base.set(command.projectId, {
          ...current,
          worktree: {
            setup: patch.setup !== undefined ? patch.setup || null : current.worktree.setup,
            setupWait: patch.setupWait ?? current.worktree.setupWait,
            copy: patch.copy ?? current.worktree.copy,
            ports: current.worktree.ports,
            archive: patch.archive !== undefined ? patch.archive || null : current.worktree.archive
          }
        })
        const next = settingsOf(command.projectId)
        // For tests: what the interface sent, in order.
        const w = window as unknown as { __worktreeSets?: unknown[] }
        ;(w.__worktreeSets ??= []).push({ projectId: command.projectId, patch, personalServices: next.worktree.personalServices })
        return { ok: true, data: next }
      }
      case 'project.agents.set': {
        const current = settingsOf(command.projectId)
        // With «acp:gemini» the host rejects (agent not allowed), to see the error next to the control.
        if (command.patch.autoSwitch === 'acp:gemini' || command.patch.crossReview === 'acp:gemini') return { ok: false, error: 'Gemini is not allowed in this project.' }
        base.set(command.projectId, { ...current, agents: { ...current.agents, ...command.patch } })
        return { ok: true, data: settingsOf(command.projectId) }
      }
      case 'project.worktreeFiles': {
        const extra = settingsOf(command.projectId).worktree.copy
        return { ok: true, data: { ...WORKTREE_FILES, files: [...WORKTREE_FILES.files, ...extra.filter((f) => !WORKTREE_FILES.files.includes(f))] } }
      }
      case 'worktrees.list':
        return { ok: true, data: worktrees }
      case 'worktrees.remove': {
        // A worktree with commits only on its branch is removed too (the branch stays); one in use or dirty is refused.
        const removed: string[] = []
        const failed: { path: string; error: string }[] = []
        for (const path of command.paths) {
          const w = worktrees.find((x) => x.path === path)
          if (!w || w.openSessions.length || w.dirty) failed.push({ path, error: w?.dirty ? 'It has uncommitted files: commit or discard them first.' : 'A session or a plan still uses it: archive the session first.' })
          else removed.push(path)
        }
        worktrees = worktrees.filter((w) => !removed.includes(w.path))
        return { ok: true, data: { removed, failed } }
      }
      case 'data.info':
        return { ok: true, data }
      case 'data.backup': {
        const stampNow = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const name = `ladder-${stampNow.getFullYear()}${pad(stampNow.getMonth() + 1)}${pad(stampNow.getDate())}-${pad(stampNow.getHours())}${pad(stampNow.getMinutes())}${pad(stampNow.getSeconds())}.db`
        const path = command.to ?? `${data.dir}/backups/${name}`
        if (!command.to) data = { ...data, backups: [{ path, bytes: data.dbBytes, at: Date.now() }, ...data.backups] }
        return { ok: true, data: { path, bytes: data.dbBytes } }
      }
      case 'data.openFolder':
        return { ok: true, data: null }
      default:
        return undefined
    }
  })

  const editors: EditorAvailability = { cursor: true, vscode: true, zed: false, xcode: true }
  overrideSystemBridge({
    editors: async () => editors,
    pickFolder: async () => '/Users/dev/Worktrees',
    pickSavePath: async (name) => `/Users/dev/Documents/${name}`,
    playSound: async () => true,
    testNotification: async () => true
  })
}

/** Simulates the automatic archiving of three idle sessions (host event). */
export function emitAutoArchived(): void {
  emitPreviewEvent({ type: 'sessions.autoArchived', sessionIds: ['a', 'b', 'c'] })
}
