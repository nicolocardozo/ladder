// Anteprima della chat senza Electron: pnpm dev:web e poi http://localhost:5199/preview.html
import { THEMES, applyTheme, useSettings } from '@/hooks/use-theme'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import type { Attachment, ChatItem, PermissionLevel, QueuedMessage, RequestResponse } from '@shared/protocol'
import { ChatView, type ChatAnchor } from './components/chat/chat-view'
import { Composer } from './components/composer'
import { seedProjectFiles } from './components/composer/file-index'
import { TooltipProvider } from './components/ui/tooltip'
import {
  largeFixture,
  normalFixture,
  previewProjectFiles,
  questionFixture,
  requestFixture,
  STREAM_TEXT,
  streamingBase,
  type Fixture
} from './dev/fixtures'
import { cn } from './lib/utils'

applyTheme(useSettings.getState().theme)

type Mode = 'normal' | 'large' | 'stream' | 'request' | 'question'

// Il composer cita i file di questo progetto finto: niente host nell'anteprima.
const PREVIEW_PROJECT = 'preview'
seedProjectFiles(PREVIEW_PROJECT, previewProjectFiles())

const PREVIEW_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' }
]

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

const MODES: { id: Mode; label: string }[] = [
  { id: 'normal', label: 'Normale' },
  { id: 'large', label: '1000 elementi' },
  { id: 'stream', label: 'Streaming simulato' },
  { id: 'request', label: 'Approvazione' },
  { id: 'question', label: 'Domanda' }
]

function load(mode: Mode): Fixture {
  switch (mode) {
    case 'large':
      return largeFixture()
    case 'request':
      return requestFixture()
    case 'question':
      return questionFixture()
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
  const [runId, setRunId] = useState(0)
  const [mountId, setMountId] = useState(0)
  const [fixture, setFixtureState] = useState<Fixture>(() => load('normal'))
  const [anchor, setAnchor] = useState<ChatAnchor | null>(null)
  const [restoreAnchor, setRestoreAnchor] = useState<ChatAnchor | null>(null)
  const theme = useSettings((s) => s.theme)
  const [last, setLast] = useState('')
  const [queue, setQueue] = useState<QueuedMessage[]>(INITIAL_QUEUE)
  const [model, setModel] = useState<string | null>(PREVIEW_MODELS[0].id)
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const counter = useRef(0)

  const setFixture = useCallback((update: (f: Fixture) => Fixture) => setFixtureState(update), [])
  useStreamingSimulation(mode === 'stream', setFixture, runId)


  const choose = (next: Mode) => {
    setMode(next)
    setFixtureState(load(next))
    setRestoreAnchor(null)
    setAnchor(null)
    setRunId((n) => n + 1)
  }

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

  const running = fixture.run === 'running' || fixture.run === 'starting' || fixture.run === 'waiting'

  // In corso il messaggio va in coda, altrimenti diventa un turno nuovo con i nomi degli allegati.
  const onSubmit = (text: string, attachments: Attachment[]) => {
    const summary = attachments.map((a) => `${a.name} (${a.mediaType}, ${Math.round((a.data.length * 3) / 4 / 1024)} KB)`)
    console.log('[composer] onSubmit', text, summary)
    setLast(`onSubmit ${JSON.stringify(text)}${summary.length ? ` + ${summary.join(', ')}` : ''}`)
    const id = `sent-${++counter.current}`
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

  const remount = () => {
    setRestoreAnchor(anchor)
    setMountId((n) => n + 1)
  }

  const btn =
    'h-7 rounded-md border border-input px-2.5 text-[12px] text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

  return (
    <div className="flex h-full flex-col items-center gap-3 overflow-auto bg-sidebar p-5">
      <div className="flex w-[900px] flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
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
        <button type="button" className={btn} onClick={remount} title="Smonta e rimonta la chat con l'ultima ancora ricevuta">
          Rimonta con ancora
        </button>
        <button type="button" className={btn} onClick={() => { const i = THEMES.findIndex((t) => t.id === theme); useSettings.getState().setTheme(THEMES[(i + 1) % THEMES.length].id) }}>
          Tema: {THEMES.find((t) => t.id === theme)?.name}
        </button>
      </div>
      <div className="flex h-[700px] w-[900px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5">
          <span className="text-[13.5px] font-semibold">Filtri tabella pagamenti</span>
          <span className="text-[12px] text-muted-foreground">
            acme-monorepo · main · Claude Code · {fixture.items.length} elementi · {fixture.run}
          </span>
        </div>
        <ChatView
          key={`${mode}-${runId}-${mountId}`}
          sessionId={`${mode}-${runId}-${mountId}`}
          items={fixture.items}
          run={fixture.run}
          activity={fixture.activity}
          firstUnreadSeq={fixture.firstUnreadSeq}
          initialAnchor={restoreAnchor}
          onAnchorChange={onAnchorChange}
          onRespond={onRespond}
          onOpenFile={onOpenFile}
        />
        {/* Composer vero: @ per i file finti, immagini incollate o trascinate, coda modificabile. */}
        <div className="flex shrink-0 justify-center px-6 pb-4">
          <Composer
            draftKey="preview"
            projectId={PREVIEW_PROJECT}
            agentName="Claude Code"
            models={PREVIEW_MODELS}
            model={model}
            onModelChange={setModel}
            effort="high"
            permission={permission}
            onPermissionChange={setPermission}
            running={running}
            onSubmit={onSubmit}
            onStop={() => setFixtureState((f) => ({ ...f, run: 'idle', activity: null }))}
            queue={queue}
            onQueueChange={(next) => {
              console.log('[composer] onQueueChange', next)
              setLast(`onQueueChange ${next.map((m) => JSON.stringify(m.text)).join(' · ') || '[]'}`)
              setQueue(next)
            }}
            context={{ used: 64_000, window: 200_000 }}
            className="max-w-[680px]"
          />
        </div>
      </div>
      <p className="w-[900px] font-mono text-[11px] text-muted-foreground">
        ancora: {anchor ? `${anchor.itemId} +${anchor.offset}px` : '—'} · ultimo evento: {last || '—'}
      </p>
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
