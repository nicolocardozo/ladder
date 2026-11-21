// Un file aperto come tab, accanto alle chat. Il punto delicato è l'agente che scrive lo stesso file: non si sovrascrive mai in silenzio.
import { shortcutLabel } from '@shared/shortcuts'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import type { FileContent } from '@shared/protocol'
import { fileTabId } from '@shared/file-tabs'
import { t } from '@shared/i18n'
import { createBuffer, currentDoc, getBuffer, replaceDoc, saveBuffer, toText, type FileBuffer } from '@/components/editor/buffers'
import { CodeEditor } from '@/components/editor/code-editor'
import { TopBar, Workspace } from '@/components/main-views'
import { TabBar } from '@/components/tab-bar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { openInEditor } from '@/components/inspector/open-file'
import { Kbd } from '@/components/ui/kbd'
import { request, send } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

interface Conflict {
  text: string
  mtime: number
}

function Banner({ tone, children }: { tone: 'info' | 'attention' | 'error'; children: ReactNode }) {
  const color = tone === 'error' ? 'text-destructive' : tone === 'attention' ? 'text-attention' : 'text-muted-foreground'
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
      <TriangleAlert aria-hidden className={`size-3.5 shrink-0 ${color}`} />
      {children}
    </div>
  )
}

const action = 'h-6 shrink-0 rounded-md border border-input px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

export function FileTabView({ projectId, root, path }: { projectId: string; root: string; path: string }) {
  useShortcutsRevision()
  const project = useApp((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const id = fileTabId(root, path)
  const dirty = useApp((s) => Boolean(s.dirtyFiles[id]))
  const setFileDirty = useApp((s) => s.setFileDirty)
  // Scrivi mentre un agente lavora nella stessa cartella: si può, ma lo devi sapere.
  const agentWorking = useApp((s) => Object.values(s.sessions).some((x) => !x.archived && x.cwd === root && (x.run === 'running' || x.run === 'starting' || x.run === 'waiting')))
  const [buffer, setBuffer] = useState<FileBuffer | null>(() => getBuffer(id) ?? null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [comparing, setComparing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const latest = useRef({ conflict })
  latest.current = { conflict }

  useEffect(() => {
    send({ type: 'fs.watch', root, on: true })
    return () => send({ type: 'fs.watch', root, on: false })
  }, [root])

  useEffect(() => {
    let cancelled = false
    request<FileContent>({ type: 'fs.read', root, path })
      .then((content) => {
        if (cancelled) return
        setMissing(false)
        if (content.binary) return setUnavailable(t('Binary file: it can’t be edited here.'))
        if (content.tooLarge) return setUnavailable(t('File too large to edit here ({size} KB).', { size: Math.round(content.size / 1024) }))
        // Un byte non valido in UTF-8 si perderebbe al salvataggio.
        if (content.text === null || content.text.includes('�')) return setUnavailable(t('This file isn’t UTF-8: it can’t be edited here.'))
        setUnavailable(null)
        const existing = getBuffer(id)
        if (!existing) {
          setBuffer(createBuffer(id, root, path, content.text, content.mtimeMs))
          return
        }
        setBuffer(existing)
        if (existing.saving) return
        const disk = toText(content.text)
        if (disk.eq(currentDoc(existing))) {
          // Il disco e l'editor dicono la stessa cosa: nessun conflitto, nemmeno se prima c'era.
          existing.saved = disk
          existing.mtime = content.mtimeMs
          setFileDirty(id, false)
          setConflict(null)
          setComparing(false)
        } else if (disk.eq(existing.saved)) {
          existing.mtime = content.mtimeMs
        } else if (!useApp.getState().dirtyFiles[id]) {
          // Nessuna modifica tua: il file segue il disco, per esempio dopo il lavoro di un agente.
          existing.saved = disk
          existing.mtime = content.mtimeMs
          replaceDoc(existing, content.text)
          setFileDirty(id, false)
        } else {
          setConflict({ text: content.text, mtime: content.mtimeMs })
        }
      })
      .catch(() => {
        if (cancelled) return
        if (getBuffer(id)) setMissing(true)
        else setUnavailable(t('This file no longer exists.'))
      })
    return () => {
      cancelled = true
    }
  }, [id, root, path, version, setFileDirty])

  const save = useCallback(async () => {
    const current = getBuffer(id)
    // ⌘S arriva sia all'editor sia alla finestra: un salvataggio alla volta.
    if (!current || current.saving) return
    setProblem(null)
    const result = await saveBuffer(current)
    if (result.kind === 'saved') {
      setFileDirty(id, false)
      setConflict(null)
      setComparing(false)
      setMissing(false)
    } else if (result.kind === 'conflict') {
      setConflict({ text: result.text, mtime: result.mtime })
    } else {
      setProblem(result.message)
    }
  }, [id, setFileDirty])

  useEffect(() => {
    if (!buffer) return
    buffer.onSave = () => void save()
    buffer.onChange = (state) => setFileDirty(id, !state.doc.eq(buffer.saved))
  }, [buffer, id, save, setFileDirty])

  const reload = () => {
    if (!buffer || !conflict) return
    buffer.saved = toText(conflict.text)
    buffer.mtime = conflict.mtime
    replaceDoc(buffer, conflict.text)
    setFileDirty(id, false)
    setConflict(null)
    setComparing(false)
    buffer.view?.focus()
  }
  const keepMine = () => {
    if (!buffer || !conflict) return
    // Il prossimo salvataggio sovrascrive consapevolmente la versione su disco.
    buffer.saved = toText(conflict.text)
    buffer.mtime = conflict.mtime
    setConflict(null)
    setComparing(false)
    buffer.view?.focus()
  }

  if (!project) return null
  return (
    <Workspace project={project} session={null} root={root} composerKey={`new:${project.id}`}>
      <TopBar project={project} session={null} root={root}>
        <TabBar projectId={project.id} activeSessionId={null} activeFile={id} />
      </TopBar>
      <div className="flex h-8 shrink-0 items-center gap-2 border-y border-border pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`${root}/${path}`}>
          {path}
        </span>
        {dirty && (
          <button type="button" onClick={() => void save()} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
            {t('Save')}
            <Kbd>{shortcutLabel('file.save')}</Kbd>
          </button>
        )}
        <button
          type="button"
          aria-label={t('Open in editor')}
          title={t('Open in editor')}
          onClick={() => openInEditor(projectId, `${root}/${path}`)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
      {agentWorking && !conflict && <Banner tone="info">{t('An agent is working in this folder. If you save now, your change ends up in its turn.')}</Banner>}
      {missing && <Banner tone="attention">{t('This file was deleted on disk. Saving creates it again.')}</Banner>}
      {problem && <Banner tone="error">{problem}</Banner>}
      {conflict && (
        <Banner tone="attention">
          <span className="min-w-0 flex-1 truncate">{t('This file changed on disk while you were editing it.')}</span>
          <button type="button" className={action} aria-pressed={comparing} onClick={() => setComparing((v) => !v)}>
            {t('Compare')}
          </button>
          <button type="button" className={action} onClick={reload}>
            {t('Reload')}
          </button>
          <button type="button" className={action} onClick={keepMine}>
            {t('Keep mine')}
          </button>
        </Banner>
      )}
      {unavailable ? (
        <p className="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">{unavailable}</p>
      ) : buffer ? (
        <CodeEditor buffer={buffer} compareWith={comparing && conflict ? conflict.text : null} />
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">{t('Opening file…')}</p>
      )}
    </Workspace>
  )
}

/** Chiudere una tab con modifiche non salvate. Se il salvataggio non riesce la tab resta aperta e il motivo si legge qui. */
export function UnsavedFileDialog() {
  const closing = useApp((s) => s.closingFile)
  const cancelClose = useApp((s) => s.cancelCloseFile)
  const closeFile = useApp((s) => s.closeFile)
  const setFileDirty = useApp((s) => s.setFileDirty)
  const [error, setError] = useState<string | null>(null)
  const name = closing?.path.split('/').pop() ?? ''

  const saveAndClose = async () => {
    if (!closing) return
    const id = fileTabId(closing.root, closing.path)
    const buffer = getBuffer(id)
    const result = buffer ? await saveBuffer(buffer) : ({ kind: 'saved' } as const)
    if (result.kind === 'saved') {
      setFileDirty(id, false)
      closeFile(closing.projectId, closing.root, closing.path, true)
      setError(null)
    } else {
      setError(result.kind === 'conflict' ? t('This file changed on disk while you were editing it.') : result.message)
    }
  }

  return (
    <Dialog
      open={Boolean(closing)}
      onOpenChange={(open) => {
        if (!open) {
          setError(null)
          cancelClose()
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogTitle className="text-base font-semibold">{t('Save changes to {file}?', { file: name })}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">{t('If you don’t save, your edits are lost.')}</DialogDescription>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (!closing) return
              setError(null)
              closeFile(closing.projectId, closing.root, closing.path, true)
            }}
          >
            {t('Don’t save')}
          </Button>
          <Button onClick={() => void saveAndClose()}>{t('Save')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
