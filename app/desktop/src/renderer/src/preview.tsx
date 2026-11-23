// Anteprima della chat senza Electron: pnpm dev:web e poi http://localhost:5199/preview.html
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
import { ConnectionsPreview } from './dev/connections-preview'
import { TerminalsPreview } from './dev/terminals-preview'
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
import { useApp } from './store/app-store'
import { allowedLevels } from './lib/agents'
import { usePermissionChange, type PermissionChangeResult } from './lib/use-permission-change'
import type { AgentStatus, AppPrefs, ChatFont, Effort, Project, SessionSummary, SubagentInfo } from '@shared/protocol'
import { SubagentDialog } from './components/subagent-dialog'
import { countsOf, setSubagentDetailLoader, useSubagentLists } from './lib/subagents'

applyTheme(useSettings.getState().theme)

// Lingua dell'anteprima: ?lang=it (o en); altrimenti inglese, come l'app.
const initialLang = new URLSearchParams(location.search).get('lang')
const INITIAL_LOCALE: Locale = isLocale(initialLang) ? initialLang : 'en'
setLocale(INITIAL_LOCALE)
document.documentElement.lang = INITIAL_LOCALE

type Mode = 'normal' | 'large' | 'stream' | 'request' | 'question' | 'command' | 'busy' | 'agents' | 'agents-tree' | 'agents-12' | 'agents-45' | 'agents-idle' | 'agents-errors' | 'notice-done' | 'notice-failed' | 'agents-waiting' | 'finished-states' | 'stalled'

// Sessione finta con cento sotto-agenti: la board, il popover e il dialogo leggono da qui come nell'app.
const PREVIEW_SESSION = 'preview-agents'
setSubagentDetailLoader(
  (_sessionId, id) =>
    new Promise((resolve) => window.setTimeout(() => resolve(previewSubagentDetail(useSubagentLists.getState().lists[PREVIEW_SESSION] ?? [], id)), 250))
)

// Il composer cita i file di questo progetto finto: niente host nell'anteprima.
const PREVIEW_PROJECT = 'preview'
seedProjectFiles(PREVIEW_PROJECT, previewProjectFiles())

// Il predefinito dell'agente è Opus (isDefault) con effort medium; il bottone "Default Ladder" lo sposta su Sonnet (globale o di progetto) o lo toglie.
// Tre casi del composer: Claude Code, Codex, e un agente che non dichiara predefiniti (nessun isDefault, nessun defaultEffort, effortEffective assente: resta "Default").
const CONTEXT_CASES = [
  { label: 'lontano dalla soglia', value: { used: 64_000, window: 200_000, compactAt: 167_000 } },
  { label: 'vicino alla soglia', value: { used: 155_000, window: 200_000, compactAt: 167_000 } },
  { label: 'oltre la soglia', value: { used: 172_000, window: 200_000, compactAt: 167_000 } },
  { label: 'compattazione off (null)', value: { used: 64_000, window: 200_000, compactAt: null } },
  { label: 'soglia ignota (assente)', value: { used: 170_000, window: 200_000 } }
]

type PreviewCase = 'claude' | 'codex' | 'unknown'
const PREVIEW_CASES: PreviewCase[] = ['claude', 'codex', 'unknown']
// Limiti d'uso (LAD-67): sotto soglia niente, 85% avviso sull'icona, 96% anche il bannerino, limite esaurito. Il profilo Work segue il caso, il predefinito resta basso.
// 'mixed' (LAD-82): pannello con tutti gli abbonamenti, sessioni in corso su più account, Codex senza dati e Work vicino al limite.
type UsageCase = 'below' | '85%' | '96%' | 'limited' | 'mixed'
const USAGE_CASES: UsageCase[] = ['below', '85%', '96%', 'limited', 'mixed']
const USAGE_PERCENTS: Record<UsageCase, [number, number]> = { below: [34, 62], '85%': [85, 62], '96%': [40, 96], limited: [100, 71], mixed: [91, 62] }
/** Sessione di prova con i soli campi che servono ai limiti (agente, profilo, stato), il resto ai valori neutri. */
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

// Store finto per le impostazioni "New sessions": agenti, progetti, predefiniti (uno non più valido) e tasto di invio.
const PREVIEW_AGENTS: AgentStatus[] = [
  {
    agent: 'claude-code',
    name: 'Claude Code',
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
  // Il monorepo usa l'account "Work" di Claude per le nuove sessioni; acme-api il predefinito.
  { id: PREVIEW_PROJECT, name: 'acme-monorepo', path: '/tmp/acme', branch: 'main', isGit: true, addedAt: 1, profiles: { 'claude-code': PREVIEW_CLAUDE_WORK } },
  { id: 'api', name: 'acme-api', path: '/tmp/api', branch: 'main', isGit: true, addedAt: 2 }
]
const PREVIEW_PREFS: AppPrefs = { notifications: true, sound: true, dndUntil: null, locale: 'en', defaults: { agent: 'claude-code', models: { 'claude-code': 'claude-sonnet-5' }, permission: 'ask' },
  // Profili di sessione (LAD-60): uno solo di lettura, uno con account e worktree, uno Codex e uno con l'agente non disponibile (si vede la nota di ripiego).
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
  // Due account Claude (predefinito e Work) e uno Codex: la sidebar, il composer e le impostazioni mostrano il profilo in uso.
  profiles: PREVIEW_PROFILES,
  profileConnections: PREVIEW_PROFILE_CONNECTIONS,
  profileAgents: previewProfileAgents(PREVIEW_PROFILE_CONNECTIONS),
  // Collegamenti dei tre servizi: Impostazioni → Abbonamenti e il footer della sidebar si provano anche da qui.
  connections: connectionScenario('connected'),
  projects: PREVIEW_PROJECTS,
  prefs: PREVIEW_PREFS,
  // acme-api ha un modello che l'agente non offre più e un agente non disponibile: si vedono come non validi.
  ui: { api: { tabs: [], activeTab: null, scroll: {}, defaults: { agent: 'acp:gemini', models: { 'claude-code': 'claude-opus-4-old' }, efforts: { 'claude-code': 'max' } } } }
})

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

/** Come appare la sessione nella sidebar: simbolo di stato e nota. */
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

/** Nuova sessione di un progetto git con script di setup: il menu del worktree offre di partire senza aspettarlo (installa l'host finto). */
function NewSessionPreview() {
  // L'host finto si installa prima del mount e la nuova chat compare solo quando la porta è arrivata (arriva con postMessage,
  // in modo asincrono): così la sua prima richiesta delle impostazioni non cade nel vuoto.
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
  { id: 'agents-45', label: '45 agenti (solo lista)' },
  { id: 'agents-idle', label: 'Agenti conclusi' },
  { id: 'agents-errors', label: 'Solo errori' },
  { id: 'notice-done', label: 'Avviso: agenti finiti' },
  { id: 'notice-failed', label: 'Avviso: agente fallito' },
  { id: 'agents-waiting', label: 'In attesa di 3 agenti' },
  { id: 'finished-states', label: 'Agenti finiti: stati' },
  { id: 'stalled', label: 'Turno fermo senza chiedere' }
]

/** Avviso dei sotto-agenti sulla sessione di anteprima: stesso stato e nota della riga in sidebar. */
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
    case 'stream':
      return streamingBase().fixture
    default:
      return normalFixture()
  }
}

/** Sequenza dello streaming simulato: uno strumento, il testo a 30 fps, un comando, la risposta finale. */
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
  // Come in App.tsx: gli eventi dell'host finto (per esempio sessions.autoArchived) arrivano allo store.
  useEffect(() => onHostEvent(useApp.getState().applyEvent), [])
  // Chat e composer, oppure collegamenti e primo avvio (stessa pagina di anteprima).
  const [view, setView] = useState<'chat' | 'connections' | 'agents' | 'new' | 'terminals'>(() => {
    const param = new URLSearchParams(location.search).get('view')
    return param === 'connections' || param === 'agents' || param === 'terminals' || param === 'new' ? param : 'chat'
  })
  const [locale, setLocaleState] = useState<Locale>(INITIAL_LOCALE)
  setLocale(locale)
  const [runId, setRunId] = useState(0)
  const [mountId, setMountId] = useState(0)
  const [fixture, setFixtureState] = useState<Fixture>(() => load('normal'))
  // Colonna stretta: composer e chat in versione compact, per vedere il badge col solo numero.
  // Larghezza della colonna della chat: stretta (compatta), normale, ultrawide; e quante colonne affiancate.
  const [colWidth, setColWidth] = useState<'narrow' | 'normal' | 'ultrawide'>('normal')
  const [twoColumns, setTwoColumns] = useState(false)
  // La larghezza è quella della finestra; con due colonne ognuna ne ha la metà (min 320, come in app).
  const windowWidth = { narrow: 380, normal: 900, ultrawide: 1800 }[colWidth]
  const frameWidth = twoColumns ? Math.max(MIN_COLUMN_WIDTH, Math.floor(windowWidth / 2)) : windowWidth
  const narrow = frameWidth < COMPACT_WIDTH
  const [subagents, setSubagents] = useState<SubagentInfo[]>([])
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
    // Sessioni in corso su più account, solo nel caso 'mixed'.
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
  // Risposta simulata dell'host a session.permission.set (LAD-44).
  const [permissionHost, setPermissionHost] = useState<'accept' | 'reject' | 'next-turn' | 'approve-card'>('accept')
  const counter = useRef(0)
  const sendKey = useApp((s) => s.prefs?.sendKey ?? 'enter')
  const sidebarNotice = useApp((s) => s.sidebarNotice)
  const busySend = useApp((s) => s.prefs?.busySend ?? 'steer')
  const chatFont = useApp((s) => s.prefs?.chatFont ?? DEFAULT_CHAT_FONT)
  const chatWidth = useApp((s) => s.prefs?.chatWidth ?? DEFAULT_CHAT_WIDTH)
  useChatFont()
  const fixtureSeq = useRef(10_000)
  // Agente che accetta messaggi nel turno (Claude, Codex) o no (ACP), e sotto-agenti al lavoro.
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


  const choose = (next: Mode) => {
    setMode(next)
    const loaded = load(next)
    const agents = next.startsWith('agents') ? ((loaded as { subagents?: SubagentInfo[] }).subagents ?? []) : []
    setSubagents(agents)
    useSubagentLists.getState().set(PREVIEW_SESSION, agents)
    const { [PREVIEW_SESSION]: _drop, ...others } = useApp.getState().sessions
    const notice = NOTICES[next] ?? null
    useApp.setState({
      sessions: agents.length || notice ? { ...others, [PREVIEW_SESSION]: { id: PREVIEW_SESSION, agent: 'claude-code', model: 'claude-opus-5-5', run: 'idle', unread: false, updatedAt: Date.now(), agentsNotice: notice, subagentCounts: agents.length ? countsOf(agents) : undefined } as unknown as SessionSummary } : others
    })
    setFixtureState(loaded)
    setRestoreAnchor(null)
    setAnchor(null)
    setRunId((n) => n + 1)
  }

  // Host finto per session.continue: dopo mezzo secondo la riga passa a "continued"; con la riga "Seconda prova" fallisce.
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

  // In corso il messaggio va in coda, altrimenti diventa un turno nuovo con i nomi degli allegati.
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

  // Comando dell'agente: come farebbe l'host, una riga 'command' (mai 'user') che passa da in corso a fatta.
  const onCommand = (name: string, args: string) => {
    console.log('[composer] onCommand', name, args)
    setLast(`onCommand /${name} ${JSON.stringify(args)}`)
    const id = `cmd-${++counter.current}`
    const turnId = `turn-${id}`
    const add = (item: ChatItem) => setFixtureState((f) => ({ ...f, items: [...f.items, item] }))
    const next = () => (fixtureSeq.current += 1)
    add({ id, turnId, seq: next(), at: Date.now(), kind: 'command', name, args, status: 'running', error: null })
    // Anteprima: un comando con argomento "interrupt" finisce interrotto, per vedere lo stato neutro.
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
            // La porta arriva con postMessage, in modo asincrono: la sezione si apre dopo, così il primo shortcuts.get la trova.
            window.setTimeout(() => useSettings.getState().openSection('shortcuts'), 50)
          }}
        >
          Shortcuts
        </button>
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
        <button type="button" className={btn} onClick={() => useSettings.getState().openSection('defaults')}>
          Predefiniti
        </button>
        <button type="button" className={btn} onClick={() => useSettings.getState().openSection('appearance')} title="Dimensione del testo, font del codice, densità della sidebar (in fondo alla sezione)">
          Aspetto
        </button>
        {([
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
              // La porta dell'host finto arriva con postMessage, in modo asincrono: la sezione si apre dopo, così la prima richiesta la trova.
              window.setTimeout(() => useSettings.getState().openSection(section), 50)
            }}
          >
            {label}
          </button>
        ))}
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
          <span className="text-[13.5px] font-semibold">Filtri tabella pagamenti</span>
          <span className="text-[12px] text-muted-foreground">
            acme-monorepo · main · Claude Code · {fixture.items.length} elementi · {fixture.run}
          </span>
          {(NOTICES[mode] || mode === 'agents-waiting') && <NoticeSample />}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" onKeyDown={permissionChange.onKeyDown}>
        <ChatView
          key={`${mode}-${runId}-${mountId}-${locale}`}
          sessionId={mode.startsWith('agents') ? PREVIEW_SESSION : `${mode}-${runId}-${mountId}`}
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
        {/* Composer vero: @ per i file finti, immagini incollate o trascinate, coda modificabile. */}
        <div className="chat-col chat-gutter shrink-0 pb-4" data-compact={narrow ? '' : undefined}>
          <div className="chat-measure chat-bleed">
          <div className="chat-reset">
          {permissionError && <p className="mb-2 w-full text-sm text-destructive">{permissionError}</p>}
          <Composer
            profileId={previewCase === 'codex' || usageProfile === 'default' ? undefined : PREVIEW_CLAUDE_WORK}
            key={locale}
            onEffortChange={setEffort}
            onEffortReset={() => setEffort(null)}
            onModelReset={() => setModel(null)}
            effortEffective={previewCase === 'unknown' ? undefined : 'medium'}
            draftKey="preview"
            sessionId={subagents.length ? PREVIEW_SESSION : undefined}
            subagentCounts={subagents.length ? countsOf(subagents) : undefined}
            projectId={PREVIEW_PROJECT}
            agent={previewCase === 'codex' ? 'codex' : 'claude-code'}
            agentName={previewCase === 'codex' ? 'Codex' : 'Claude Code'}
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
      <SubagentDialog sessionId={PREVIEW_SESSION} />
      <p className="font-mono text-[11px] text-muted-foreground">
        ancora: {anchor ? `${anchor.itemId} +${anchor.offset}px` : '—'} · ultimo evento: {last || '—'}
      </p>
      </>
      )}
    </div>
  )
}

// Con l'HMR il modulo può essere rieseguito: si riusa la stessa radice.
const container = document.getElementById('root') as HTMLElement & { __chatRoot?: ReturnType<typeof createRoot> }
container.__chatRoot ??= createRoot(container)
container.__chatRoot.render(
  <StrictMode>
    <TooltipProvider delay={400}>
      <Preview />
    </TooltipProvider>
  </StrictMode>
)
