// Servers listening on localhost from a project's folder or its worktrees: a mark next to the project name, and on hover
// the list with Open (in the Browser tab) and Stop. The host finds them, so it covers what an agent started in the background too.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Radio } from 'lucide-react'
import type { LocalServer, Project } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

const EMPTY: LocalServer[] = []

export function useProjectServers(projectId: string): LocalServer[] {
  return useApp(useShallow((s) => (s.localServers.some((server) => server.projectId === projectId) ? s.localServers.filter((server) => server.projectId === projectId) : EMPTY)))
}

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
export const portsText = (server: LocalServer) => `:${server.ports.join(', ')}`

export function stopServer(pid: number): Promise<unknown> {
  return request({ type: 'servers.stop', pid })
}

// The popover sits in a portal, but React events still bubble through the project row it belongs to (select, drag, menu).
const keepInside = {
  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onContextMenu: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onKeyDown: (event: { stopPropagation: () => void }) => event.stopPropagation()
}

/** Mark inside the project row. Clicks stay here: the row underneath would select the project. */
export function ServersMark({ project, servers }: { project: Project; servers: LocalServer[] }) {
  const [stopping, setStopping] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const label = plural(servers.length, '1 local server running', '{n} local servers running')

  const stop = async (pid: number) => {
    setError(null)
    setStopping((list) => [...list, pid])
    try {
      await stopServer(pid)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setStopping((list) => list.filter((p) => p !== pid))
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        nativeButton={false}
        render={<span />}
        // Inside the row's button the mark is for the mouse only: the keyboard reaches Stop from the project menu.
        aria-hidden
        tabIndex={-1}
        {...keepInside}
        className="grid size-4 shrink-0 place-items-center rounded-[4px] text-success"
      >
        <Radio aria-hidden className="size-3" strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 gap-1.5 p-2" {...keepInside}>
        <p className="px-1 text-xs font-medium text-muted-foreground">{label}</p>
        <ul className="flex flex-col">
          {servers.map((server) => {
            const port = server.ports[0]
            const elsewhere = server.cwd !== project.path
            return (
              <li key={server.pid} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-foreground" title={`localhost${portsText(server)}`}>localhost{portsText(server)}</p>
                  <p className="truncate text-xs text-muted-foreground" title={server.cwd}>
                    {server.command}
                    {elsewhere ? ` · ${folderName(server.cwd)}` : ''}
                  </p>
                </div>
                <Button size="xs" variant="ghost" onClick={() => useApp.getState().openBrowser(project.id, { url: `http://localhost:${port}`, fresh: true })}>
                  {t('Open')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={stopping.includes(server.pid)}
                  aria-label={t('Stop the server on {ports}', { ports: portsText(server) })}
                  onClick={() => void stop(server.pid)}
                >
                  {stopping.includes(server.pid) ? t('Stopping…') : t('Stop')}
                </Button>
              </li>
            )
          })}
        </ul>
        {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}

export function ProjectServers({ project }: { project: Project }) {
  const servers = useProjectServers(project.id)
  return servers.length > 0 ? <ServersMark project={project} servers={servers} /> : null
}
