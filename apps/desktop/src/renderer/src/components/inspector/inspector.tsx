// Ispettore a destra: Modifiche (⌘⌥1), File (⌘⌥2), Cronologia (⌘⌥3) sulla cartella della sessione.
import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { ChatItem, InspectorTab, SessionSummary } from '@shared/protocol'
import { send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { ChangesPanel } from './changes-panel'
import { FilesPanel } from './files-panel'
import { HistoryPanel } from './history-panel'

const WIDTH_KEY = 'ladder.inspector-width'
const NO_ITEMS: ChatItem[] = []

const TABS: { id: InspectorTab; label: string; key: string }[] = [
  { id: 'changes', label: 'Modifiche', key: '⌘⌥1' },
  { id: 'files', label: 'File', key: '⌘⌥2' },
  { id: 'history', label: 'Cronologia', key: '⌘⌥3' }
]

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return value >= 320 ? value : 460
  } catch {
    return 460
  }
}

interface InspectorProps {
  projectId: string
  root: string
  isGit: boolean
  session: SessionSummary | null
  composerKey: string | null
}

export function Inspector({ projectId, root, isGit, session, composerKey }: InspectorProps) {
  const tab = useApp((s) => s.ui[projectId]?.inspector?.tab ?? 'changes')
  const toggle = useApp((s) => s.toggleInspector)
  const items = useApp((s) => (session ? (s.items[session.id] ?? NO_ITEMS) : NO_ITEMS))
  const openRequest = useApp((s) => (s.inspectorRequest?.projectId === projectId ? s.inspectorRequest : null))
  const [width, setWidth] = useState(readWidth)

  // L'host osserva la cartella finché l'ispettore è aperto: albero, stato e diff "attuali" si aggiornano da soli.
  useEffect(() => {
    send({ type: 'fs.watch', root, on: true })
    return () => send({ type: 'fs.watch', root, on: false })
  }, [root])

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const start = width
    let latest = start
    const move = (e: PointerEvent) => {
      latest = Math.min(Math.round(window.innerWidth * 0.62), Math.max(320, start + startX - e.clientX))
      setWidth(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(WIDTH_KEY, String(latest))
      } catch {
        // Solo una comodità.
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  let body: ReactNode
  if (tab === 'changes') body = <ChangesPanel key={root} projectId={projectId} root={root} isGit={isGit} session={session} items={items} request={openRequest} />
  else if (tab === 'files') body = <FilesPanel key={root} projectId={projectId} root={root} items={items} composerKey={composerKey} request={openRequest} />
  else body = <HistoryPanel key={root} projectId={projectId} root={root} isGit={isGit} session={session} />

  return (
    <aside aria-label="Ispettore" className="relative flex shrink-0 flex-col border-l border-border bg-background" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Ridimensiona l’ispettore"
        onPointerDown={startResize}
        className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2" role="tablist" aria-label="Pannelli dell’ispettore">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            title={`${t.label} (${t.key})`}
            onClick={() => tab !== t.id && toggle(projectId, t.id)}
            className={cn(
              'no-drag h-7 rounded-md px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              tab === t.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          aria-label="Chiudi l’ispettore"
          title="Chiudi"
          onClick={() => toggle(projectId)}
          className="no-drag ml-auto grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {body}
    </aside>
  )
}
