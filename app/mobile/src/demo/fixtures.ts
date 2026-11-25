// Realistic sample data: projects in sections, sessions in every state, chats with tools, requests and questions.
// They feed the app's demo mode (also in production: it is the one for App Review) and the e2e harness.
// Type imports only: it also runs with `node` without aliases.
import type { AgentStatus, ChatItem, Project, ProjectGroupsState, ProjectUiState, RemoteProfile, RemoteProjectDefaults, SessionSummary, SubagentInfo, PermissionLevel, UsageWindow } from '@shared/protocol'
import { Conv } from './conv.ts'

const MIN = 60_000

export interface Fixture {
  macName: string
  /** Mac theme: in the fixtures it is Circuit (the channel doesn't carry it yet). */
  macTheme: string
  projects: Project[]
  sessions: SessionSummary[]
  ui: Record<string, Pick<ProjectUiState, 'groups' | 'groupOf' | 'seenAt'>>
  projectGroups: ProjectGroupsState
  agents: AgentStatus[]
  /** Claude Code and Codex accounts (subscriptions). */
  profiles: RemoteProfile[]
  /** How a new session starts, per project. */
  defaults: Record<string, RemoteProjectDefaults>
  items: Record<string, ChatItem[]>
  subagents: Record<string, SubagentInfo[]>
  /** Maximum permission per project: today the remote snapshot doesn't carry it, the fixtures do to show the disabled levels. */
  permissionMax: Record<string, PermissionLevel>
}

/** Usage limits window: 5 hours or weekly, with the reset in `inMin` minutes. */
const usageWindow = (key: string, minutes: number, percent: number, inMin: number, now: number, state: UsageWindow['state'] = 'ok'): UsageWindow => ({
  key,
  minutes,
  model: null,
  percent,
  resetsAt: Math.floor((now + inMin * MIN) / 1000),
  state
})

const buildAgents = (now: number): AgentStatus[] => [
  {
    agent: 'claude-code',
    name: 'Claude Code',
    kind: 'native',
    available: true,
    version: '2.1.0',
    account: 'Claude Max',
    models: [
      { id: 'claude-opus-4-7', label: 'Opus 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: true, defaultEffort: 'high' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high'] }
    ],
    error: null,
    usage: [usageWindow('five_hour', 300, 62, 135, now), usageWindow('seven_day', 10_080, 34, 3 * 24 * 60 + 200, now)],
    usageAt: now - 3 * MIN
  },
  {
    agent: 'claude-code',
    profileId: 'p-work',
    name: 'Claude Code',
    kind: 'native',
    available: true,
    version: '2.1.0',
    account: 'Claude Team',
    models: [
      { id: 'claude-opus-4-7', label: 'Opus 4.7', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'high' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high'] }
    ],
    error: null,
    usage: [usageWindow('five_hour', 300, 18, 250, now), usageWindow('seven_day', 10_080, 9, 5 * 24 * 60, now)],
    usageAt: now - 11 * MIN
  },
  {
    agent: 'codex',
    name: 'Codex',
    kind: 'native',
    available: true,
    version: '0.9.0',
    account: 'ChatGPT Pro',
    models: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' }],
    error: null,
    usage: [usageWindow('primary', 300, 12, 190, now), usageWindow('secondary', 10_080, 8, 4 * 24 * 60, now)],
    usageAt: now - 6 * MIN
  },
  { agent: 'acp:gemini-cli', name: 'Gemini CLI', kind: 'acp', available: true, version: '1.4.0', account: null, models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro', isDefault: true }], error: null }
]

const profiles: RemoteProfile[] = [
  { id: 'default:claude-code', agent: 'claude-code', name: 'Personal', isDefault: true },
  { id: 'p-work', agent: 'claude-code', name: 'Work', isDefault: false },
  { id: 'default:codex', agent: 'codex', name: 'Default', isDefault: true }
]

export function buildFixture(now = Date.now()): Fixture {
  const project = (id: string, name: string, branch: string): Project => ({ id, name, path: `/Users/dev/Developer/${name}`, branch, isGit: true, addedAt: now - 90 * 24 * 60 * MIN })
  const projects = [
    project('p-web', 'acme-web', 'feat/payments-filters'),
    project('p-api', 'acme-api', 'main'),
    project('p-ds', 'design-system', 'main'),
    project('p-ladder', 'ladder', 'm6/remote'),
    project('p-dots', 'dotfiles', 'main'),
    project('p-archive', 'blog-2024', 'main'),
    project('p-notes', 'notes', 'main')
  ]

  const agents = buildAgents(now)
  const items: Record<string, ChatItem[]> = {}
  const sessions: SessionSummary[] = []
  const subagents: Record<string, SubagentInfo[]> = {}

  const base = (id: string, projectId: string, title: string, patch: Partial<SessionSummary>): SessionSummary => ({
    id,
    projectId,
    title,
    titleSource: 'generated',
    agent: 'claude-code',
    model: 'claude-opus-4-7',
    effort: 'high',
    permission: 'ask',
    createdAt: now - 3 * 24 * 60 * MIN,
    updatedAt: now - 60 * MIN,
    run: 'idle',
    waitingLabel: null,
    activity: null,
    unread: false,
    lastReadSeq: 0,
    archived: false,
    queue: [],
    context: { used: 42_000, window: 200_000 },
    mode: 'chat',
    cwd: `/Users/dev/Developer/${projects.find((p) => p.id === projectId)!.name}`,
    worktree: null,
    command: null,
    terminalId: null,
    estimated: false,
    waitingSince: null,
    request: null,
    openRequests: 0,
    activityAt: now - 60 * MIN,
    canSteer: true,
    branch: null,
    pr: null,
    source: null,
    ...patch
  })
  const add = (s: SessionSummary, conv: Conv, agoMs: number) => {
    const list = conv.shiftTo(now, agoMs)
    items[s.id] = list
    const lastSeq = list.length ? Math.max(...list.map((i) => i.seq)) : 0
    const open = list.filter((i) => i.kind === 'request' && i.state === 'open')
    const request = (open[0] as SessionSummary['request']) ?? null
    sessions.push({ ...s, lastReadSeq: s.unread ? lastSeq - 2 : lastSeq, request, openRequests: open.length, ...(open.length && !s.waitingSince ? { waitingSince: open[0].at } : {}) })
  }

  // 1. Running (Claude): one finished turn and one open with the test running.
  {
    const c = new Conv('s1')
    c.turn().user('The payments table loses its filter when I change page. Can you find out why?')
    c.tool('read', 'Read', 'Reads src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx')
    c.tool('read', 'Read', 'Reads src/features/payments/useTableFilters.ts', 'src/features/payments/useTableFilters.ts')
    c.tool('search', 'Grep', 'Searches for setPage', 'setPage', { output: '4 matches' })
    c.tool('edit', 'Edit', 'Edits src/features/payments/useTableFilters.ts', 'src/features/payments/useTableFilters.ts')
    c.tool('edit', 'Edit', 'Edits src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx')
    c.tool('command', 'Bash', 'Runs pnpm typecheck', 'pnpm typecheck', { output: 'Found 0 errors.' })
    c.assistant(
      'The page change was resetting the filter state because `setPage` rebuilt the query object without the current `status` filter.\n\nI moved the filters into `useTableFilters` and made the page a separate part of the URL state:\n\n- `PaymentsTable.tsx` now reads filters from the hook\n- `useTableFilters.ts` keeps `status` and `range` when the page changes\n\nTypecheck passes.',
      false,
      6_000
    )
    c.end({ durationMs: 74_000, files: [{ path: 'src/features/payments/useTableFilters.ts', added: 18, removed: 6, status: 'M' }, { path: 'src/features/payments/PaymentsTable.tsx', added: 7, removed: 9, status: 'M' }] })
    c.turn().user('Now add a regression test for it and run the suite.')
    c.tool('read', 'Read', 'Reads src/features/payments/PaymentsTable.test.tsx', 'src/features/payments/PaymentsTable.test.tsx')
    c.tool('edit', 'Edit', 'Edits src/features/payments/PaymentsTable.test.tsx', 'src/features/payments/PaymentsTable.test.tsx')
    c.tool('command', 'Bash', 'Runs pnpm test PaymentsTable', 'pnpm test PaymentsTable', { status: 'running' })
    c.assistant('I added a test that changes the page with the `Overdue` filter active and checks the filter is still applied. Running the suite now', true, 3_000)
    add(base('s1', 'p-web', 'Fix payments table filters', { run: 'running', activity: 'Runs pnpm test PaymentsTable', branch: 'feat/payments-filters', activityAt: now - 20_000, updatedAt: now - 20_000, permission: 'edit' }), c, 10_000)
  }

  // 2. Waiting: permission for a command.
  {
    const c = new Conv('s2')
    c.turn().user('Add a CSV export button to the payments table.')
    c.tool('read', 'Read', 'Reads src/features/payments/PaymentsTable.tsx', 'src/features/payments/PaymentsTable.tsx')
    c.tool('search', 'Grep', 'Searches for papaparse', 'papaparse', { output: 'No matches' })
    c.assistant('There is no CSV library in the project. I would use `papaparse`: it is small and handles quoting and unicode correctly. I need to install it first.', false, 3_000)
    c.permission({
      toolName: 'Bash',
      title: 'Run a command',
      command: 'pnpm add papaparse && pnpm add -D @types/papaparse',
      reason: 'Install papaparse to generate the CSV file',
      rule: 'pnpm add'
    })
    add(base('s2', 'p-web', 'Add CSV export', { run: 'waiting', waitingLabel: 'Approval', waitingSince: now - 12 * MIN, activityAt: now - 12 * MIN, updatedAt: now - 12 * MIN, branch: 'feat/csv-export' }), c, 12 * MIN)
  }

  // 3. To read: finished reply with list and code.
  {
    const c = new Conv('s3')
    c.turn().user('Refactor the auth middleware so it no longer depends on the session object.')
    c.tool('read', 'Read', 'Reads src/middleware/auth.ts', 'src/middleware/auth.ts')
    c.tool('read', 'Read', 'Reads src/middleware/auth.test.ts', 'src/middleware/auth.test.ts')
    c.tool('edit', 'Edit', 'Edits src/middleware/auth.ts', 'src/middleware/auth.ts')
    c.tool('edit', 'Edit', 'Edits src/middleware/auth.test.ts', 'src/middleware/auth.test.ts')
    c.tool('command', 'Bash', 'Runs pnpm test auth', 'pnpm test auth', { output: '8 passed' })
    c.tool('command', 'Bash', 'Runs pnpm lint', 'pnpm lint', { output: 'No problems found' })
    c.tool('command', 'Bash', 'Runs pnpm typecheck', 'pnpm typecheck')
    c.assistant(
      'Done. The middleware now takes a `TokenReader` instead of the whole session:\n\n```ts\nexport function auth(read: TokenReader): Middleware {\n  return async (req, next) => {\n    const token = await read(req)\n    if (!token) return unauthorized()\n    return next({ ...req, user: token.sub })\n  }\n}\n```\n\n**What changed**\n\n1. `auth.ts` no longer imports `Session`\n2. Tests use a fake reader, so they run without a database\n3. Behaviour is unchanged: 8 tests pass, lint and typecheck are clean',
      false,
      8_000
    )
    c.end({ durationMs: 131_000, files: [{ path: 'src/middleware/auth.ts', added: 22, removed: 31, status: 'M' }, { path: 'src/middleware/auth.test.ts', added: 40, removed: 28, status: 'M' }] })
    add(base('s3', 'p-web', 'Refactor auth middleware', { unread: true, activityAt: now - 25 * MIN, updatedAt: now - 25 * MIN, model: 'claude-sonnet-4-6' }), c, 25 * MIN)
  }

  // 4. Idle, old.
  {
    const c = new Conv('s4')
    c.turn().user('Move the colour tokens to CSS variables so we can do a dark mode.')
    c.tool('edit', 'Edit', 'Edits src/theme/tokens.ts', 'src/theme/tokens.ts')
    c.assistant('Tokens are now CSS variables with a `[data-theme="dark"]` override.', false, 4_000)
    c.end({ durationMs: 42_000, files: [{ path: 'src/theme/tokens.ts', added: 31, removed: 12, status: 'M' }] })
    add(base('s4', 'p-web', 'Dark mode tokens', { activityAt: now - 2 * 24 * 60 * MIN, updatedAt: now - 2 * 24 * 60 * MIN }), c, 2 * 24 * 60 * MIN)
  }

  // 5. Waiting: question with two items (Codex).
  {
    const c = new Conv('s5')
    c.turn().user('Migrate the invoices table to Postgres 17 and keep the old one readable for a week.')
    c.tool('read', 'Read', 'Reads db/schema.sql', 'db/schema.sql')
    c.tool('search', 'Grep', 'Searches for invoices', 'invoices', { output: '23 matches in 9 files' })
    c.assistant('Before I write the migration I need two decisions.', false, 3_000)
    c.question([
      {
        header: 'Strategy',
        question: 'How should I run the migration?',
        multiSelect: false,
        options: [
          { label: 'Dual write', description: 'Write to both tables for a week, then drop the old one.' },
          { label: 'Backfill and switch', description: 'Copy existing rows, then switch reads in one release.' }
        ]
      },
      {
        header: 'Checks',
        question: 'Which checks should run before the switch?',
        multiSelect: true,
        options: [
          { label: 'Row counts', description: 'Compare counts per month.' },
          { label: 'Checksums', description: 'Hash a sample of rows.' },
          { label: 'Shadow reads', description: 'Read from both and log differences.' }
        ]
      }
    ])
    add(base('s5', 'p-api', 'Migrate invoices to Postgres 17', { run: 'waiting', waitingLabel: 'Question', agent: 'codex', model: 'gpt-5.5-codex', effort: 'medium', waitingSince: now - 4 * MIN, activityAt: now - 4 * MIN, updatedAt: now - 4 * MIN, permission: 'edit' }), c, 4 * MIN)
  }

  // 6. Error.
  {
    const c = new Conv('s6')
    c.turn().user('Add rate limiting to the login endpoint: 5 attempts per minute per IP.')
    c.tool('read', 'Read', 'Reads src/routes/login.ts', 'src/routes/login.ts')
    c.tool('edit', 'Edit', 'Edits src/routes/login.ts', 'src/routes/login.ts')
    c.tool('command', 'Bash', 'Runs pnpm test login', 'pnpm test login', { status: 'error', output: 'Error: connect ECONNREFUSED 127.0.0.1:6379' })
    c.end({ durationMs: 58_000, status: 'error', error: 'The agent stopped: Redis is not reachable at 127.0.0.1:6379.', files: [{ path: 'src/routes/login.ts', added: 14, removed: 2, status: 'M' }] })
    add(base('s6', 'p-api', 'Rate limit login', { run: 'error', activityAt: now - 47 * MIN, updatedAt: now - 47 * MIN }), c, 47 * MIN)
  }

  // 7. Queued (queued message).
  {
    const c = new Conv('s7')
    c.turn().user('Bump all dependencies to the latest minor.')
    c.tool('command', 'Bash', 'Runs pnpm update', 'pnpm update', { output: '14 packages updated' })
    c.assistant('Updated 14 packages. The lockfile changed; tests still pass.', false, 3_000)
    c.end({ durationMs: 88_000 })
    add(base('s7', 'p-api', 'Bump dependencies', { queue: [{ id: 'q1', text: 'Then run the e2e suite and tell me what fails.' }], activityAt: now - 3 * 60 * MIN, updatedAt: now - 3 * 60 * MIN }), c, 3 * 60 * MIN)
  }

  // 8. Design system, idle.
  {
    const c = new Conv('s8')
    c.turn().user('Document the Button variants in Storybook.')
    c.tool('edit', 'Write', 'Writes src/Button/Button.stories.tsx', 'src/Button/Button.stories.tsx')
    c.assistant('Added stories for primary, secondary, ghost and destructive, with the disabled and loading states.', false, 3_000)
    c.end({ durationMs: 51_000, files: [{ path: 'src/Button/Button.stories.tsx', added: 64, removed: 0, status: 'A' }] })
    add(base('s8', 'p-ds', 'Button variants stories', { activityAt: now - 26 * 60 * MIN, updatedAt: now - 26 * 60 * MIN }), c, 26 * 60 * MIN)
  }

  // 9. Ladder: running (Codex) with two subagents.
  {
    const c = new Conv('s9')
    c.turn().user('Wire the Expo app to the remote channel: handshake, hello and reconnection.')
    c.tool('read', 'Read', 'Reads app/desktop/src/shared/remote/session.ts', 'app/desktop/src/shared/remote/session.ts')
    c.tool('agent', 'Task', 'Explore the reconnection edge cases', null, { status: 'running' })
    c.tool('command', 'Bash', 'Runs pnpm --filter @ladder/mobile typecheck', 'pnpm --filter @ladder/mobile typecheck', { status: 'running' })
    c.assistant('The handshake goes through `clientHandshake`; I am checking what happens when the Mac closes the socket mid-frame', true, 4_000)
    add(
      base('s9', 'p-ladder', 'Mobile app: remote client', { run: 'running', activity: 'Runs pnpm --filter @ladder/mobile typecheck', agent: 'codex', model: 'gpt-5.5-codex', effort: 'high', activityAt: now - 8_000, updatedAt: now - 8_000, permission: 'edit', canSteer: true, subagentCounts: { total: 2, running: 2, runningForeground: 2, error: 0 } }),
      c,
      8_000
    )
    subagents.s9 = [
      { id: 'sa1', parentId: null, title: 'Explore the reconnection edge cases', kind: 'Explore', model: null, status: 'running', startedAt: now - 90_000, endedAt: null, activity: 'Reads gateway.ts', tokens: 12_400, toolUses: 6, background: false },
      { id: 'sa2', parentId: null, title: 'Check Hermes support for TextDecoder', kind: 'general-purpose', model: null, status: 'running', startedAt: now - 60_000, endedAt: null, activity: 'Searches the Hermes docs', tokens: 8_100, toolUses: 3, background: false }
    ]
  }

  // 10. Ladder: waiting with edit and preview.
  {
    const c = new Conv('s10')
    c.turn().user('Write the release notes for 0.1.4 in CHANGELOG.md.')
    c.tool('read', 'Read', 'Reads CHANGELOG.md', 'CHANGELOG.md')
    c.tool('command', 'Bash', 'Runs git log v0.1.3..HEAD --oneline', 'git log v0.1.3..HEAD --oneline', { output: '11 commits' })
    c.assistant('I have the list of changes since 0.1.3. Here is the entry I would add at the top of the changelog.', false, 4_000)
    c.permission({
      toolName: 'Edit',
      title: 'Edit a file',
      path: 'CHANGELOG.md',
      reason: 'Add the 0.1.4 section',
      rule: 'Edit',
      preview: '  # Changelog\n+ ## 0.1.4\n+\n+ - Agents show as a list by default\n+ - Grok Build joins the curated agents\n+ - Sign-in methods are listed for each agent\n+\n  ## 0.1.3\n- - Sidebar footer\n+ - Simpler sidebar footer'
    })
    add(base('s10', 'p-ladder', 'Write release notes', { run: 'waiting', waitingLabel: 'Approval', waitingSince: now - 2 * MIN, activityAt: now - 2 * MIN, updatedAt: now - 2 * MIN, model: 'claude-sonnet-4-6', permission: 'ask' }), c, 2 * MIN)
  }

  // 11. Ladder: to read (ACP).
  {
    const c = new Conv('s11')
    c.turn().user('Why does the sidebar flicker when a session finishes?')
    c.tool('read', 'Read', 'Reads app-sidebar.tsx', 'app-sidebar.tsx')
    c.assistant('The row re-mounts because its `key` includes the run state. Using the session id alone keeps the DOM node and removes the flicker.', false, 5_000)
    c.end({ durationMs: 29_000 })
    add(base('s11', 'p-ladder', 'Fix sidebar flicker', { agent: 'acp:gemini-cli', model: 'gemini-3-pro', effort: null, unread: true, activityAt: now - 55 * MIN, updatedAt: now - 55 * MIN, canSteer: false }), c, 55 * MIN)
  }

  // 12-13. Idle.
  for (const [id, pid, title, ago] of [
    ['s12', 'p-dots', 'Zsh startup time', 5 * 24 * 60],
    ['s13', 'p-notes', 'Weekly review template', 6 * 60]
  ] as const) {
    const c = new Conv(id)
    c.turn().user(title)
    c.assistant('Done.', false, 3_000)
    c.end({ durationMs: 20_000 })
    add(base(id, pid, title, { activityAt: now - ago * MIN, updatedAt: now - ago * MIN }), c, ago * MIN)
  }
  // Archived: not in the snapshot, read from the project screen.
  for (const [id, pid, title, days] of [
    ['s15', 'p-web', 'Spike: Tailwind 4 migration', 12],
    ['s16', 'p-web', 'Old payments table prototype', 40]
  ] as const) {
    const c = new Conv(id)
    c.turn().user(title)
    c.assistant('Archived experiment.', false, 3_000)
    c.end({ durationMs: 30_000 })
    add(base(id, pid, title, { archived: true, activityAt: now - days * 24 * 60 * MIN, updatedAt: now - days * 24 * 60 * MIN }), c, days * 24 * 60 * MIN)
  }
  {
    const c = new Conv('s14')
    c.turn().user('Old experiment')
    c.end({ durationMs: 1_000 })
    add(base('s14', 'p-notes', 'Old experiment', { archived: true }), c, 30 * 24 * 60 * MIN)
  }

  const groupOf: Record<string, string> = { s1: 'g-pay', s2: 'g-pay', s3: 'g-pay' }
  const ui: Fixture['ui'] = {
    'p-web': { groups: [{ id: 'g-pay', name: 'Payments' }], groupOf, seenAt: now - 6 * 60 * MIN }
  }

  return {
    macName: "Zoë's MacBook Pro",
    macTheme: 'circuit',
    projects,
    sessions,
    ui,
    projectGroups: {
      groups: [
        { id: 'work', name: 'Work', collapsed: false, projectIds: ['p-web', 'p-api', 'p-ds'] },
        { id: 'side', name: 'Side projects', collapsed: false, projectIds: ['p-ladder', 'p-dots', 'p-archive'] }
      ],
      ungrouped: ['p-notes']
    },
    agents,
    profiles,
    defaults: {
      'p-web': { allowed: [], agent: 'claude-code', lastAgent: 'claude-code', launch: { 'claude-code': { model: 'claude-sonnet-4-6', effort: 'medium' }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'ask' },
      'p-api': { allowed: ['claude-code', 'codex'], agent: 'claude-code', lastAgent: 'codex', launch: { 'claude-code': { model: null, effort: null }, codex: { model: null, effort: 'high' } }, permission: 'edit' },
      'p-ds': { allowed: [], agent: 'claude-code', lastAgent: 'claude-code', launch: { 'claude-code': { model: null, effort: null }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'ask' },
      'p-ladder': { allowed: [], agent: 'codex', lastAgent: 'codex', launch: { 'claude-code': { model: 'claude-opus-4-7', effort: 'xhigh' }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'edit' },
      'p-dots': { allowed: [], agent: 'claude-code', lastAgent: null, launch: { 'claude-code': { model: null, effort: null }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'edit' },
      'p-archive': { allowed: [], agent: 'claude-code', lastAgent: null, launch: { 'claude-code': { model: null, effort: null }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'edit' },
      'p-notes': { allowed: [], agent: 'claude-code', lastAgent: 'claude-code', launch: { 'claude-code': { model: null, effort: null }, codex: { model: null, effort: null }, 'acp:gemini-cli': { model: null, effort: null } }, permission: 'edit' }
    },
    items,
    subagents,
    permissionMax: { 'p-api': 'edit', 'p-ds': 'ask' }
  }
}
