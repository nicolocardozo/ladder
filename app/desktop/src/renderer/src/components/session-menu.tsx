// Menu for sessions and projects: the same actions for the right click (sidebar and tabs) and for the row's "…" button.
import { useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, CircleStop, ArrowRightLeft, ArrowUp, Bookmark, Check, CheckCheck, CircleDot, Columns2, ExternalLink, FolderInput, FolderMinus, FolderPlus, FolderSearch, ListPlus, MessagesSquare, Pencil, RotateCw, Sparkles, SquarePen, Trash2 } from 'lucide-react'
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
import { portsText, stopServer, useProjectServers } from '@/components/local-servers'
import { groupSessionIds, liveColumns, useApp } from '@/store/app-store'

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

/** Editor choice for the project: the tab bar no longer has the button, the choice lives here and in Settings → Workspace. */
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

/** Actions on a session. Rename moves focus to the field in the row, so the menu does not return it to the button. */
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
  // Like openSplit: it needs a session to split from (the active column or the open one) and this one must not already be in a column.
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
        // Only agents that resume the conversation from a new process. After adding an MCP server or changing the agent's settings: the next message restarts with a new process.
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
          {/* The session's folder: its worktree if it has one, otherwise the project. */}
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
      {currentGroup && <ShiftInGroupItems variant={variant} session={session} groupId={currentGroup} />}
      <Separator />
      <Item className={itemClass} onClick={() => archiveSession(sessionId)}>
        <Archive />
        {t('Archive')}
      </Item>
    </Content>
  )
}

/**
 * Move up / Move down inside the session's group. A child of the open menu: the place in the group is computed only while
 * the menu is open, not for every row on every store update.
 */
function ShiftInGroupItems({ variant, session, groupId }: { variant: Variant; session: SessionSummary; groupId: string }) {
  const { Item } = parts[variant]
  const shiftInGroup = useApp((s) => s.shiftSessionInGroup)
  // "index/count": a string keeps the selector stable between renders.
  const place = useApp((s) => {
    const ids = groupSessionIds(s, session.projectId, groupId)
    return `${ids.indexOf(session.id)}/${ids.length}`
  })
  const [at, count] = place.split('/').map(Number)
  if (count < 2) return null
  return (
    <>
      <Item className={itemClass} disabled={at <= 0} onClick={() => shiftInGroup(session.projectId, session.id, -1)}>
        <ArrowUp />
        {t('Move up')}
      </Item>
      <Item className={itemClass} disabled={at < 0 || at >= count - 1} onClick={() => shiftInGroup(session.projectId, session.id, 1)}>
        <ArrowDown />
        {t('Move down')}
      </Item>
    </>
  )
}

/** Right click on a group. Removing the group leaves the chats in the project's list. */
export function GroupMenuContent({ projectId, groupId }: { projectId: string; groupId: string }) {
  const startRenameGroup = useApp((s) => s.startRenameGroup)
  const deleteGroup = useApp((s) => s.deleteGroup)
  const reorderGroups = useApp((s) => s.reorderGroups)
  const ids = useApp((s) => (s.ui[projectId]?.groups ?? []).map((g) => g.id).join('\n'))
    .split('\n')
    .filter(Boolean)
  const index = ids.indexOf(groupId)
  const shift = (delta: number) => {
    const next = [...ids]
    next.splice(index + delta, 0, ...next.splice(index, 1))
    reorderGroups(projectId, next)
  }
  return (
    <ContextMenuContent className={contentClass} finalFocus={() => !useApp.getState().renamingGroup}>
      <ContextMenuItem className={itemClass} onClick={() => startRenameGroup(groupId)}>
        <Pencil />
        {t('Rename')}
      </ContextMenuItem>
      {ids.length > 1 && (
        <>
          <ContextMenuItem className={itemClass} disabled={index <= 0} onClick={() => shift(-1)}>
            <ArrowUp />
            {t('Move up')}
          </ContextMenuItem>
          <ContextMenuItem className={itemClass} disabled={index < 0 || index >= ids.length - 1} onClick={() => shift(1)}>
            <ArrowDown />
            {t('Move down')}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem className={itemClass} onClick={() => deleteGroup(projectId, groupId)}>
        <FolderMinus />
        {t('Remove group')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Right click or "…" on a project section. Removing it leaves the projects in the sidebar, after those without a section. */
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

/** Right click or "…" on a project. "Remove" opens a confirmation: focus goes to the dialog. */
export function ProjectMenuContent({ project, onRemove, variant = 'context' }: ProjectMenuProps) {
  const { Content, Item, Separator, Sub, SubTrigger, SubContent } = parts[variant]
  const select = useApp((s) => s.select)
  const projects = useApp((s) => s.projects)
  const projectGroups = useApp((s) => s.projectGroups)
  const createProjectGroup = useApp((s) => s.createProjectGroup)
  const moveProject = useApp((s) => s.moveProject)
  const removing = useRef(false)
  const projectEditor = useEditorOf(project.id)
  const servers = useProjectServers(project.id)
  // Where the project sits: its section (null: outside any section) and its place among its neighbors.
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
        // After "New group" focus goes to the name field, after "Remove" to the dialog.
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
      {servers.length > 0 && <Separator />}
      {servers.map((server) => (
        <Item key={server.pid} className={itemClass} onClick={() => void stopServer(server.pid).catch(() => {})}>
          <CircleStop />
          {t('Stop localhost{ports}', { ports: portsText(server) })}
        </Item>
      ))}
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

/** Confirmation before removing a project. Focus starts on "Cancel". */
export function RemoveProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const removeProject = useApp((s) => s.removeProject)
  const sessions = useApp((s) => s.sessions)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The text stays visible during the closing animation.
  const shown = useRef<Project | null>(project)
  if (project) shown.current = project
  const target = shown.current

  const active = target
    ? Object.values(sessions).filter((s) => s.projectId === target.id && !s.archived && !s.parent && s.run !== 'idle' && s.run !== 'error').length
    : 0

  // The project name is bold inside the sentence: the translated text is split around {name}.
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
