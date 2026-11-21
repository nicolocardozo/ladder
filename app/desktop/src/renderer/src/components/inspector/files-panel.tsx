// Pannello File: albero della cartella della sessione con stato git, filtro, viewer in sola lettura.
// I file toccati dalla sessione portano il turno che li ha modificati per ultimo.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, ExternalLink, File, Folder, FolderOpen, MessageSquarePlus, Search, X, Pencil } from 'lucide-react'
import type { ChatItem, FileContent, FileTree, GitStatusCode } from '@shared/protocol'
import { resolveLang } from '@/components/chat/highlighter'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp, type InspectorRequest } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { PanelNote, ToolbarButton } from './changes-panel'
import { CodeText, useFileTokens } from './code-lines'
import { openInEditor } from './open-file'

interface TreeNode {
  name: string
  path: string
  dir: boolean
  children: TreeNode[]
}

interface Row {
  node: TreeNode
  depth: number
}

const STATUS_LABEL: Record<GitStatusCode, string> = { M: 'Modified', A: 'Added', D: 'Deleted', '?': 'Untracked', U: 'Conflicted' }
const expandedByRoot = new Map<string, Set<string>>()
/** File aperto nel viewer per cartella: resta quando cambi scheda e torni. */
const openByRoot = new Map<string, { path: string; line: number | null; nonce: number } | null>()
let handledNonce = 0

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  const dirs = new Map<string, TreeNode>([['', root]])
  for (const file of files) {
    const parts = file.split('/')
    let parent = root
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      let dir = dirs.get(prefix)
      if (!dir) {
        dir = { name: parts[i], path: prefix, dir: true, children: [] }
        dirs.set(prefix, dir)
        parent.children.push(dir)
      }
      parent = dir
    }
    parent.children.push({ name: parts[parts.length - 1], path: file, dir: false, children: [] })
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const child of node.children) if (child.dir) sort(child)
  }
  sort(root)
  return root
}

function flatten(node: TreeNode, expanded: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const child of node.children) {
    out.push({ node: child, depth })
    if (child.dir && expanded.has(child.path)) flatten(child, expanded, depth + 1, out)
  }
  return out
}

/** Ultimo turno che ha toccato ogni file, numerato come nella chat. */
function touchedByTurn(items: ChatItem[]): Map<string, number> {
  const map = new Map<string, number>()
  let index = 0
  for (const item of items) {
    if (item.kind !== 'turn-end') continue
    index++
    for (const file of item.files) map.set(file.path, index)
  }
  return map
}

interface FilesPanelProps {
  projectId: string
  root: string
  items: ChatItem[]
  composerKey: string | null
  request: InspectorRequest | null
}

export function FilesPanel({ projectId, root, items, composerKey, request: openRequest }: FilesPanelProps) {
  const [tree, setTree] = useState<FileTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpenState] = useState<{ path: string; line: number | null; nonce: number } | null>(() => {
    if (openRequest?.tab === 'files' && openRequest.path && openRequest.nonce > handledNonce) {
      handledNonce = openRequest.nonce
      return { path: openRequest.path, line: openRequest.line ?? null, nonce: openRequest.nonce }
    }
    return openByRoot.get(root) ?? null
  })
  const setOpen = (value: { path: string; line: number | null; nonce: number } | null) => {
    openByRoot.set(root, value)
    setOpenState(value)
  }
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedByRoot.get(root) ?? new Set())
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const touched = useMemo(() => touchedByTurn(items), [items])
  const scroller = useRef<HTMLDivElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)

  // "Cerca nel progetto" (scorciatoia o palette): il focus va sul filtro, con il testo già scritto selezionato.
  const focusRequest = useApp((s) => (s.filesFilterFocus?.projectId === projectId ? s.filesFilterFocus : null))
  useEffect(() => {
    if (!focusRequest || error) return
    filterInput.current?.focus()
    filterInput.current?.select()
    useApp.getState().consumeFilesFilterFocus(focusRequest.nonce)
  }, [focusRequest, error])

  useEffect(() => {
    setExpanded(expandedByRoot.get(root) ?? new Set())
    if (open) revealInTree(open.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  useEffect(() => {
    let cancelled = false
    request<FileTree>({ type: 'fs.tree', root })
      .then((data) => {
        if (!cancelled) {
          setTree(data)
          setError(null)
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [root, version])

  // Richiesta dall'esterno (chip nella chat, ⌘P, diff): apre il file e le sue cartelle.
  useEffect(() => {
    if (!openRequest || openRequest.tab !== 'files' || !openRequest.path || openRequest.nonce <= handledNonce) return
    handledNonce = openRequest.nonce
    setOpen({ path: openRequest.path, line: openRequest.line ?? null, nonce: openRequest.nonce })
    revealInTree(openRequest.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])

  const toggle = (path: string, force?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (force ?? !next.has(path)) next.add(path)
      else next.delete(path)
      expandedByRoot.set(root, next)
      return next
    })

  const revealInTree = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      expandedByRoot.set(root, next)
      return next
    })

  const root_ = useMemo(() => (tree ? buildTree(tree.files) : null), [tree])
  const changedDirs = useMemo(() => {
    const set = new Set<string>()
    for (const path of Object.keys(tree?.status ?? {})) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return set
  }, [tree])
  const rows = useMemo<Row[]>(() => {
    if (!root_ || !tree) return []
    const query = filter.trim().toLowerCase()
    if (query) {
      return tree.files
        .filter((f) => f.toLowerCase().includes(query))
        .slice(0, 400)
        .map((path) => ({ node: { name: path, path, dir: false, children: [] }, depth: 0 }))
    }
    return flatten(root_, expanded)
  }, [root_, tree, filter, expanded])

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 24, overscan: 12 })

  // Il file aperto da fuori scorre in vista nell'albero.
  useEffect(() => {
    if (!open) return
    const index = rows.findIndex((r) => r.node.path === open.path)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.nonce, rows.length])

  if (error) return <PanelNote tone="error">{error}</PanelNote>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          ref={filterInput}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          placeholder={t('Filter files…  (⌘P opens by name)')}
          aria-label={t('Filter files')}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        {tree?.truncated && <span className="text-xs text-faint">{t('first 20,000')}</span>}
      </div>
      <div ref={scroller} className={cn('min-h-0 overflow-y-auto', open ? 'h-[38%] shrink-0 border-b border-border' : 'flex-1')} role="tree" aria-label={t('Folder files')}>
        {!tree ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t('Reading folder…')}</p>
        ) : rows.length === 0 ? (
          <PanelNote>{filter ? t('No files match “{filter}”.', { filter }) : t('The folder is empty.')}</PanelNote>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const { node, depth } = rows[v.index]
              const status = tree.status[node.path]
              const turn = touched.get(node.path)
              const selected = open?.path === node.path
              const isOpen = node.dir && expanded.has(node.path)
              return (
                <button
                  key={node.path}
                  type="button"
                  role="treeitem"
                  aria-expanded={node.dir ? isOpen : undefined}
                  aria-selected={selected}
                  onClick={(event) => {
                    if (node.dir) toggle(node.path)
                    else if (event.altKey) openInEditor(projectId, `${root}/${node.path}`)
                    else setOpen({ path: node.path, line: null, nonce: Date.now() })
                  }}
                  onDoubleClick={() => !node.dir && useApp.getState().openFile(projectId, root, node.path)}
                  title={status ? `${node.path} · ${t(STATUS_LABEL[status])}` : node.path}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)`, paddingLeft: 8 + depth * 14 }}
                  className={cn(
                    'flex items-center gap-1.5 pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent',
                    selected && 'bg-accent text-accent-foreground'
                  )}
                >
                  {node.dir ? (
                    <>
                      {isOpen ? <ChevronDown className="size-3 shrink-0 text-faint" /> : <ChevronRight className="size-3 shrink-0 text-faint" />}
                      {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
                    </>
                  ) : (
                    <File className={cn('size-3.5 shrink-0 text-muted-foreground', !filter && 'ml-[18px]')} />
                  )}
                  <span className={cn('min-w-0 flex-1 truncate', status === 'D' && 'text-muted-foreground line-through', filter && 'font-mono text-xs')}>{node.name}</span>
                  {node.dir && changedDirs.has(node.path) && <span aria-label={t('Contains changes')} className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />}
                  {turn && (
                    <span title={t('Modified in turn {turn}', { turn })} className="shrink-0 rounded border border-border px-1 font-mono text-xs text-muted-foreground">
                      T{turn}
                    </span>
                  )}
                  {status && (
                    <span aria-label={t(STATUS_LABEL[status])} className={cn('w-3 shrink-0 text-center font-mono text-xs', status === 'U' ? 'text-destructive' : 'text-muted-foreground')}>
                      {status}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {open && (
        <FileViewer
          key={`${root}|${open.path}`}
          projectId={projectId}
          root={root}
          path={open.path}
          line={open.line}
          lineNonce={open.nonce}
          version={version}
          composerKey={composerKey}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

interface FileViewerProps {
  projectId: string
  root: string
  path: string
  line: number | null
  lineNonce: number
  version: number
  composerKey: string | null
  onClose: () => void
}

function FileViewer({ projectId, root, path, line, lineNonce, version, composerKey, onClose }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  const insert = useApp((s) => s.insertIntoComposer)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    request<FileContent>({ type: 'fs.read', root, path })
      .then((data) => {
        if (!cancelled) {
          setContent(data)
          setError(null)
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [root, path, version])

  const lines = useMemo(() => {
    const all = (content?.text ?? '').split('\n')
    // L'a capo finale non è una riga in più.
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    return all
  }, [content?.text])
  const tokens = useFileTokens(content?.text ?? null, path)
  const virtualizer = useVirtualizer({ count: content?.text != null ? lines.length : 0, getScrollElement: () => scroller.current, estimateSize: () => 19, overscan: 30 })

  useEffect(() => {
    if (line && content?.text != null) virtualizer.scrollToIndex(Math.max(0, line - 1), { align: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineNonce, content?.text != null])

  // Selezione nel viewer: righe di inizio e fine dagli attributi data-line.
  const onMouseUp = () => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    if (!sel || !text.trim() || !scroller.current?.contains(sel.anchorNode)) {
      setSelection(null)
      return
    }
    const lineOf = (node: Node | null) => Number((node instanceof Element ? node : node?.parentElement)?.closest('[data-line]')?.getAttribute('data-line') ?? 0)
    const a = lineOf(sel.anchorNode)
    const b = lineOf(sel.focusNode)
    if (!a || !b) return
    setSelection({ from: Math.min(a, b), to: Math.max(a, b), text })
  }

  const addToChat = () => {
    if (!selection || !composerKey) return
    const range = selection.from === selection.to ? `${selection.from}` : `${selection.from}-${selection.to}`
    const lang = resolveLang(path) ?? ''
    insert(composerKey, `\`${path}:${range}\`\n\`\`\`${lang}\n${selection.text.replace(/\n$/, '')}\n\`\`\`\n`)
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        {content?.text != null && <span className="shrink-0 text-xs text-faint">{plural(lines.length, '{n} line', '{n} lines')}</span>}
        {content?.text != null && (
          <ToolbarButton label={t('Edit file')} onClick={() => useApp.getState().openFile(projectId, root, path)}>
            <Pencil className="size-3.5" />
          </ToolbarButton>
        )}
        <ToolbarButton label={t('Open in editor')} onClick={() => openInEditor(projectId, `${root}/${path}`, line ?? undefined)}>
          <ExternalLink className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t('Close file')} onClick={onClose}>
          <X className="size-3.5" />
        </ToolbarButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {selection && composerKey && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={addToChat}
            className="absolute top-2 right-3 z-10 inline-flex h-7 items-center whitespace-nowrap gap-1.5 rounded-md border border-input bg-popover px-2 text-xs text-popover-foreground shadow-sm outline-none hover:bg-accent"
          >
            <MessageSquarePlus className="size-3.5" />
            {selection.from === selection.to
              ? t('Add to chat · line {range}', { range: selection.from })
              : t('Add to chat · lines {range}', { range: `${selection.from}–${selection.to}` })}
          </button>
        )}
        <div ref={scroller} onMouseUp={onMouseUp} className="absolute inset-0 overflow-auto bg-code-bg">
          {error ? (
            <PanelNote tone="error">{error}</PanelNote>
          ) : !content ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('Opening file…')}</p>
          ) : content.binary ? (
            <PanelNote>{t('Binary file. Open it in the editor or in Finder.')}</PanelNote>
          ) : content.tooLarge ? (
            <PanelNote>{t('File too large for the viewer ({size} KB). Open it in the editor.', { size: Math.round(content.size / 1024) })}</PanelNote>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }} className="font-mono text-xs leading-[19px]">
              {virtualizer.getVirtualItems().map((v) => {
                const n = v.index + 1
                return (
                  <div
                    key={v.index}
                    data-line={n}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }}
                    className={cn('flex whitespace-pre', n === line && 'bg-[color-mix(in_oklab,var(--ladder-waiting)_18%,transparent)]')}
                  >
                    <span className="sticky left-0 w-12 shrink-0 bg-code-bg pr-3 text-right text-faint select-none tabular-nums">{n}</span>
                    <span className="pr-4">
                      <CodeText text={lines[v.index]} tokens={tokens?.[v.index]} />
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
