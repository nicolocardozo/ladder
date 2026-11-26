// Chat preview without Electron: pnpm dev:web and then http://localhost:5199/preview.html
import { THEMES, applyTheme, useSettings } from '@/hooks/use-theme'
import '@shared/locales/it'
import { LOCALES, isLocale, plural, setLocale, type Locale } from '@shared/i18n'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/mona-sans/wght.css'
import '@fontsource/monaspace-neon/400.css'
import '@fontsource/monaspace-neon/500.css'
import '@fontsource/monaspace-neon/600.css'
import './styles/globals.css'
import type { Attachment, ChatItem, PermissionLevel, QueuedMessage, RequestResponse } from '@shared/protocol'
import { ChatView, type ChatAnchor } from './components/chat/chat-view'
import { Composer } from './components/composer'
import { seedProjectFiles } from './components/composer/file-index'
import { TooltipProvider } from './components/ui/tooltip'
import {
  agentsFixture,
  agentsGraphFixture,
  PREVIEW_CLAUDE_WORK,
  PREVIEW_PROFILES,
  connectionScenario,
  previewUsage,
  previewProfileAgents,
  previewProfileConnections,
  agentsFinishedFixture,
  agentsNoticeFixture,
  agentsWaitingFixture,
  stalledFixture,
  handoffFixture,
  adviceFixture,
  ladderChildFixture,
  ladderDelegateFixture,
  ladderHandoffFixture,
  handoffResumeFixture,
  resumeFixture,
  limitFixture,
  reviewFixture,
  planFixture,
  implementFixture,
  HANDOFF_FILES,
  HANDOFF_SUMMARY,
  previewSubagentDetail,
  busyFixture,
  commandFixture,
  largeFixture,
  normalFixture,
  previewCommands,
  previewProjectFiles,
  questionFixture,
  requestFixture,
  STREAM_TEXT,
  streamingBase,
  type Fixture
} from './dev/fixtures'
import { AgentCatalogPreview } from './dev/agent-catalog-preview'
import { PLAN_SCENARIOS, planFixture as executablePlanFixture, type PlanScenario } from './dev/plan-fixtures'
import { installPlansPreview, onPlanCreated, resetPlansPreview } from './dev/plans-preview'
import { ORIGIN_SCENARIOS, originFixture, setCliCase, type CliCase, type OriginScenario } from './dev/origin-fixtures'
import { OriginBanner, OriginMark } from './components/session-origin'
import { CommandPalette } from './components/command-palette'
import { PlanTaskBanner } from './components/plan-task-banner'
import { PlanTaskMark } from './components/chat/plan-bits'
import { ConnectionsPreview } from './dev/connections-preview'
import { TerminalsPreview } from './dev/terminals-preview'
import { installHandoffPreview } from './dev/handoff-preview'
import { installAdvicePreview } from './dev/advice-preview'
import { installAgentFlowPreview, type AgentFlowSink } from './dev/agent-flow-preview'
import { AdviceDialog } from './components/advice-dialog'
import { AdviceParentNote } from './components/advice-bits'
import { PlanDialog } from './components/plan-dialog'
import { runAdviceCommand } from './lib/advice'
import { HandoffDialog } from './components/handoff-dialog'
import { runHandoffCommand } from './lib/handoff'
import { installShortcutsHost } from './dev/shortcuts-preview'
import { emitAutoArchived, installSettingsPreview } from './dev/settings-preview'
import { cn } from './lib/utils'
import { onHostConnect, onHostEvent } from '@/lib/host-client'
import { SessionGlyph } from './components/status'
import { noteTone, sessionNote, sessionState } from './lib/session-state'
import { COMPACT_WIDTH, MIN_COLUMN_WIDTH } from '@/lib/use-element-width'
import { useChatFont, DEFAULT_CHAT_FONT, DEFAULT_CHAT_WIDTH } from './hooks/use-chat-font'
import { NewChat } from './components/main-views'
import { SettingsDialog } from './components/settings-dialog'
import { PhoneIndicator } from './components/top-bar-actions'
import { emitPhoneLog, emitPhonePaired, setPhoneScenario, type PhoneScenario } from './dev/remote-preview'
import { useApp } from './store/app-store'
import { allowedLevels } from './lib/agents'
import { usePermissionChange, type PermissionChangeResult } from './lib/use-permission-change'
import type { AgentStatus, AppPrefs, ChatFont, Effort, HostCommand, Project, SessionSummary, SubagentInfo } from '@shared/protocol'
import { SubagentDialog } from './components/subagent-dialog'
import { countsOf, setSubagentDetailLoader, useSubagentLists } from './lib/subagents'

applyTheme(useSettings.getState().theme)

// Preview language: ?lang=it (or en); otherwise English, like the app.
const initialLang = new URLSearchParams(location.search).get('lang')
const INITIAL_LOCALE: Locale = isLocale(initialLang) ? initialLang : 'en'
setLocale(INITIAL_LOCALE)
document.documentElement.lang = INITIAL_LOCALE

type Mode = 'normal' | 'large' | 'stream' | 'request' | 'question' | 'command' | 'busy' | 'agents' | 'agents-tree' | 'agents-12' | 'agents-45' | 'agents-idle' | 'agents-errors' | 'notice-done' | 'notice-failed' | 'agents-waiting' | 'finished-states' | 'stalled' | 'handoff-out' | 'handoff-in' | 'handoff-summarizing' | 'advice' | 'plan' | 'implement-out' | 'implement-in' | 'ladder-handoff' | 'ladder-handoff-in' | 'ladder-delegate' | 'ladder-child' | 'handoff-resume' | 'ladder-resume' | 'limit' | 'review' | 'exec-plan'

/** Modes with sessions on the other side (handoff, advice, plan): the "Open" links and the current agent are read from the store. */
const withPeers = (mode: Mode) => mode.startsWith('handoff') || mode === 'advice' || mode === 'plan' || mode.startsWith('implement') || mode.startsWith('ladder') || mode === 'limit' || mode === 'review'

// Fake session with a hundred sub-agents: the board, the popover and the dialog read from here as in the app.
const PREVIEW_SESSION = 'preview-agents'
const ADVICE_PREVIEW_A = '**In short**: the direction is right. Two points: the `pageCount === 0` case and the query string name.'
const ADVICE_PREVIEW_B = 'I agree. Update the `PaymentsTable` tests in the same commit too.'
setSubagentDetailLoader(
  (_sessionId, id) =>
    new Promise((resolve) => window.setTimeout(() => resolve(previewSubagentDetail(useSubagentLists.getState().lists[PREVIEW_SESSION] ?? [], id)), 250))
)

// The composer mentions files of this fake project: no host in the preview.
const PREVIEW_PROJECT = 'preview'
seedProjectFiles(PREVIEW_PROJECT, previewProjectFiles())

// The agent default is Opus (isDefault) with medium effort; the "Default Ladder" button moves it to Sonnet (global or per project) or removes it.
// Three composer cases: Claude Code, Codex, and an agent that declares no defaults (no isDefault, no defaultEffort, effortEffective absent: it stays "Default").
const CONTEXT_CASES = [
  { label: 'lontano dalla soglia', value: { used: 64_000, window: 200_000, compactAt: 167_000 } },
  { label: 'vicino alla soglia', value: { used: 155_000, window: 200_000, compactAt: 167_000 } },
  { label: 'oltre la soglia', value: { used: 172_000, window: 200_000, compactAt: 167_000 } },
  { label: 'compattazione off (null)', value: { used: 64_000, window: 200_000, compactAt: null } },
  { label: 'soglia ignota (assente)', value: { used: 170_000, window: 200_000 } }
]

type PreviewCase = 'claude' | 'codex' | 'unknown'
const PREVIEW_CASES: PreviewCase[] = ['claude', 'codex', 'unknown']
// Usage limits: nothing below the threshold, 85% a warning on the icon, 96% the small banner too, limit exhausted. The Work profile follows the case, the default stays low.
// 'mixed': panel with all subscriptions, sessions running on several accounts, Codex without data and Work near its limit.
type UsageCase = 'below' | '85%' | '96%' | 'limited' | 'mixed'
const USAGE_CASES: UsageCase[] = ['below', '85%', '96%', 'limited', 'mixed']
const USAGE_PERCENTS: Record<UsageCase, [number, number]> = { below: [34, 62], '85%': [85, 62], '96%': [40, 96], limited: [100, 71], mixed: [91, 62] }
/** Test session with only the fields the limits need (agent, profile, state), the rest at neutral values. */
function usageSession(id: string, agent: 'claude-code' | 'codex', profileId: string | undefined, run: SessionSummary['run'], at: number): SessionSummary {
  return {
    id, projectId: PREVIEW_PROJECT, title: id, titleSource: 'generated', agent, profileId, model: null, effort: null, permission: 'edit', createdAt: at, updatedAt: at, run,
    waitingLabel: null, activity: null, unread: false, lastReadSeq: 0, archived: false, queue: [], context: null, mode: 'chat', cwd: '/tmp/acme', worktree: null, command: null, terminalId: null,
    estimated: false, waitingSince: null, request: null, openRequests: 0, activityAt: at, canSteer: true, branch: null, pr: null, source: null
  }
}
const RUNNING_PREVIEW = [['claude-code', undefined], ['claude-code', PREVIEW_CLAUDE_WORK], ['claude-code', PREVIEW_CLAUDE_WORK], ['codex', undefined]] as const
const stripDefaults = (models: AgentStatus['models']): AgentStatus['models'] => models.map(({ isDefault: _a, defaultEffort: _b, ...m }) => m)
function previewModels(kind: PreviewCase): AgentStatus['models'] {
  const claude = PREVIEW_AGENTS[0].models.filter((m) => m.id !== 'claude-haiku-5')
  return kind === 'codex' ? PREVIEW_AGENTS[1].models : kind === 'unknown' ? stripDefaults(claude) : claude
}

// Fake store for the "New sessions" settings: agents, projects, defaults (one no longer valid) and send key.
const PREVIEW_AGENTS: AgentStatus[] = [
  {
    agent: 'claude-code',
    name: 'Claude',
    kind: 'native',
    available: true,
    version: '2.1.0',
    account: 'Claude Max',
    email: 'alex@example.com',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true, defaultEffort: 'medium' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      { id: 'claude-haiku-5', label: 'Haiku 5', efforts: [] }
    ],
    error: null
  },
  { agent: 'codex', name: 'Codex', kind: 'native', available: true, version: '0.9.0', account: 'ChatGPT Plus', email: 'alex@example.com', models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: ['low', 'medium'], defaultEffort: 'low' }
    ], error: null },
  { agent: 'acp:gemini', name: 'Gemini CLI', kind: 'acp', available: false, version: null, account: null, models: [], error: 'Command not found' }
]
const PREVIEW_PROJECTS: Project[] = [
  // The monorepo uses Claude's "Work" account for new sessions; acme-api the default.
  { id: PREVIEW_PROJECT, name: 'acme-monorepo', path: '/tmp/acme', branch: 'main', isGit: true, addedAt: 1, profiles: { 'claude-code': PREVIEW_CLAUDE_WORK } },
  { id: 'api', name: 'acme-api', path: '/tmp/api', branch: 'main', isGit: true, addedAt: 2 }
]
const PREVIEW_PREFS: AppPrefs = { notifications: true, sound: true, dndUntil: null, locale: 'en', defaults: { agent: 'claude-code', models: { 'claude-code': 'claude-sonnet-5' }, permission: 'ask' },
  // Session profiles: one read-only, one with account and worktree, one Codex and one with the agent unavailable (the fallback note shows).
  presets: [
    { id: 'preset-review', name: 'Quick review', note: 'Read only pass over a diff before merging.', agent: 'claude-code', model: 'claude-sonnet-5', effort: 'low', permission: 'plan', worktree: false },
    { id: 'preset-feature', name: 'Long feature', note: 'Plans first, then works in its own worktree.', agent: 'claude-code', profileId: PREVIEW_CLAUDE_WORK, model: 'claude-opus-5-5', effort: 'high', permission: 'edit', worktree: true, prompt: 'Read the issue, propose a plan and wait for my go before editing.' },
    { id: 'preset-codex', name: 'Codex fix', agent: 'codex', model: 'gpt-5.5-mini', effort: 'low', permission: 'ask', worktree: false },
    { id: 'preset-gemini', name: 'Gemini sketch', note: 'Rough ideas, nothing is edited.', agent: 'acp:gemini', permission: 'plan', worktree: false }
  ],
  sendKey: 'enter', busySend: 'steer', generatedTitles: true, generatedText: true, chatFont: 'system-sans', chatWidth: 'comfortable', autonomyHint: true, stallHint: false,
  chatTextSize: 'default', editorTextSize: 13, editorFont: 'system-mono', sidebarDensity: 'comfortable', editor: 'cursor', worktreesDir: null, branchPrefix: 'ladder/', autoArchiveDays: null, openAtLogin: false, keepAwake: false, soundName: 'default', userName: null }
const PREVIEW_PROFILE_CONNECTIONS = previewProfileConnections('connected')
useApp.setState({
  agents: PREVIEW_AGENTS,
  // Two Claude accounts (default and Work) and one Codex: the sidebar, composer and settings show the profile in use.
  profiles: PREVIEW_PROFILES,
  profileConnections: PREVIEW_PROFILE_CONNECTIONS,
  profileAgents: previewProfileAgents(PREVIEW_PROFILE_CONNECTIONS),
  // Connections of the three services: Settings → Subscriptions and the sidebar footer can be tried from here too.
  connections: connectionScenario('connected'),
  projects: PREVIEW_PROJECTS,
  prefs: PREVIEW_PREFS,
  // acme-api has a model the agent no longer offers and an unavailable agent: they show as invalid.
  ui: { api: { tabs: [], activeTab: null, scroll: {}, defaults: { agent: 'acp:gemini', models: { 'claude-code': 'claude-opus-4-old' }, efforts: { 'claude-code': 'max' } } } }
})

// Fake plans host: answers the plan.* commands and advances tasks. The port arrives asynchronously, before the first click.
installPlansPreview()

const INITIAL_QUEUE: QueuedMessage[] = [
  { id: 'q1', text: 'Poi aggiorna anche le storie di Storybook della paginazione.' },
  {
    id: 'q2',
    text: 'Controlla che il layout regga a 320 px come negli screenshot.',
    attachments: [
      { name: 'mobile-320.png', mediaType: 'image/png', data: '' },
      { name: 'mobile-375.png', mediaType: 'image/png', data: '' }
    ]
  }
]

/** How the session appears in the sidebar: status symbol and note. */
function NoticeSample() {
  const session = useApp((s) => s.sessions[PREVIEW_SESSION])
  if (!session) return null
  const note = sessionNote(session, false)
  const tone = noteTone(note.code)
  return (
    <span className="ml-auto flex items-center gap-1.5 text-xs">
      <SessionGlyph state={sessionState(session)} />
      <span className={cn('text-faint', tone === 'destructive' && 'font-semibold text-destructive')}>{note.text}</span>
    </span>
  )
}

/** New session of a git project with a setup script: the worktree menu offers to start without waiting for it (installs the fake host). */
function NewSessionPreview() {
  // The fake host is installed before mount and the new chat appears only when the port has arrived (it arrives with postMessage,
  // asynchronously): this way its first settings request does not fall into the void.
  const [connected, setConnected] = useState(false)
  useState(() => installSettingsPreview())
  useEffect(() => onHostConnect(() => setConnected(true)), [])
  return (
    <div className="flex h-[640px] w-[900px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
      {connected && <NewChat projectId={PREVIEW_PROJECT} />}
    </div>
  )
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'normal', label: 'Normale' },
  { id: 'large', label: '1000 elementi' },
  { id: 'stream', label: 'Streaming simulato' },
  { id: 'request', label: 'Approvazione' },
  { id: 'question', label: 'Domanda' },
  { id: 'command', label: 'Comando in corso' },
  { id: 'busy', label: 'Al lavoro con coda' },
  { id: 'agents', label: '100 sotto-agenti' },
  { id: 'agents-tree', label: '3 agenti + 1 figlio' },
  { id: 'agents-12', label: '12 agenti' },
  { id: 'agents-45', label: '45 agenti' },
  { id: 'agents-idle', label: 'Agenti conclusi' },
  { id: 'agents-errors', label: 'Solo errori' },
  { id: 'notice-done', label: 'Avviso: agenti finiti' },
  { id: 'notice-failed', label: 'Avviso: agente fallito' },
  { id: 'agents-waiting', label: 'In attesa di 3 agenti' },
  { id: 'finished-states', label: 'Agenti finiti: stati' },
  { id: 'stalled', label: 'Stalled turn without asking' },
  { id: 'handoff-out', label: 'Handoff: outgoing' },
  { id: 'handoff-in', label: 'Handoff: incoming' },
  { id: 'handoff-summarizing', label: 'Handoff: summary in progress' },
  { id: 'advice', label: 'Advice: advisor and committees' },
  { id: 'plan', label: 'Plan: Open plan' },
  { id: 'implement-out', label: 'Implement: plan handed over' },
  { id: 'implement-in', label: 'Implement: plan received' },
  { id: 'ladder-handoff', label: 'MCP: handoff requested by the agent (waiting, outcomes)' },
  { id: 'ladder-handoff-in', label: 'MCP: handoff received from the agent' },
  { id: 'ladder-delegate', label: 'MCP: delegations and agent map' },
  { id: 'ladder-child', label: 'MCP: child session of a delegation' },
  { id: 'handoff-resume', label: 'Interrupted handoff: resume, reassign, Stop' },
  { id: 'ladder-resume', label: 'Interrupted delegation: resume cards (5 states)' },
  { id: 'limit', label: 'Plan limit: proposal, automatic, available again' },
  { id: 'review', label: 'Cross-review: severe forwarded, minor, ok, in progress' }
]

/** Sub-agents notice on the preview session: same state and note as the sidebar row. */
const NOTICES: Partial<Record<Mode, NonNullable<SessionSummary['agentsNotice']>>> = {
  'notice-done': { finished: 3, failed: 0, at: Date.now() },
  'notice-failed': { finished: 3, failed: 1, at: Date.now() }
}

function load(mode: Mode): Fixture {
  switch (mode) {
    case 'large':
      return largeFixture()
    case 'request':
      return requestFixture()
    case 'question':
      return questionFixture()
    case 'command':
      return commandFixture()
    case 'busy':
      return busyFixture()
    case 'agents':
      return agentsFixture()
    case 'agents-tree':
      return agentsGraphFixture('tree')
    case 'agents-12':
      return agentsGraphFixture('twelve')
    case 'agents-45':
      return agentsGraphFixture('many')
    case 'agents-idle':
      return agentsFixture('idle')
    case 'agents-errors':
      return agentsFixture('errors')
    case 'notice-done':
    case 'notice-failed':
      return agentsNoticeFixture()
    case 'agents-waiting':
      return agentsWaitingFixture()
    case 'finished-states':
      return agentsFinishedFixture()
    case 'stalled':
      return stalledFixture()
    case 'handoff-out':
      return handoffFixture('out')
    case 'handoff-in':
      return handoffFixture('in')
    case 'handoff-summarizing':
      return handoffFixture('summarizing')
    case 'advice':
      return adviceFixture()
    case 'plan':
      return planFixture()
    case 'implement-out':
      return implementFixture('out')
    case 'implement-in':
      return implementFixture('in')
    case 'handoff-resume':
      return handoffResumeFixture()
    case 'ladder-resume':
      return resumeFixture()
    case 'limit':
      return limitFixture()
    case 'review':
      return reviewFixture()
    case 'ladder-handoff':
      return ladderHandoffFixture('out')
    case 'ladder-handoff-in':
      return ladderHandoffFixture('in')
    case 'ladder-delegate':
      return ladderDelegateFixture()
    case 'ladder-child':
      return ladderChildFixture()
    case 'stream':
      return streamingBase().fixture
    default:
      return normalFixture()
  }
}

/** Simulated streaming sequence: a tool, text at 30 fps, a command, the final reply. */
function useStreamingSimulation(enabled: boolean, setFixture: (update: (f: Fixture) => Fixture) => void, runId: number) {
  useEffect(() => {
    if (!enabled) return
    const { builder } = streamingBase()
    let seq = builder.items[builder.items.length - 1].seq
    const turnId = builder.items[builder.items.length - 1].turnId
    const timers: number[] = []
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    const append = (item: ChatItem) => setFixture((f) => ({ ...f, items: [...f.items, item] }))
    const replace = (id: string, patch: Partial<ChatItem>) =>
      setFixture((f) => ({ ...f, items: f.items.map((it) => (it.id === id ? ({ ...it, ...patch } as ChatItem) : it)) }))
    const base = () => ({ turnId, seq: ++seq, at: Date.now() })

    const editId = `s-edit-${runId}`
    later(500, () => {
      append({
        ...base(),
        id: editId,
        kind: 'tool',
        tool: 'edit',
        name: 'Write',
        title: 'Crea src/components/Pagination/usePageRange.ts',
        detail: 'src/components/Pagination/usePageRange.ts',
        status: 'running',
        output: null,
        endedAt: null
      })
      setFixture((f) => ({ ...f, activity: 'Crea src/components/Pagination/usePageRange.ts' }))
    })
    later(1400, () => replace(editId, { status: 'done', endedAt: Date.now() } as Partial<ChatItem>))

    const textId = `s-text-${runId}`
    later(1600, () => {
      append({ ...base(), id: textId, kind: 'assistant', text: '', streaming: true })
      setFixture((f) => ({ ...f, activity: 'Scrive la risposta' }))
      let n = 0
      const interval = window.setInterval(() => {
        n = Math.min(STREAM_TEXT.length, n + 5)
        const text = STREAM_TEXT.slice(0, n)
        const done = n >= STREAM_TEXT.length
        setFixture((f) => {
          const items = f.items.slice()
          const i = items.length - 1
          if (items[i]?.id === textId) items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'assistant' }>), text, streaming: !done }
          return { ...f, items }
        })
        if (done) {
          window.clearInterval(interval)
          const cmdId = `s-cmd-${runId}`
          later(300, () => {
            append({
              ...base(),
              id: cmdId,
              kind: 'tool',
              tool: 'command',
              name: 'Bash',
              title: 'Esegue pnpm vitest run pagination',
              detail: 'pnpm vitest run pagination',
              status: 'running',
              output: null,
              endedAt: null
            })
            setFixture((f) => ({ ...f, activity: 'Esegue pnpm vitest run pagination' }))
          })
          later(2300, () =>
            replace(cmdId, {
              status: 'done',
              endedAt: Date.now(),
              output: ' ✓ src/components/Pagination/usePageRange.test.ts (6 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)'
            } as Partial<ChatItem>)
          )
          later(2600, () =>
            append({
              ...base(),
              id: `s-final-${runId}`,
              kind: 'assistant',
              text: 'Fatto: `Pagination` è in `src/components/Pagination/Pagination.tsx` e la usano sia Pagamenti sia Movimenti. I 6 test di `usePageRange` passano.',
              streaming: false
            })
          )
          later(2900, () => {
            append({
              ...base(),
              id: `s-end-${runId}`,
              kind: 'turn-end',
              status: 'completed',
              durationMs: 38_000,
              counts: { commands: 1, edits: 1, reads: 2, searches: 1 },
              files: [
                { path: 'src/components/Pagination/Pagination.tsx', added: 64, removed: 0, status: 'A' },
                { path: 'src/components/Pagination/usePageRange.ts', added: 41, removed: 0, status: 'A' },
                { path: 'src/features/movements/MovementsList.tsx', added: 12, removed: 37, status: 'M' }
              ],
              error: null,
              costUsd: 0.18
            })
            setFixture((f) => ({ ...f, run: 'idle', activity: null }))
          })
        }
      }, 33)
      timers.push(interval)
    })
    return () => timers.forEach((t) => {
      window.clearTimeout(t)
      window.clearInterval(t)
    })
  }, [enabled, setFixture, runId])
}

function Preview() {
  const [mode, setMode] = useState<Mode>('normal')
  // As in App.tsx: events from the fake host (for example sessions.autoArchived) reach the store.
  useEffect(() => onHostEvent(useApp.getState().applyEvent), [])
  // Chat and composer, or connections and first launch (same preview page).
  const [view, setView] = useState<'chat' | 'connections' | 'agents' | 'new' | 'terminals'>(() => {
    const param = new URLSearchParams(location.search).get('view')
    return param === 'connections' || param === 'agents' || param === 'terminals' || param === 'new' ? param : 'chat'
  })
  const [locale, setLocaleState] = useState<Locale>(INITIAL_LOCALE)
  setLocale(locale)
  const [runId, setRunId] = useState(0)
  const [mountId, setMountId] = useState(0)
  const [fixture, setFixtureState] = useState<Fixture>(() => load('normal'))
  // Narrow column: composer and chat in compact version, to see the badge with the number only.
  // Width of the chat column: narrow (compact), normal, ultrawide; and how many columns side by side.
  const [colWidth, setColWidth] = useState<'narrow' | 'normal' | 'ultrawide'>('normal')
  const [twoColumns, setTwoColumns] = useState(false)
  // The width is the window's; with two columns each gets half (min 320, as in the app).
  const windowWidth = { narrow: 380, normal: 900, ultrawide: 1800 }[colWidth]
  const frameWidth = twoColumns ? Math.max(MIN_COLUMN_WIDTH, Math.floor(windowWidth / 2)) : windowWidth
  const narrow = frameWidth < COMPACT_WIDTH
  const [subagents, setSubagents] = useState<SubagentInfo[]>([])
  const previewSession = useApp((s) => s.sessions[PREVIEW_SESSION])
  // Plans: the scenario on show, and a task session when trying the banner.
  const [planScenario, setPlanScenario] = useState<PlanScenario | null>(null)
  const [taskSessionId, setTaskSessionId] = useState<string | null>(null)
  const taskSession = useApp((s) => (taskSessionId ? (s.sessions[taskSessionId] ?? null) : null))
  const [anchor, setAnchor] = useState<ChatAnchor | null>(null)
  const [restoreAnchor, setRestoreAnchor] = useState<ChatAnchor | null>(null)
  const theme = useSettings((s) => s.theme)
  const [last, setLast] = useState('')
  const [queue, setQueue] = useState<QueuedMessage[]>(INITIAL_QUEUE)
  const [model, setModel] = useState<string | null>(null)
  const [contextCase, setContextCase] = useState(0)
  const [previewCase, setPreviewCase] = useState<PreviewCase>('claude')
  const [usageCase, setUsageCase] = useState<UsageCase>('below')
  const [usageProfile, setUsageProfile] = useState<'work' | 'default'>('work')
  useEffect(() => {
    const [five, weekly] = USAGE_PERCENTS[usageCase]
    const state = useApp.getState()
    const mixed = usageCase === 'mixed'
    const stamp = Date.now()
    // Sessions running on several accounts, only in the 'mixed' case.
    const others = Object.fromEntries(Object.entries(state.sessions).filter(([id]) => !id.startsWith('usage-run-')))
    const running = Object.fromEntries(
      RUNNING_PREVIEW.map(([agent, profileId], i) => {
        const id = `usage-run-${i}`
        return [id, usageSession(id, agent, profileId, i === 0 ? 'starting' : i === 3 ? 'waiting' : 'running', stamp)]
      })
    )
    useApp.setState({
      sessions: mixed ? { ...others, ...running } : others,
      agents: state.agents.map((a) => (a.agent === 'claude-code' ? { ...a, usage: previewUsage(40, 55), usageAt: stamp } : a.agent === 'codex' ? { ...a, usage: mixed ? [] : previewUsage(five, weekly), usageAt: mixed ? null : stamp } : a)),
      profileAgents: Object.fromEntries(Object.entries(state.profileAgents).map(([id, a]) => [id, a.agent === 'claude-code' ? { ...a, usage: previewUsage(five, weekly), usageAt: stamp - (mixed ? 4 * 60_000 : 0) } : a]))
    })
  }, [usageCase])
  const [effort, setEffort] = useState<Effort | null>(null)
  const [ladderDefault, setLadderDefault] = useState<'agent' | 'global' | 'project'>('global')
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const [permissionNext, setPermissionNext] = useState<PermissionLevel | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  // Simulated host reply to session.permission.set.
  const [permissionHost, setPermissionHost] = useState<'accept' | 'reject' | 'next-turn' | 'approve-card'>('accept')
  const counter = useRef(0)
  const sendKey = useApp((s) => s.prefs?.sendKey ?? 'enter')
  const sidebarNotice = useApp((s) => s.sidebarNotice)
  const busySend = useApp((s) => s.prefs?.busySend ?? 'steer')
  const chatFont = useApp((s) => s.prefs?.chatFont ?? DEFAULT_CHAT_FONT)
  const chatWidth = useApp((s) => s.prefs?.chatWidth ?? DEFAULT_CHAT_WIDTH)
  useChatFont()
  const fixtureSeq = useRef(10_000)
  // Agent that accepts messages during the turn (Claude, Codex) or not (ACP), and sub-agents at work.
  const [canSteer, setCanSteer] = useState(true)
  const [agentsWorking, setAgentsWorking] = useState(3)

  const setFixture = useCallback((update: (f: Fixture) => Fixture) => setFixtureState(update), [])
  const applyPermission = useCallback(
    (target: PermissionLevel) =>
      new Promise<PermissionChangeResult>((resolve, reject) => {
        window.setTimeout(() => {
          if (permissionHost === 'reject') return reject(new Error('Codex non può cambiare i permessi a turno in corso'))
          if (permissionHost === 'next-turn') {
            setPermissionNext(target)
            return resolve({ permission: target, appliesFrom: 'next-turn' })
          }
          setPermissionNext(null)
          setPermission(target)
          if (permissionHost === 'approve-card' && target === 'full') {
            setFixtureState((f) => ({
              ...f,
              items: f.items.map((i) => (i.kind === 'request' && i.state === 'open' ? { ...i, state: 'resolved' as const, resolution: 'Approvato passando ad Accesso completo' } : i)),
              run: 'running'
            }))
          }
          resolve({ permission: target, appliesFrom: 'now' })
        }, 600)
      }),
    [permissionHost]
  )
  const permissionChange = usePermissionChange({ permission, permissionNext, levels: allowedLevels(null), apply: applyPermission, onError: setPermissionError })
  useStreamingSimulation(mode === 'stream', setFixture, runId)

  // A template used from the palette creates a plan in the chat: the card appears at the bottom, as the host would do.
  useEffect(() => {
    onPlanCreated((planId) =>
      setFixtureState((f) => {
        const last = f.items[f.items.length - 1]
        const item: ChatItem = { id: `plan-item-${planId}`, turnId: `turn-${planId}`, seq: (last?.seq ?? 0) + 1, at: Date.now(), kind: 'plan', planId }
        return { ...f, items: [...f.items, item] }
      })
    )
    return () => onPlanCreated(null)
  }, [])
  // "Open session" and "Back to the plan" change the store selection: the preview has no sidebar, so it is reported below.
  useEffect(
    () =>
      useApp.subscribe((state, previous) => {
        if (state.selection !== previous.selection && state.selection.kind === 'session') setLast(`select ${state.selection.sessionId}`)
      }),
    []
  )


  // Fake host for session.handoff: the 'out' row starts as "summarizing", the summary arrives as an assistant message, then the row becomes "done" with the link to the target session.
  const simulateHandoff = (command: Extract<HostCommand, { type: 'session.handoff' }>) => {
    const id = `ho-${++counter.current}`
    const turnId = `turn-${id}`
    const setRun = (run: SessionSummary['run']) => useApp.setState((st) => (st.sessions[PREVIEW_SESSION] ? { sessions: { ...st.sessions, [PREVIEW_SESSION]: { ...st.sessions[PREVIEW_SESSION], run } } } : {}))
    const add = (item: ChatItem) => setFixtureState((f) => ({ ...f, items: [...f.items, item], run: item.kind === 'turn-end' ? 'idle' : 'running', activity: item.kind === 'turn-end' ? null : 'Writing the summary' }))
    const next = () => (fixtureSeq.current += 1)
    setRun('running')
    add({ id, turnId, seq: next(), at: Date.now(), kind: 'handoff', direction: 'out', agent: command.agent, peerSessionId: null, state: 'summarizing', note: command.note ?? null, summary: null, checkpoint: null, files: [], error: null })
    window.setTimeout(() => add({ id: `${id}-a`, turnId, seq: next(), at: Date.now(), kind: 'assistant', text: HANDOFF_SUMMARY, streaming: false }), 1500)
    window.setTimeout(() => {
      setFixtureState((f) => ({ ...f, items: f.items.map((i) => (i.id === id && i.kind === 'handoff' ? { ...i, state: 'done' as const, peerSessionId: 'preview-peer', summary: HANDOFF_SUMMARY, checkpoint: '9f3c2ab41d7e', files: HANDOFF_FILES } : i)) }))
      add({ id: `${id}-e`, turnId, seq: next(), at: Date.now(), kind: 'turn-end', status: 'completed', durationMs: 9_000, counts: { commands: 0, edits: 0, reads: 0, searches: 0 }, files: [], error: null, costUsd: null })
      setRun('idle')
    }, 2600)
  }

  // Fake host for advice: entries start 'running' with one child session each and finish at different times (with «error» in the question, the second fails).
  const simulateAdvise = (command: Extract<HostCommand, { type: 'session.advise' }>) => {
    const id = `adv-${++counter.current}`
    const at = Date.now()
    const committee = command.agents.length > 1
    const kids = command.agents.map((_, i) => `preview-${id}-${i}`)
    useApp.setState((st) => ({
      sessions: {
        ...st.sessions,
        ...Object.fromEntries(
          kids.map((kid, i) => [kid, { ...usageSession(kid, command.agents[i].agent === 'codex' ? 'codex' : 'claude-code', undefined, 'running', at), title: `Advice: ${command.question || 'general review'}`, permission: 'plan' as const, parent: { sessionId: PREVIEW_SESSION, role: 'advisor' as const, itemId: id } }])
        )
      }
    }))
    setFixtureState((f) => ({
      ...f,
      items: [
        ...f.items,
        { id, turnId: 'system', seq: (fixtureSeq.current += 1), at, kind: 'advice', mode: committee ? 'committee' : 'advisor', question: command.question, entries: command.agents.map((a, i) => ({ agent: a.agent, model: a.model ?? null, sessionId: kids[i], state: 'running' as const, text: null, error: null })), forwarded: false }
      ]
    }))
    command.agents.forEach((_, i) =>
      window.setTimeout(() => {
        const fail = /error/i.test(command.question) && i === 1
        setFixtureState((f) => ({
          ...f,
          items: f.items.map((it) =>
            it.id === id && it.kind === 'advice'
              ? { ...it, entries: it.entries.map((e, j) => (j === i && e.state === 'running' ? (fail ? { ...e, state: 'error' as const, error: 'Codex is not available right now. Try again in a moment.' } : { ...e, state: 'done' as const, text: i % 2 === 0 ? ADVICE_PREVIEW_A : ADVICE_PREVIEW_B }) : e)) }
              : it
          )
        }))
      }, 1500 + i * 2200)
    )
    return id
  }
  const simulateStop = (command: Extract<HostCommand, { type: 'session.advice.stop' }>) =>
    setFixtureState((f) => ({ ...f, items: f.items.map((it) => (it.id === command.itemId && it.kind === 'advice' ? { ...it, entries: it.entries.map((e) => (e.state === 'running' ? { ...e, state: 'stopped' as const } : e)) } : it)) }))
  const simulateForward = (command: Extract<HostCommand, { type: 'session.advice.forward' }>) =>
    setFixtureState((f) => ({ ...f, items: f.items.map((it) => (it.id === command.itemId && it.kind === 'advice' ? { ...it, forwarded: true } : it)) }))
  // Fake host for session.implement: with another agent the 'out' row with reason 'implement' is created 'done' and the linked session exists; with the same agent the plan restarts in the session.
  const simulateImplement = (command: Extract<HostCommand, { type: 'session.implement' }>) => {
    const id = `imp-${++counter.current}`
    const turnId = `turn-${id}`
    const same = command.agent === (useApp.getState().sessions[PREVIEW_SESSION]?.agent ?? 'claude-code')
    const notes = command.comments.map((c) => `- line ${c.line}: ${c.text}`).join('\n')
    const body = notes ? `${command.plan}\n\n**Comments**\n${notes}` : command.plan
    setFixtureState((f) => ({
      ...f,
      items: [
        ...f.items,
        same
          ? { id, turnId, seq: (fixtureSeq.current += 1), at: Date.now(), kind: 'user', text: `Implement this plan.\n\n${body}` }
          : { id, turnId, seq: (fixtureSeq.current += 1), at: Date.now(), kind: 'handoff', reason: 'implement', direction: 'out', agent: command.agent, peerSessionId: 'preview-peer', state: 'done', note: null, summary: body, checkpoint: null, files: [], error: null }
      ]
    }))
    setLast(`session.implement → ${same ? 'stessa sessione' : 'preview-peer'} · ${command.comments.length} commenti · ${command.permission ?? 'edit'}`)
    return same ? PREVIEW_SESSION : 'preview-peer'
  }

  // Fake host for resuming and the plan limit: stop, resume and reassign a handoff; resume a delegation; answer a limit card.
  const patchItem = (id: string, change: (item: ChatItem) => ChatItem) => setFixtureState((f) => ({ ...f, items: f.items.map((it) => (it.id === id ? change(it) : it)) }))
  const simulateFlow: AgentFlowSink = {
    currentAgent: () => useApp.getState().sessions[PREVIEW_SESSION]?.agent ?? 'claude-code',
    stop: (command) => patchItem(command.itemId, (it) => (it.kind === 'handoff' ? { ...it, state: 'interrupted' as const, resumable: true, error: 'Stopped by you.' } : it)),
    resume: (command) => {
      setLast(`session.handoff.resume → ${command.agent ?? 'stesso agente'}${command.model ? ` · ${command.model}` : ''}${command.effort ? ` · ${command.effort}` : ''}`)
      let had = false
      patchItem(command.itemId, (it) => {
        if (it.kind !== 'handoff') return it
        had = Boolean(it.summary)
        return { ...it, agent: command.agent ?? it.agent, resumable: false, error: null, state: had ? ('done' as const) : ('summarizing' as const), peerSessionId: had ? 'preview-peer' : null }
      })
      // Without a saved summary the summarizing turn restarts and then delivers.
      window.setTimeout(() => patchItem(command.itemId, (it) => (it.kind === 'handoff' && it.state === 'summarizing' ? { ...it, state: 'done' as const, peerSessionId: 'preview-peer', summary: HANDOFF_SUMMARY, checkpoint: '9f3c2ab41d7e', files: HANDOFF_FILES } : it)), 1800)
    },
    delegation: (command) => {
      setLast(`session.delegation.resume → ${command.action}`)
      patchItem(command.itemId, (it) => (it.kind === 'resume' ? { ...it, state: command.action === 'resume' ? ('resumed' as const) : ('dismissed' as const), error: null } : it))
      if (command.action === 'resume') window.setTimeout(() => patchItem(command.itemId, (it) => (it.kind === 'resume' && it.state === 'resumed' ? { ...it, state: 'done' as const } : it)), 3000)
    },
    limit: (command) => {
      setLast(`session.limit.respond → ${command.action}${command.agent ? ` · ${command.agent}` : ''}`)
      patchItem(command.itemId, (it) => {
        if (it.kind !== 'limit') return it
        if (command.action === 'dismiss') return { ...it, state: 'dismissed' as const }
        if (command.action === 'return') return { ...it, state: 'returned' as const, peerSessionId: 'preview-origin', error: null }
        return { ...it, state: 'switched' as const, target: command.agent ?? it.target, peerSessionId: 'preview-peer', automatic: false, error: null }
      })
    }
  }

  const choose = (next: Mode) => {
    if (next.startsWith('handoff')) {
      installSettingsPreview()
      installHandoffPreview(() => useApp.getState().sessions[PREVIEW_SESSION]?.agent ?? 'claude-code', simulateHandoff)
    }
    if (withPeers(next)) {
      installSettingsPreview()
      installAgentFlowPreview(simulateFlow)
      installAdvicePreview({ currentAgent: () => useApp.getState().sessions[PREVIEW_SESSION]?.agent ?? 'claude-code', advise: simulateAdvise, stop: simulateStop, forward: simulateForward, implement: simulateImplement })
    }
    setMode(next)
    const loaded = load(next)
    const agents = next.startsWith('agents') || next === 'ladder-delegate' ? ((loaded as { subagents?: SubagentInfo[] }).subagents ?? []) : []
    setSubagents(agents)
    useSubagentLists.getState().set(PREVIEW_SESSION, agents)
    const { [PREVIEW_SESSION]: _drop, ...others } = useApp.getState().sessions
    const notice = NOTICES[next] ?? null
    if (withPeers(next)) {
      // Preview session with the sessions on the other side: the "Open session" links and the current agent are read from here.
      const at = Date.now()
      const inbound = next === 'handoff-in' || next === 'implement-in' || next === 'ladder-handoff-in'
      const delegateTools = next === 'ladder-delegate' ? ((loaded as { delegateToolIds?: string[] }).delegateToolIds ?? []) : []
      const delegateChildren = Object.fromEntries(
        delegateTools.map((toolId, i) => [`preview-delegate-${i + 1}`, { ...usageSession(`preview-delegate-${i + 1}`, 'codex', undefined, i === 0 ? 'running' : 'idle', at), title: 'Review the pagination change', model: 'gpt-6-luna', permission: 'plan' as const, parent: { sessionId: PREVIEW_SESSION, role: 'delegate' as const, itemId: toolId } }])
      )
      const { 'preview-peer': _p, 'preview-origin': _o, ...rest } = others
      useApp.setState({
        sessions: {
          ...rest,
          [PREVIEW_SESSION]: { ...usageSession(PREVIEW_SESSION, inbound || next === 'ladder-child' ? 'codex' : 'claude-code', undefined, loaded.run, at), title: 'Shared pagination', permission: next === 'plan' ? ('plan' as const) : ('edit' as const), handoffFrom: inbound ? { sessionId: 'preview-origin', agent: 'claude-code' } : undefined, subagentCounts: agents.length ? countsOf(agents) : undefined, parent: next === 'ladder-child' ? { sessionId: 'preview-origin', role: 'delegate' as const, itemId: 'preview-delegate-tool' } : undefined },
          ...delegateChildren,
          ...(next === 'ladder-resume' ? { 'preview-delegate-1': { ...usageSession('preview-delegate-1', 'codex', undefined, 'idle', at), title: 'Review the pagination change', model: 'gpt-6-luna', permission: 'plan' as const, parent: { sessionId: PREVIEW_SESSION, role: 'delegate' as const, itemId: 'preview-delegate-tool' } } } : {}),
          'preview-peer': { ...usageSession('preview-peer', 'codex', undefined, 'idle', at), title: 'Shared pagination', handoffFrom: { sessionId: PREVIEW_SESSION, agent: 'claude-code' } },
          'preview-origin': { ...usageSession('preview-origin', 'claude-code', undefined, 'idle', at), title: 'Shared pagination' }
        }
      })
    } else useApp.setState({
      sessions: agents.length || notice ? { ...others, [PREVIEW_SESSION]: { id: PREVIEW_SESSION, agent: 'claude-code', model: 'claude-opus-5-5', run: 'idle', unread: false, updatedAt: Date.now(), agentsNotice: notice, subagentCounts: agents.length ? countsOf(agents) : undefined } as unknown as SessionSummary } : others
    })
    setFixtureState(loaded)
    setRestoreAnchor(null)
    setAnchor(null)
    setRunId((n) => n + 1)
  }

  /** Origin scenarios: sessions enter the store; the banner and mark show on the chosen session. */
  const chooseOrigin = (scenario: OriginScenario) => {
    const loaded = originFixture(scenario)
    const others = Object.fromEntries(Object.entries(useApp.getState().sessions).filter(([id]) => !id.startsWith('origin-') && !id.startsWith('plan-coord-') && !id.startsWith('task-')))
    useApp.setState({ sessions: { ...others, ...Object.fromEntries(loaded.sessions.map((s) => [s.id, s])) }, selection: { kind: 'session', projectId: PREVIEW_PROJECT, sessionId: loaded.originSessionId ?? 'origin-parent' } })
    setMode('exec-plan')
    setPlanScenario(null)
    setTaskSessionId(loaded.originSessionId)
    setSubagents([])
    setFixtureState(loaded)
    setRestoreAnchor(null)
    setAnchor(null)
    setRunId((n) => n + 1)
  }
  const openCliSettings = (id: CliCase) => {
    setCliCase(id)
    installPlansPreview()
    window.setTimeout(() => useSettings.getState().openSection('system'), 50)
  }

  /** Plan scenarios: plans and sessions enter the store as the snapshot would, and the coordinator chat opens. */
  const choosePlan = (scenario: PlanScenario, asTask = false) => {
    const loaded = executablePlanFixture(scenario)
    resetPlansPreview(loaded.plans)
    const others = Object.fromEntries(Object.entries(useApp.getState().sessions).filter(([id]) => !id.startsWith('plan-coord-') && !id.startsWith('task-')))
    useApp.setState({
      plans: Object.fromEntries(loaded.plans.map((p) => [p.id, p])),
      planDrafts: {},
      planTemplates: null,
      sessions: { ...others, ...Object.fromEntries(loaded.sessions.map((s) => [s.id, s])) },
      selection: { kind: 'session', projectId: PREVIEW_PROJECT, sessionId: loaded.coordinatorId },
      // With "asTask" the chat is a task chat: the banner appears above it.
      items: {}
    })
    setMode('exec-plan')
    setPlanScenario(scenario)
    setTaskSessionId(asTask ? `task-${loaded.planId}-wrapper` : null)
    setSubagents([])
    useSubagentLists.getState().set(PREVIEW_SESSION, [])
    setFixtureState(asTask ? normalFixture() : loaded)
    setRestoreAnchor(null)
    setAnchor(null)
    setRunId((n) => n + 1)
  }

  // Fake host for session.continue: after half a second the row goes to "continued"; with the "Seconda prova" row it fails.
  const onContinue = (itemId: string) =>
    new Promise<void>((resolve, reject) => {
      window.setTimeout(() => {
        const item = fixture.items.find((i) => i.id === itemId)
        if (item?.kind === 'agents-finished' && item.failed > 0) return reject(new Error('The host couldn’t reach the agent'))
        setFixtureState((f) => ({ ...f, items: f.items.map((i) => (i.id === itemId && i.kind === 'agents-finished' ? { ...i, state: 'continued' as const } : i)) }))
        resolve()
      }, 500)
    })

  const onRespond = (requestId: string, response: RequestResponse) => {
    console.log('[chat] onRespond', requestId, response)
    setLast(`onRespond ${requestId} ${JSON.stringify(response)}`)
    setFixtureState((f) => {
      const request = f.items.find((i) => i.kind === 'request' && i.requestId === requestId)
      if (!request || request.kind !== 'request') return f
      let resolution: string
      if ('answers' in response) resolution = `Risposto: ${Object.values(response.answers).join(' · ')}`
      else {
        const option = request.options.find((o) => o.id === response.optionId)
        resolution =
          option?.kind === 'deny'
            ? `Rifiutato${response.message ? `: ${response.message}` : ''}`
            : option?.kind === 'allow-always'
              ? `Approvato sempre: ${option.label.replace(/^Consenti sempre /, '')}`
              : 'Approvato'
      }
      const resolved = { ...request, state: 'resolved' as const, resolution }
      const items = f.items.map((i) => (i === request ? resolved : i))
      const approved = !resolution.startsWith('Rifiutato')
      const seq = items[items.length - 1].seq + 1
      if (approved && request.command) {
        items.push({
          id: `resp-${++counter.current}`,
          turnId: request.turnId,
          seq,
          at: Date.now(),
          kind: 'tool',
          tool: 'command',
          name: request.toolName,
          title: `Esegue ${request.command}`,
          detail: request.command,
          status: 'running',
          output: null,
          endedAt: null
        })
      }
      return { ...f, items, run: 'running', activity: approved && request.command ? `Esegue ${request.command}` : 'Sta lavorando' }
    })
  }

  const onAnchorChange = (a: ChatAnchor) => {
    console.log('[chat] onAnchorChange', a)
    setAnchor(a)
  }

  const onOpenFile = (path: string, line?: number) => {
    console.log('[chat] onOpenFile', path, line)
    setLast(`onOpenFile ${path}${line ? `:${line}` : ''}`)
  }

  const onOpenDiff = (turnId: string, path?: string) => {
    console.log('[chat] onOpenDiff', turnId, path)
    setLast(`onOpenDiff ${turnId}${path ? ` ${path}` : ''}`)
  }

  const running = fixture.run === 'running' || fixture.run === 'starting' || fixture.run === 'waiting'

  // While running the message is queued, otherwise it becomes a new turn with the attachment names.
  const addUser = (id: string, text: string, steered: boolean, attachments: { name: string; mediaType: string }[] = []) =>
    setFixtureState((f) => {
      const seq = (f.items[f.items.length - 1]?.seq ?? 0) + 1
      const item: ChatItem = { id, turnId: f.items[f.items.length - 1]?.turnId ?? `turn-${id}`, seq, at: Date.now(), kind: 'user', text, ...(steered ? { steered: true } : {}), ...(attachments.length ? { attachments } : {}) }
      return { ...f, items: [...f.items, item] }
    })

  const onDeliver = (id: string, how: 'steer' | 'now') => {
    setLast(`onDeliver ${id} ${how}`)
    const message = queue.find((m) => m.id === id)
    if (!message) return
    setQueue((q) => q.filter((m) => m.id !== id))
    addUser(`deliver-${++counter.current}`, message.text, how === 'steer', message.attachments?.map(({ name, mediaType }) => ({ name, mediaType })))
  }

  const onSubmit = (text: string, attachments: Attachment[], busy?: 'queue' | 'steer') => {
    const summary = attachments.map((a) => `${a.name} (${a.mediaType}, ${Math.round((a.data.length * 3) / 4 / 1024)} KB)`)
    console.log('[composer] onSubmit', text, summary)
    setLast(`onSubmit ${JSON.stringify(text)}${busy ? ` busy=${busy}` : ''}${summary.length ? ` + ${summary.join(', ')}` : ''}`)
    const id = `sent-${++counter.current}`
    if (running && busy === 'steer') {
      addUser(id, text, true, attachments.map(({ name, mediaType }) => ({ name, mediaType })))
      return
    }
    if (running) {
      setQueue((q) => [...q, { id, text, attachments: attachments.length ? attachments : undefined }])
      return
    }
    setFixtureState((f) => {
      const seq = (f.items[f.items.length - 1]?.seq ?? 0) + 1
      const item: ChatItem = {
        id,
        turnId: `turn-${id}`,
        seq,
        at: Date.now(),
        kind: 'user',
        text,
        ...(attachments.length ? { attachments: attachments.map(({ name, mediaType }) => ({ name, mediaType })) } : {})
      }
      return { ...f, items: [...f.items, item] }
    })
  }

  // Agent command: as the host would do, a 'command' row (never 'user') that goes from running to done.
  const onCommand = (name: string, args: string) => {
    console.log('[composer] onCommand', name, args)
    setLast(`onCommand /${name} ${JSON.stringify(args)}`)
    const id = `cmd-${++counter.current}`
    const turnId = `turn-${id}`
    const add = (item: ChatItem) => setFixtureState((f) => ({ ...f, items: [...f.items, item] }))
    const next = () => (fixtureSeq.current += 1)
    add({ id, turnId, seq: next(), at: Date.now(), kind: 'command', name, args, status: 'running', error: null })
    // Preview: a command with argument "interrupt" ends interrupted, to see the neutral state.
    const final = args.trim() === 'interrupt' ? ('interrupted' as const) : ('done' as const)
    window.setTimeout(() => {
      setFixtureState((f) => ({
        ...f,
        items: f.items.map((i) => (i.id === id && i.kind === 'command' ? { ...i, status: final } : i))
      }))
      if (name === 'compact') {
        add({ id: `${id}-c`, turnId, seq: next(), at: Date.now(), kind: 'compacted', trigger: 'manual', preTokens: 64_000, postTokens: 12_000 })
      }
    }, 1200)
  }

  const remount = () => {
    setRestoreAnchor(anchor)
    setMountId((n) => n + 1)
  }

  const btn =
    'h-7 rounded-md border border-input px-2.5 text-[12px] text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

  return (
    <div className="flex h-full flex-col items-center gap-3 overflow-auto bg-sidebar p-5">
      <div className="flex w-[900px] flex-wrap items-center gap-1.5">
        {(['chat', 'connections', 'agents', 'new', 'terminals'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} className={cn(btn, 'font-medium', view === id && 'border-ring/60 bg-accent text-foreground')}>
            {id === 'chat' ? 'Chat' : id === 'connections' ? 'Abbonamenti' : id === 'agents' ? 'Agenti' : id === 'terminals' ? 'Terminali e servizi' : 'Nuova sessione'}
          </button>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        {view === 'chat' && MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => choose(m.id)}
            aria-pressed={mode === m.id}
            className={cn(btn, mode === m.id && 'border-ring/60 bg-accent text-foreground')}
          >
            {m.label}
          </button>
        ))}
        {view === 'chat' && (
          <>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            {PLAN_SCENARIOS.map((p) => (
              <button key={p.id} type="button" onClick={() => choosePlan(p.id)} aria-pressed={mode === 'exec-plan' && planScenario === p.id && !taskSessionId} className={cn(btn, mode === 'exec-plan' && planScenario === p.id && !taskSessionId && 'border-ring/60 bg-accent text-foreground')}>
                {p.label}
              </button>
            ))}
            <button type="button" onClick={() => choosePlan('running', true)} aria-pressed={Boolean(taskSessionId)} className={cn(btn, taskSessionId && 'border-ring/60 bg-accent text-foreground')}>
              Plan: task session
            </button>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            {ORIGIN_SCENARIOS.map((o) => (
              <button key={o.id} type="button" onClick={() => chooseOrigin(o.id)} className={btn}>
                {o.label}
              </button>
            ))}
            {([['installed', 'Command line: installed'], ['missing', 'Command line: not installed'], ['no-path', 'Command line: PATH missing']] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => openCliSettings(id)} className={btn}>
                {label}
              </button>
            ))}
            <button type="button" onClick={() => useApp.getState().setPaletteOpen(true)} className={btn} title="⌘K: with an idle chat ('Plan: done', 'Plan: stopped') it offers 'Use plan template…'">
              Palette ⌘K
            </button>
          </>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className={btn}
          onClick={() => {
            const prefs = useApp.getState().prefs!
            useApp.getState().setPrefs({ ...prefs, sendKey: prefs.sendKey === 'enter' ? 'mod-enter' : 'enter' })
          }}
        >
          Invio: {sendKey === 'enter' ? 'Invio' : '⌘Invio'}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            installShortcutsHost({ warnings: ['Entry #3 ignored: unknown command “tab.nope”'] })
            // The port arrives with postMessage, asynchronously: the section opens afterwards, so the first shortcuts.get finds it.
            window.setTimeout(() => useSettings.getState().openSection('shortcuts'), 50)
          }}
        >
          Shortcuts
        </button>
        {(mode === 'advice' || mode === 'plan') && (
          <>
            <button type="button" className={btn} onClick={() => useApp.getState().setAdviceDialog({ sessionId: PREVIEW_SESSION, mode: 'advisor' })} title="Opens «Ask for advice» in single mode (with the question «fail» the fake host answers with an error, with «error» the second entry fails)">
              Ask for advice…
            </button>
            <button type="button" className={btn} onClick={() => useApp.getState().setAdviceDialog({ sessionId: PREVIEW_SESSION, mode: 'committee' })}>
              Committee…
            </button>
          </>
        )}
        {mode.startsWith('handoff') && (
          <button type="button" className={btn} onClick={() => useApp.getState().setHandoffDialog({ sessionId: PREVIEW_SESSION })} title="Opens the Hand off to… dialog (with the note «fail» the fake host answers with an error)">
            Hand off to…
          </button>
        )}
        <button type="button" className={btn} onClick={() => setCanSteer((v) => !v)}>
          Agente: {canSteer ? 'inserisce nel turno' : 'solo coda (ACP)'}
        </button>
        <button type="button" className={btn} onClick={() => setColWidth((w) => (w === 'narrow' ? 'normal' : w === 'normal' ? 'ultrawide' : 'narrow'))}>
          Colonna: {{ narrow: 'stretta 380', normal: 'normale 900', ultrawide: 'ultrawide 1800' }[colWidth]}
        </button>
        <button type="button" className={btn} onClick={() => setContextCase((i) => (i + 1) % CONTEXT_CASES.length)}>
          Contesto: {CONTEXT_CASES[contextCase].label}
        </button>
        <button type="button" className={btn} aria-pressed={twoColumns} onClick={() => setTwoColumns((v) => !v)}>
          Due colonne: {twoColumns ? 'sì' : 'no'}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            const prefs = useApp.getState().prefs!
            const order: AppPrefs['chatWidth'][] = ['comfortable', 'wide', 'full']
            useApp.getState().setPrefs({ ...prefs, chatWidth: order[(order.indexOf(chatWidth) + 1) % order.length] })
          }}
        >
          Larghezza chat: {chatWidth}
        </button>
        <button type="button" className={btn} onClick={() => setAgentsWorking((n) => (n + 1) % 4)}>
          Sotto-agenti: {agentsWorking}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            const prefs = useApp.getState().prefs!
            useApp.getState().setPrefs({ ...prefs, busySend: prefs.busySend === 'steer' ? 'queue' : 'steer' })
          }}
        >
          Invio in turno: {busySend === 'steer' ? 'inserisce' : 'accoda'}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            const prefs = useApp.getState().prefs!
            const order: ChatFont[] = ['system-mono', 'system-sans', 'mona-sans', 'monaspace-neon']
            useApp.getState().setPrefs({ ...prefs, chatFont: order[(order.indexOf(chatFont) + 1) % order.length] })
          }}
        >
          Font chat: {chatFont}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            const next = ladderDefault === 'global' ? 'project' : ladderDefault === 'project' ? 'agent' : 'global'
            setLadderDefault(next)
            const state = useApp.getState()
            const base = PREVIEW_PREFS.defaults ?? {}
            state.setPrefs({ ...state.prefs!, defaults: next === 'global' ? { ...base, models: { 'claude-code': 'claude-sonnet-5' } } : { agent: base.agent, permission: base.permission } })
            const ui = state.ui[PREVIEW_PROJECT] ?? { tabs: [], activeTab: null, scroll: {} }
            const { defaults: _old, ...rest } = ui
            state.setUi(PREVIEW_PROJECT, next === 'project' ? { ...rest, defaults: { models: { 'claude-code': 'claude-sonnet-5' }, efforts: { 'claude-code': 'low' } } } : rest)
          }}
        >
          Default Ladder: {ladderDefault}
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            setPreviewCase(PREVIEW_CASES[(PREVIEW_CASES.indexOf(previewCase) + 1) % PREVIEW_CASES.length])
            setModel(null)
            setEffort(null)
          }}
        >
          Composer: {previewCase}
        </button>
        <button type="button" className={btn} onClick={() => setUsageCase((c) => USAGE_CASES[(USAGE_CASES.indexOf(c) + 1) % USAGE_CASES.length])}>
          Usage: {usageCase}
        </button>
        <button type="button" className={btn} onClick={() => setUsageProfile((p) => (p === 'work' ? 'default' : 'work'))}>
          Profile: {usageProfile}
        </button>
        <button type="button" className={btn} onClick={() => {
          installSettingsPreview()
          useSettings.getState().openSection('defaults')
        }}>
          Predefiniti
        </button>
        <button type="button" className={btn} onClick={() => useSettings.getState().openSection('appearance')} title="Dimensione del testo, font del codice, densità della sidebar (in fondo alla sezione)">
          Aspetto
        </button>
        {([
          ['devices', 'Dispositivi (telefoni)'],
          ['workspace', 'Editor e worktree'],
          ['system', 'Dati e sistema'],
          ['notifications', 'Notifiche e suono']
        ] as const).map(([section, label]) => (
          <button
            key={section}
            type="button"
            className={btn}
            onClick={() => {
              installSettingsPreview()
              // The fake host's port arrives with postMessage, asynchronously: the section opens afterwards, so the first request finds it.
              window.setTimeout(() => useSettings.getState().openSection(section), 50)
            }}
          >
            {label}
          </button>
        ))}
        {([
          ['off', 'Telefoni: spento'],
          ['on', 'Telefoni: 2 (1 collegato)'],
          ['empty', 'Telefoni: nessuno'],
          ['busy', 'Telefoni: 3 collegati']
        ] as [PhoneScenario, string][]).map(([scenario, label]) => (
          <button
            key={scenario}
            type="button"
            className={btn}
            onClick={() => {
              installSettingsPreview()
              window.setTimeout(() => setPhoneScenario(scenario), 50)
            }}
          >
            {label}
          </button>
        ))}
        <button type="button" className={btn} onClick={emitPhonePaired} title="Evento remote.paired: il dialogo del QR mostra l'esito e si chiude">
          Abbina un telefono
        </button>
        <button type="button" className={btn} onClick={emitPhoneLog} title="Evento remote.log: una nuova voce in cima all'attività">
          Nuova voce nel log
        </button>
        <button type="button" className={btn} onClick={() => { installSettingsPreview(); emitAutoArchived() }} title="Evento sessions.autoArchived: l'avviso della sidebar compare qui accanto (la sidebar non fa parte dell'anteprima)">
          Archiviate in automatico
        </button>
        {sidebarNotice && <span role="status" className="text-[12px] text-muted-foreground">Sidebar: {sidebarNotice}</span>}
        <button type="button" className={btn} onClick={remount} title="Smonta e rimonta la chat con l'ultima ancora ricevuta">
          Rimonta con ancora
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            const next = LOCALES[(LOCALES.findIndex((l) => l.id === locale) + 1) % LOCALES.length].id
            setLocale(next)
            document.documentElement.lang = next
            setLocaleState(next)
          }}
        >
          Lingua: {LOCALES.find((l) => l.id === locale)?.name}
        </button>
        {([
          ['accept', 'Permessi: accettato'],
          ['reject', 'Permessi: rifiutato'],
          ['next-turn', 'Permessi: dal prossimo turno'],
          ['approve-card', 'Permessi: approva la card (usa Approvazione)']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={permissionHost === id}
            className={cn(btn, permissionHost === id && 'bg-accent')}
            onClick={() => {
              setPermissionHost(id)
              setPermissionNext(null)
              setPermissionError(null)
            }}
          >
            {label}
          </button>
        ))}
        <button type="button" className={btn} onClick={() => { const i = THEMES.findIndex((t) => t.id === theme); useSettings.getState().setTheme(THEMES[(i + 1) % THEMES.length].id) }}>
          Tema: {THEMES.find((t) => t.id === theme)?.name}
        </button>
      </div>
      {view === 'new' ? (
        <NewSessionPreview key={locale} />
      ) : view === 'terminals' ? (
        <TerminalsPreview key={locale} />
      ) : view === 'agents' ? (
        <AgentCatalogPreview key={locale} />
      ) : view === 'connections' ? (
        <ConnectionsPreview key={locale} />
      ) : (
      <>
      <div className="flex shrink-0 gap-4">
      <div style={{ width: frameWidth }} className="flex h-[700px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5">
          <span className="text-[13.5px] font-semibold">{mode === 'exec-plan' ? (taskSession?.title ?? 'Session cookie fix') : 'Payments table filters'}</span>
          <span className="text-[12px] text-muted-foreground">
            acme-monorepo · main · Claude · {fixture.items.length} items · {fixture.run}
          </span>
          {mode === 'ladder-child' && previewSession?.parent && (
            <span className="flex min-w-0 items-center text-xs text-muted-foreground">
              <AdviceParentNote session={previewSession} />
            </span>
          )}
          {(NOTICES[mode] || mode === 'agents-waiting') && <NoticeSample />}
          {/* The same indicator as the app's top bar: it appears with at least one phone connected. */}
          <span className="ml-auto" />
          <PhoneIndicator />
          {taskSession?.plan && <PlanTaskMark className="ml-auto text-[12px] text-muted-foreground" />}
          {taskSession?.origin && <OriginMark session={taskSession} className="ml-auto text-[12px] text-muted-foreground" />}
        </div>
        {taskSession && <div className="pt-2"><OriginBanner session={taskSession} compact={narrow} /><PlanTaskBanner session={taskSession} compact={narrow} /></div>}
        <div className="flex min-h-0 flex-1 flex-col" onKeyDown={permissionChange.onKeyDown}>
        <ChatView
          key={`${mode}-${runId}-${mountId}-${locale}`}
          sessionId={mode.startsWith('agents') || withPeers(mode) ? PREVIEW_SESSION : `${mode}-${runId}-${mountId}`}
          items={fixture.items}
          run={fixture.run}
          activity={fixture.activity}
          firstUnreadSeq={fixture.firstUnreadSeq}
          initialAnchor={restoreAnchor}
          onAnchorChange={onAnchorChange}
          onRespond={onRespond}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          compact={narrow}
          waitingAgents={fixture.run === 'idle' ? countsOf(subagents).running : 0}
          onContinue={onContinue}
          onPrefill={(text) => useApp.getState().insertIntoComposer('preview', text)}
        />
        </div>
        {/* Real composer: @ for the fake files, pasted or dragged images, editable queue. */}
        <div className="chat-col chat-gutter shrink-0 pb-4" data-compact={narrow ? '' : undefined}>
          <div className="chat-measure chat-bleed">
          <div className="chat-reset">
          {permissionError && <p className="mb-2 w-full text-sm text-destructive">{permissionError}</p>}
          <Composer
            profileId={previewCase === 'codex' || usageProfile === 'default' ? undefined : PREVIEW_CLAUDE_WORK}
            key={locale}
            onEffortChange={setEffort}
            effortEffective={previewCase === 'unknown' ? undefined : 'medium'}
            draftKey="preview"
            sessionId={subagents.length || withPeers(mode) ? PREVIEW_SESSION : undefined}
            subagentCounts={subagents.length ? countsOf(subagents) : undefined}
            projectId={PREVIEW_PROJECT}
            agent={previewCase === 'codex' ? 'codex' : 'claude-code'}
            agentName={previewCase === 'codex' ? 'Codex' : 'Claude'}
            models={previewModels(previewCase)}
            model={model}
            onModelChange={setModel}
            effort={effort}
            permission={permissionChange.shown}
            permissionNext={permissionChange.next}
            onPermissionChange={permissionChange.change}
            running={running}
            commands={previewCommands}
            onCommand={onCommand}
            onNewSession={(args) => setLast(`onNewSession ${JSON.stringify(args)}`)}
            onPlan={(goal) => setLast(`onPlan ${JSON.stringify(goal)}`)}
            onHandoff={
              mode.startsWith('handoff')
                ? (args) => {
                    const session = useApp.getState().sessions[PREVIEW_SESSION]
                    if (session) runHandoffCommand(session, args, useApp.getState().agents, [], (message) => setLast(message ? `onHandoff: ${message}` : `onHandoff ${JSON.stringify(args)}`))
                  }
                : undefined
            }
            onAdvice={
              withPeers(mode)
                ? (adviceMode, args) => {
                    const session = useApp.getState().sessions[PREVIEW_SESSION]
                    if (session) runAdviceCommand(session, adviceMode, args, useApp.getState().agents, [], (message) => setLast(message ? `onAdvice: ${message}` : `onAdvice /${adviceMode} ${JSON.stringify(args)}`))
                  }
                : undefined
            }
            onSubmit={onSubmit}
            canSteer={canSteer}
            onDeliver={onDeliver}
            queueReason={running && agentsWorking > 0 ? plural(agentsWorking, '{n} agent working', '{n} agents working') : null}
            onStop={() => setFixtureState((f) => ({ ...f, run: 'idle', activity: null }))}
            queue={queue}
            onQueueChange={(next) => {
              console.log('[composer] onQueueChange', next)
              setLast(`onQueueChange ${next.map((m) => JSON.stringify(m.text)).join(' · ') || '[]'}`)
              setQueue(next)
            }}
            context={CONTEXT_CASES[contextCase].value}
          />
          </div>
          </div>
        </div>
      </div>
      {twoColumns ? (
        <div style={{ width: frameWidth }} className="flex h-[700px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5">
            <span className="text-[13.5px] font-semibold">Seconda colonna</span>
          </div>
          <ChatView
            key={`col2-${mode}-${locale}`}
            sessionId="preview-col2"
            items={fixture.items}
            run="idle"
            activity={null}
            firstUnreadSeq={null}
            initialAnchor={null}
            onAnchorChange={() => undefined}
            onRespond={() => undefined}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            compact={narrow}
          />
        </div>
      ) : null}
      </div>
      <SettingsDialog />
      <HandoffDialog />
      <AdviceDialog />
      <PlanDialog />
      <CommandPalette />
      <SubagentDialog sessionId={PREVIEW_SESSION} />
      <p className="font-mono text-[11px] text-muted-foreground">
        ancora: {anchor ? `${anchor.itemId} +${anchor.offset}px` : '—'} · ultimo evento: {last || '—'}
      </p>
      </>
      )}
    </div>
  )
}

// With HMR the module may be re-run: the same root is reused.
const container = document.getElementById('root') as HTMLElement & { __chatRoot?: ReturnType<typeof createRoot> }
container.__chatRoot ??= createRoot(container)
container.__chatRoot.render(
  <StrictMode>
    <TooltipProvider delay={400}>
      <Preview />
    </TooltipProvider>
  </StrictMode>
)
