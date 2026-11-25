// ⌘P: opens a file in the session folder by name, in the inspector viewer. ⌥↵ opens it in the editor.
import { useEffect, useMemo, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { useShallow } from 'zustand/react/shallow'
import { File, Search } from 'lucide-react'
import type { FileTree } from '@shared/protocol'
import { t } from '@shared/i18n'
import { indexFromPaths, rankFiles, type FileIndex } from '@/components/composer/file-index'
import { openInEditor } from '@/components/inspector/open-file'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import { Kbd } from '@/components/ui/kbd'

/** Working folder for the selection: the session's worktree or the project. */
export function useSelectionRoot(): { projectId: string | null; root: string | null } {
  return useApp(
    useShallow((s) => {
      const selection = s.selection
      if (selection.kind === 'session') {
        const session = s.sessions[selection.sessionId]
        return { projectId: selection.projectId, root: session?.cwd ?? s.projects.find((p) => p.id === selection.projectId)?.path ?? null }
      }
      const project = s.projects.find((p) => p.id === selection.projectId)
      return { projectId: project?.id ?? null, root: project?.path ?? null }
    })
  )
}

export function QuickOpen() {
  const open = useApp((s) => s.quickOpen)
  const setOpen = useApp((s) => s.setQuickOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[13vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-[560px]">
        <DialogTitle className="sr-only">{t('Open file')}</DialogTitle>
        <DialogDescription className="sr-only">{t('Files in the session folder, by name or path.')}</DialogDescription>
        <QuickOpenBody onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function QuickOpenBody({ onClose }: { onClose: () => void }) {
  const { projectId, root } = useSelectionRoot()
  const openInspector = useApp((s) => s.openInspector)
  const [index, setIndex] = useState<FileIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')

  useEffect(() => {
    if (!root) return
    request<FileTree>({ type: 'fs.tree', root })
      .then((tree) => setIndex(indexFromPaths(tree.files)))
      .catch((e: Error) => setError(e.message))
  }, [root])

  // "path:line" opens at the line.
  const [pathQuery, line] = useMemo(() => {
    const match = /^(.*?):(\d+)$/.exec(query.trim())
    return match ? [match[1], Number(match[2])] : [query.trim(), undefined]
  }, [query])
  const results = useMemo(() => (index ? rankFiles(index, pathQuery, 40) : []), [index, pathQuery])

  const choose = (path: string, external: boolean) => {
    if (!projectId || !root) return
    onClose()
    if (external) openInEditor(projectId, `${root}/${path}`, line)
    else openInspector(projectId, 'files', { path, line })
  }

  return (
    <Command
      shouldFilter={false}
      loop
      label={t('Open file')}
      value={selected}
      onValueChange={setSelected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.altKey && selected) {
          e.preventDefault()
          choose(selected, true)
        }
      }}
      className="rounded-none! bg-popover p-0"
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          placeholder={root ? t('File name, or path:line…') : t('Add a project to search its files')}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
      </div>
      <CommandList className="max-h-[min(420px,56vh)] px-1.5 py-1.5">
        <CommandEmpty className="py-8 text-sm text-muted-foreground">
          {error ?? (index ? t('No files match “{query}”.', { query: pathQuery }) : t('Reading files…'))}
        </CommandEmpty>
        {results.map((entry) => (
          <CommandItem
            key={entry.path}
            value={entry.path}
            className="gap-2.5 px-2.5 py-[7px] text-sm data-selected:bg-accent"
            onSelect={() => choose(entry.path, false)}
          >
            <File className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
            <span className="shrink-0 font-medium">{entry.base}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{entry.dir}</span>
          </CommandItem>
        ))}
      </CommandList>
      <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-xs text-faint">
        <span>
          <Kbd>↵</Kbd> {t('open in viewer')}
        </span>
        <span>
          <Kbd>⌥↵</Kbd> {t('open in editor')}
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> {t('to close')}
        </span>
      </div>
    </Command>
  )
}
