// View actions in the top bar, on the right next to terminal and panel: side-by-side chats and opening the browser column.
// "Split" is an explicit menu (new chat alongside, or which session); the browser is a toggle.
import { Columns2, Globe, Plus, Smartphone } from 'lucide-react'
import { t } from '@shared/i18n'
import { shortcutLabel } from '@shared/shortcuts'
import { AgentMark } from '@/components/agent-mark'
import { SessionGlyph } from '@/components/status'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettings } from '@/hooks/use-theme'
import { connectedLabel } from '@/lib/remote'
import { isMac } from '@/lib/send-key'
import { sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { MAX_COLUMNS, isBrowserColumnOpen, isLiveSession, liveColumns, useApp } from '@/store/app-store'

const NO_TABS: string[] = []
const trigger =
  'no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground'

/**
 * Split: a new chat next to the open one, or one of the chats already open in tabs.
 * Chats already in a column do not appear; with three columns the menu says so and offers nothing else.
 */
export function SplitMenu({ projectId }: { projectId: string }) {
  const tabs = useApp((s) => s.ui[projectId]?.tabs ?? NO_TABS)
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  const ui = useApp((s) => s.ui)
  const selection = useApp((s) => s.selection)
  const currentId = selection.kind === 'session' && selection.projectId === projectId ? selection.sessionId : null
  if (!currentId) return null
  const state = { projects, sessions, ui }
  const columns = liveColumns(state, projectId)
  const shown = columns.length > 0 ? columns : [currentId]
  const full = columns.length >= MAX_COLUMNS
  const others = tabs.filter((id) => !shown.includes(id) && isLiveSession(state, sessions[id]) && sessions[id].projectId === projectId)
  const { openSplit, splitActive } = useApp.getState()
  const modKey = isMac ? '⌘' : 'Ctrl'
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger aria-label={t('Split')} className={cn(trigger, columns.length > 1 && 'text-foreground')} />}>
          <Columns2 aria-hidden className="size-4" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('Split')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        {full ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('Maximum three columns. Close one to add another.')}</p>
        ) : (
          <>
            <DropdownMenuItem onClick={() => splitActive()}>
              <Plus aria-hidden />
              {t('New chat beside this one')}
              {shortcutLabel('chat.split') && <Kbd className="ml-auto pl-3">{shortcutLabel('chat.split')}</Kbd>}
            </DropdownMenuItem>
            {others.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('Put beside this one')}</DropdownMenuLabel>
                  {others.map((id) => (
                    <DropdownMenuItem key={id} onClick={() => openSplit(projectId, id)}>
                      <span className="grid w-3 shrink-0 place-items-center">
                        <SessionGlyph state={sessionState(sessions[id])} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{sessions[id].title}</span>
                      <AgentMark agent={sessions[id].agent} size={12} className="shrink-0 text-muted-foreground" />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-xs text-muted-foreground">{t('{key}click a tab to add or remove its column', { key: modKey })}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Project browser: opens or closes the column to the right of the chats. Without pages it creates one. */
export function BrowserToggle({ projectId }: { projectId: string }) {
  const open = useApp((s) => isBrowserColumnOpen(s, projectId))
  const label = open ? t('Hide browser') : t('Browser')
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={open}
        onClick={() => useApp.getState().toggleBrowserColumn(projectId)}
        className={cn(trigger, open && 'bg-accent text-foreground')}
      >
        <Globe aria-hidden className="size-4" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Phone connected: only present when at least one phone is connected right now. Muted tone, the number only from two up;
 * clicking opens Settings → Devices.
 */
export function PhoneIndicator() {
  const count = useApp((s) => s.remote?.connectedCount ?? 0)
  if (count < 1) return null
  const label = connectedLabel(count)
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        onClick={() => useSettings.getState().openSection('devices')}
        className={cn(trigger, 'w-auto min-w-7 grid-flow-col place-content-center gap-1', count > 1 && 'px-1.5')}
      >
        <Smartphone aria-hidden className="size-4" strokeWidth={1.75} />
        {count > 1 && <span aria-hidden className="text-xs tabular-nums">{count}</span>}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
