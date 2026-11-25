// Menu di sessioni e progetti: le stesse azioni per il clic destro (sidebar e tab) e per il pulsante "…" della riga.
import { useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowRightLeft, ArrowUp, Bookmark, Check, CheckCheck, CircleDot, Columns2, ExternalLink, FolderInput, FolderMinus, FolderPlus, FolderSearch, ListPlus, MessagesSquare, Pencil, RotateCw, Sparkles, SquarePen, Trash2 } from 'lucide-react'
import type { Project, SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import { chooseEditor, EDITORS, EDITOR_NAME, openInEditor, useEditorOf, useInstalledEditors } from '@/components/inspector/open-file'
import { adviceBlockedReason } from '@/lib/advice'
import { handoffBlockedReason } from '@/lib/handoff'
import { layoutProjects } from '@/lib/project-groups'
import { openSavePreset } from '@/lib/session-presets'
import { request } from '@/lib/host-client'
import { liveColumns, useApp } from '@/store/app-store'

type Variant = 'context' | 'dropdown'

const parts = {
  context: { Content: ContextMenuContent, Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent },
  dropdown: { Content: DropdownMenuContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent }
} as const

const contentClass = 'w-auto min-w-52'
const itemClass = 'gap-2 py-[5px] text-sm [&_svg]:size-[15px] [&_svg]:text-muted-foreground'


function revealInFinder(path: string): void {
  void window.ladder?.reveal(path)
}

/** Scelta dell'editor per il progetto: la barra delle tab non ha più il pulsante, la scelta sta qui e in Impostazioni → Workspace. */
function EditorSub({ variant, project, itemClass: itemCls }: { variant: Variant; project: Project; itemClass: string }) {
  const { Item, Sub, SubTrigger, SubContent } = parts[variant]
  const current = useEditorOf(project.id)
  const installed = useInstalledEditors()
  return (
    <Sub>
      <SubTrigger className={itemCls}>
        <ExternalLink />
        {t('Editor for {project}', { project: project.name })}
      </SubTrigger>
      <SubContent className={contentClass}>
        {EDITORS.map((id) => (
          <Item key={id} className={itemCls} onClick={() => chooseEditor(project.id, id)}>
            <Check className={id === current ? undefined : 'opacity-0'} />
            {EDITOR_NAME[id]}
            {installed && !installed[id] && <span className="ml-auto pl-3 text-xs text-muted-foreground">{t('not installed')}</span>}
          </Item>
        ))}
      </SubContent>
    </Sub>
  )
}

interface SessionMenuProps {
  variant: Variant
  session: SessionSummary
  project: Project | null
}

/** Azioni su una sessione. Rinomina sposta il focus sul campo nella riga, quindi il menu non lo riporta al pulsante. */
export function SessionMenuContent({ variant, session, project }: SessionMenuProps) {
  const { Content, Item, Separator, Sub, SubTrigger, SubContent } = parts[variant]
  const groups = useApp((s) => s.ui[session.projectId]?.groups) ?? []
  const currentGroup = useApp((s) => s.ui[session.projectId]?.groupOf?.[session.id] ?? null)
  const createGroup = useApp((s) => s.createGroup)
  const moveToGroup = useApp((s) => s.moveToGroup)
  const startRename = useApp((s) => s.startRename)
  const regenerateTitle = useApp((s) => s.regenerateTitle)
  const archiveSession = useApp((s) => s.archiveSession)
  const markUnread = useApp((s) => s.markUnread)
  const markRead = useApp((s) => s.markRead)
  const openSplit = useApp((s) => s.openSplit)
  const sessionId = session.id
  const editor = useEditorOf(session.projectId)
  // Come openSplit: serve una sessione da cui affiancare (la colonna attiva o quella aperta) e questa non deve essere già in colonna.
  const canSplit = useApp((s) => {
    const columns = liveColumns(s, session.projectId)
    if (columns.includes(session.id)) return false
    if (columns.length > 0) return true
    return s.selection.kind === 'session' && s.selection.projectId === session.projectId && s.selection.sessionId !== session.id
  })

  return (
    <Content
      className={contentClass}
      align={variant === 'dropdown' ? 'end' : 'start'}
      finalFocus={() => useApp.getState().renaming !== sessionId && !useApp.getState().renamingGroup && useApp.getState().presetEditor === null}
    >
      <Item className={itemClass} onClick={() => startRename(sessionId)}>
        <Pencil />
        {t('Rename')}
      </Item>
      {session.mode === 'chat' && (session.agent === 'claude-code' || session.agent === 'codex') && (
        <Item className={itemClass} disabled={session.titleGenerating} onClick={() => regenerateTitle(sessionId)}>
          <Sparkles />
          {session.titleGenerating ? t('Generating title…') : t('Regenerate title')}
        </Item>
      )}
      {session.mode === 'chat' && (session.agent === 'claude-code' || session.agent === 'codex') && (
        // Solo gli agenti che riprendono la conversazione da un processo nuovo. Dopo aver aggiunto un server MCP o cambiato le impostazioni dell'agente: il prossimo messaggio riparte con un processo nuovo.
        <Item className={itemClass} onClick={() => void request({ type: 'session.restartAgent', sessionId }).catch(() => undefined)}>
          <RotateCw />
          {t('Restart agent')}
        </Item>
      )}
      {session.mode === 'chat' && !session.parent && (
        // Hand the work off to another agent; only when idle, until the session is archived.
        <Item className={itemClass} disabled={handoffBlockedReason(session) !== null} onClick={() => useApp.getState().setHandoffDialog({ sessionId })}>
          <ArrowRightLeft />
          {t('Hand off to…')}
          {handoffBlockedReason(session) && (
            <span className="ml-auto pl-3 text-xs text-muted-foreground" title={handoffBlockedReason(session) ?? undefined}>
              {session.archived ? t('Archived') : t('Working')}
            </span>
          )}
        </Item>
      )}
      {session.mode === 'chat' && !session.parent && (
        // Read-only advice from other agents. Also available while the session works.
        <Item className={itemClass} disabled={adviceBlockedReason(session) !== null} onClick={() => useApp.getState().setAdviceDialog({ sessionId, mode: 'advisor' })}>
          <MessagesSquare />
          {t('Ask for advice…')}
        </Item>
      )}
      <Item className={itemClass} disabled={!canSplit} onClick={() => openSplit(session.projectId, sessionId)}>
        <Columns2 />
        {t('Open side by side')}
      </Item>
      {session.unread ? (
        <Item className={itemClass} onClick={() => markRead(sessionId)}>
          <CheckCheck />
          {t('Mark as read')}
        </Item>
      ) : (
        <Item className={itemClass} onClick={() => markUnread(sessionId)}>
          <CircleDot />
          {t('Mark as unread')}
        </Item>
      )}
      {project && (
        <>
          {/* La cartella della sessione: il suo worktree se ce l'ha, altrimenti il progetto. */}
          <Item className={itemClass} onClick={() => openInEditor(project.id, session.cwd || project.path)}>
            <ExternalLink />
            {t('Open in {editor}', { editor: EDITOR_NAME[editor] })}
          </Item>
          <EditorSub variant={variant} project={project} itemClass={itemClass} />
          <Item className={itemClass} onClick={() => revealInFinder(project.path)}>
            <FolderSearch />
            {t('Show in Finder')}
          </Item>
        </>
      )}
      {session.mode === 'chat' && (
        <Item className={itemClass} onClick={() => openSavePreset(sessionId)}>
          <Bookmark />
          {t('Save as profile…')}
        </Item>
      )}
      <Sub>
        <SubTrigger className={itemClass}>
          <FolderInput />
          {t('Move to group')}
        </SubTrigger>
        <SubContent className={contentClass}>
          {groups.map((group) => (
            <Item key={group.id} className={itemClass} onClick={() => moveToGroup(session.projectId, sessionId, group.id)}>
              <Check className={group.id === currentGroup ? undefined : 'opacity-0'} />
              {group.name}
            </Item>
          ))}
          {groups.length > 0 && <Separator />}
          <Item className={itemClass} onClick={() => createGroup(session.projectId, sessionId)}>
            <FolderPlus />
            {t('New group')}
          </Item>
          {currentGroup && (
            <Item className={itemClass} onClick={() => moveToGroup(session.projectId, sessionId, null)}>
              <FolderMinus />
              {t('Remove from group')}
            </Item>
          )}
        </SubContent>
      </Sub>
      <Separator />
      <Item className={itemClass} onClick={() => archiveSession(sessionId)}>
        <Archive />
        {t('Archive')}
      </Item>
    </Content>
  )
}

/** Clic destro su un gruppo. Togliere il gruppo lascia le chat nella lista del progetto. */
export function GroupMenuContent({ projectId, groupId }: { projectId: string; groupId: string }) {
  const startRenameGroup = useApp((s) => s.startRenameGroup)
  const deleteGroup = useApp((s) => s.deleteGroup)
  return (
    <ContextMenuContent className={contentClass} finalFocus={() => !useApp.getState().renamingGroup}>
      <ContextMenuItem className={itemClass} onClick={() => startRenameGroup(groupId)}>
        <Pencil />
        {t('Rename')}
      </ContextMenuItem>
      <ContextMenuItem className={itemClass} onClick={() => deleteGroup(projectId, groupId)}>
        <FolderMinus />
        {t('Remove group')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Clic destro o "…" su una sezione di progetti. Toglierla lascia i progetti nella sidebar, in coda a quelli senza sezione. */
export function ProjectGroupMenuContent({ groupId, variant = 'context' }: { groupId: string; variant?: Variant }) {
  const { Content, Item, Separator } = parts[variant]
  const groups = useApp((s) => s.projectGroups?.groups)
  const startRename = useApp((s) => s.startRenameProjectGroup)
  const deleteGroup = useApp((s) => s.deleteProjectGroup)
  const reorder = useApp((s) => s.reorderProjectGroups)
  const ids = (groups ?? []).map((g) => g.id)
  const index = ids.indexOf(groupId)
  const shift = (delta: number) => {
    const next = [...ids]
    next.splice(index + delta, 0, ...next.splice(index, 1))
    reorder(next)
  }
  return (
    <Content className={contentClass} align={variant === 'dropdown' ? 'end' : 'start'} finalFocus={() => !useApp.getState().renamingProjectGroup}>
      <Item className={itemClass} onClick={() => startRename(groupId)}>
        <Pencil />
        {t('Rename')}
      </Item>
      <Item className={itemClass} disabled={index <= 0} onClick={() => shift(-1)}>
        <ArrowUp />
        {t('Move up')}
      </Item>
      <Item className={itemClass} disabled={index < 0 || index >= ids.length - 1} onClick={() => shift(1)}>
        <ArrowDown />
        {t('Move down')}
      </Item>
      <Separator />
      <Item className={itemClass} onClick={() => deleteGroup(groupId)}>
        <FolderMinus />
        {t('Remove section')}
      </Item>
    </Content>
  )
}

interface ProjectMenuProps {
  project: Project
  onRemove: () => void
  variant?: Variant
}

/** Clic destro o "…" su un progetto. "Rimuovi" apre una conferma: il focus va alla finestra di dialogo. */
export function ProjectMenuContent({ project, onRemove, variant = 'context' }: ProjectMenuProps) {
  const { Content, Item, Separator, Sub, SubTrigger, SubContent } = parts[variant]
  const select = useApp((s) => s.select)
  const projects = useApp((s) => s.projects)
  const projectGroups = useApp((s) => s.projectGroups)
  const createProjectGroup = useApp((s) => s.createProjectGroup)
  const moveProject = useApp((s) => s.moveProject)
  const removing = useRef(false)
  const projectEditor = useEditorOf(project.id)
  // Dove sta il progetto: la sua sezione (null: fuori da ogni sezione) e il posto tra i vicini.
  const place = useMemo(() => {
    const layout = layoutProjects(projects, projectGroups)
    const sections = layout.sections.map(({ group }) => group)
    const home = layout.sections.find(({ projects: list }) => list.some((p) => p.id === project.id))
    const list = home ? home.projects : layout.ungrouped
    return { sections, groupId: home?.group.id ?? null, index: list.findIndex((p) => p.id === project.id), count: list.length }
  }, [projects, projectGroups, project.id])

  return (
    <Content
      className={contentClass}
      align={variant === 'dropdown' ? 'end' : 'start'}
      finalFocus={() => {
        // Dopo "Nuovo gruppo" il focus va al campo del nome, dopo "Rimuovi" alla finestra di dialogo.
        const restore = !removing.current && !useApp.getState().renamingGroup && !useApp.getState().renamingProjectGroup
        removing.current = false
        return restore
      }}
    >
      <Item
        className={itemClass}
        onClick={() => {
          useApp.getState().selectProject(project.id)
          useApp.getState().createGroup(project.id)
        }}
      >
        <FolderPlus />
        {t('New group')}
      </Item>
      <Item className={itemClass} onClick={() => select({ kind: 'new', projectId: project.id })}>
        <SquarePen />
        {t('New chat')}
      </Item>
      <Item className={itemClass} onClick={() => openInEditor(project.id, project.path)}>
        <ExternalLink />
        {t('Open in {editor}', { editor: EDITOR_NAME[projectEditor] })}
      </Item>
      <EditorSub variant={variant} project={project} itemClass={itemClass} />
      <Item className={itemClass} onClick={() => revealInFinder(project.path)}>
        <FolderSearch />
        {t('Show in Finder')}
      </Item>
      <Separator />
      <Sub>
        <SubTrigger className={itemClass}>
          <FolderInput />
          {t('Move to section')}
        </SubTrigger>
        <SubContent className={contentClass}>
          {place.sections.map((group) => (
            <Item key={group.id} className={itemClass} onClick={() => group.id !== place.groupId && moveProject(project.id, group.id)}>
              <Check className={group.id === place.groupId ? undefined : 'opacity-0'} />
              {group.name}
            </Item>
          ))}
          {place.sections.length > 0 && <Separator />}
          <Item className={itemClass} onClick={() => void createProjectGroup([project.id])}>
            <ListPlus />
            {t('New section')}
          </Item>
          {place.groupId && (
            <Item className={itemClass} onClick={() => moveProject(project.id, null)}>
              <FolderMinus />
              {t('Remove from section')}
            </Item>
          )}
        </SubContent>
      </Sub>
      <Item className={itemClass} disabled={place.index <= 0} onClick={() => moveProject(project.id, place.groupId, place.index - 1)}>
        <ArrowUp />
        {t('Move up')}
      </Item>
      <Item className={itemClass} disabled={place.index < 0 || place.index >= place.count - 1} onClick={() => moveProject(project.id, place.groupId, place.index + 1)}>
        <ArrowDown />
        {t('Move down')}
      </Item>
      <Separator />
      <Item
        variant="destructive"
        className={itemClass}
        onClick={() => {
          removing.current = true
          onRemove()
        }}
      >
        <Trash2 />
        {t('Remove from Ladder…')}
      </Item>
    </Content>
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
    ? Object.values(sessions).filter((s) => s.projectId === target.id && !s.archived && !s.parent && s.run !== 'idle' && s.run !== 'error').length
    : 0

  // Il nome del progetto sta in grassetto dentro la frase: si divide il testo tradotto attorno a {name}.
  const [before, after = ''] = t('{name} leaves the sidebar along with its chats. Its files stay where they are.').split('{name}')

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
        <DialogTitle className="text-base font-semibold">{t('Remove project from Ladder?')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-relaxed">
          {before}
          {target && <span className="font-medium text-foreground">{target.name}</span>}
          {after}
          {active > 0 && (
            <span className="mt-1.5 block text-attention">
              {plural(active, 'One session is running and will be stopped.', '{n} sessions are running and will be stopped.')}
            </span>
          )}
        </DialogDescription>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" className="text-sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="destructive" size="sm" className="text-sm" disabled={busy} onClick={() => void confirm()}>
            {t('Remove project')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
