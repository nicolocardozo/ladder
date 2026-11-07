// Menu di sessioni e progetti: le stesse azioni per il clic destro (sidebar e tab) e per il pulsante "…" della riga.
import { useRef, useState } from 'react'
import { Archive, CheckCheck, CircleDot, ExternalLink, FolderSearch, Pencil, SquarePen, Trash2 } from 'lucide-react'
import type { Project, SessionSummary } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useApp } from '@/store/app-store'

type Variant = 'context' | 'dropdown'

const parts = {
  context: { Content: ContextMenuContent, Item: ContextMenuItem, Separator: ContextMenuSeparator },
  dropdown: { Content: DropdownMenuContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
} as const

const contentClass = 'w-auto min-w-52'
const itemClass = 'gap-2 py-[5px] text-[13px] [&_svg]:size-[15px] [&_svg]:text-muted-foreground'

function openInCursor(path: string): void {
  void window.ladder?.openInEditor(path)
}

function revealInFinder(path: string): void {
  void window.ladder?.reveal(path)
}

interface SessionMenuProps {
  variant: Variant
  session: SessionSummary
  project: Project | null
}

/** Azioni su una sessione. Rinomina sposta il focus sul campo nella riga, quindi il menu non lo riporta al pulsante. */
export function SessionMenuContent({ variant, session, project }: SessionMenuProps) {
  const { Content, Item, Separator } = parts[variant]
  const startRename = useApp((s) => s.startRename)
  const archiveSession = useApp((s) => s.archiveSession)
  const markUnread = useApp((s) => s.markUnread)
  const markRead = useApp((s) => s.markRead)
  const sessionId = session.id

  return (
    <Content
      className={contentClass}
      align={variant === 'dropdown' ? 'end' : 'start'}
      finalFocus={() => useApp.getState().renaming !== sessionId}
    >
      <Item className={itemClass} onClick={() => startRename(sessionId)}>
        <Pencil />
        Rinomina
      </Item>
      {session.unread ? (
        <Item className={itemClass} onClick={() => markRead(sessionId)}>
          <CheckCheck />
          Segna come letta
        </Item>
      ) : (
        <Item className={itemClass} onClick={() => markUnread(sessionId)}>
          <CircleDot />
          Segna come da leggere
        </Item>
      )}
      {project && (
        <>
          <Item className={itemClass} onClick={() => openInCursor(project.path)}>
            <ExternalLink />
            Apri in Cursor
          </Item>
          <Item className={itemClass} onClick={() => revealInFinder(project.path)}>
            <FolderSearch />
            Mostra nel Finder
          </Item>
        </>
      )}
      <Separator />
      <Item className={itemClass} onClick={() => archiveSession(sessionId)}>
        <Archive />
        Archivia
      </Item>
    </Content>
  )
}

interface ProjectMenuProps {
  project: Project
  onRemove: () => void
}

/** Clic destro su un progetto. "Rimuovi" apre una conferma: il focus va alla finestra di dialogo. */
export function ProjectMenuContent({ project, onRemove }: ProjectMenuProps) {
  const select = useApp((s) => s.select)
  const removing = useRef(false)

  return (
    <ContextMenuContent
      className={contentClass}
      finalFocus={() => {
        const restore = !removing.current
        removing.current = false
        return restore
      }}
    >
      <ContextMenuItem className={itemClass} onClick={() => select({ kind: 'new', projectId: project.id })}>
        <SquarePen />
        Nuova chat
      </ContextMenuItem>
      <ContextMenuItem className={itemClass} onClick={() => openInCursor(project.path)}>
        <ExternalLink />
        Apri in Cursor
      </ContextMenuItem>
      <ContextMenuItem className={itemClass} onClick={() => revealInFinder(project.path)}>
        <FolderSearch />
        Mostra nel Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        className={itemClass}
        onClick={() => {
          removing.current = true
          onRemove()
        }}
      >
        <Trash2 />
        Rimuovi da Ladder…
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Conferma prima di togliere un progetto. Il focus parte da "Annulla". */
export function RemoveProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const removeProject = useApp((s) => s.removeProject)
  const sessions = useApp((s) => s.sessions)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Il testo resta visibile durante l'animazione di chiusura.
  const shown = useRef<Project | null>(project)
  if (project) shown.current = project
  const target = shown.current

  const active = target
    ? Object.values(sessions).filter((s) => s.projectId === target.id && !s.archived && s.run !== 'idle' && s.run !== 'error').length
    : 0

  const confirm = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await removeProject(target.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} initialFocus={cancelRef} className="gap-0 p-5 sm:max-w-[380px]">
        <DialogTitle className="text-[14px] font-semibold">Rimuovi il progetto da Ladder?</DialogTitle>
        <DialogDescription className="mt-2 text-[13px] leading-relaxed">
          {target && <span className="font-medium text-foreground">{target.name}</span>} esce dalla sidebar insieme alle sue chat. I file restano dove
          sono.
          {active > 0 && (
            <span className="mt-1.5 block text-attention">
              {active === 1 ? 'Una sessione è al lavoro e verrà fermata.' : `${active} sessioni sono al lavoro e verranno fermate.`}
            </span>
          )}
        </DialogDescription>
        {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" className="text-[13px]" onClick={onClose}>
            Annulla
          </Button>
          <Button variant="destructive" size="sm" className="text-[13px]" disabled={busy} onClick={() => void confirm()}>
            Rimuovi
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
