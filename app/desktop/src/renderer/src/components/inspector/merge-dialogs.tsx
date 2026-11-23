// Conferme del pannello "Pronto per il merge" (LAD-69): Push, Merge e Archivia. Ladder li esegue SOLO dopo il pulsante di conferma
// di questi dialoghi, mai su richiesta dell'agente. Ognuno tiene un solo invio alla volta (`inFlight`), rilascia lo stato in ogni caso
// e mostra l'errore dell'host senza chiudersi, così non restano stati a metà. Non esiste nessuna opzione di force push.
import { useEffect, useRef, useState } from 'react'
import { Archive, CloudUpload, GitMerge, TriangleAlert, ArrowUp } from 'lucide-react'
import type { GitArchiveResult, GitPushPreview, GitPushResult, PrMergeMethod, PrMergeResult, PrStatus, SessionSummary } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'

/** Errore dell'host: il primo rigo è il motivo, il resto (output di git, di un hook, di gh) va in un blocco a parte che scorre. */
export function HostError({ error }: { error: string }) {
  const [reason, ...rest] = error.split('\n')
  const output = rest.join('\n').trim()
  return (
    <div role="alert" className="flex flex-col gap-1.5 text-sm text-destructive">
      <p className="break-words">{reason}</p>
      {output && (
        <pre
          tabIndex={0}
          aria-label={t('Command output')}
          className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {output}
        </pre>
      )}
    </div>
  )
}

/** Quanto sta in alto la lista dei commit prima di scorrere. */
const LIST_CLASS = 'max-h-48 overflow-auto rounded-lg border border-border bg-muted/40 p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

/** Montare solo a dialogo aperto. Chiede l'anteprima (solo git locale), poi invia con `git.push` alla conferma. */
export function PushDialog({ session, onClose, onDone }: { session: SessionSummary; onClose: () => void; onDone: () => void }) {
  const [remote, setRemote] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<GitPushPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Si rilegge l'anteprima anche dopo un push fallito: HEAD o il remote possono essere cambiati nel frattempo.
  const [reload, setReload] = useState(0)
  const inFlight = useRef(false)
  const latest = useRef(0)
  // Il focus parte da Annulla: Invio all'apertura non deve confermare.
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Anteprima all'apertura e a ogni remote scelto: l'ultima risposta vince. Quella vecchia si butta subito, così il pulsante
  // non può confermare un push calcolato per un altro remote.
  useEffect(() => {
    const id = ++latest.current
    setPreview(null)
    setLoadError(null)
    request<GitPushPreview>({ type: 'git.push.preview', sessionId: session.id, remote })
      .then((data) => id === latest.current && setPreview(data))
      .catch((e: Error) => id === latest.current && setLoadError(e.message))
  }, [session.id, remote, reload])

  const publish = preview?.willPublish === true
  // L'anteprima deve essere quella del remote che il Select mostra.
  const current = preview !== null && (remote === undefined || preview.remote === remote)
  const canPush = current && !preview.problem && Boolean(preview.remote) && preview.total > 0 && !preview.wouldBeRejected && !busy
  const chooseRemote = preview !== null && preview.upstream === null && preview.remotes.length > 1

  const push = async () => {
    if (!preview || !canPush || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request<GitPushResult>({
        type: 'git.push',
        sessionId: session.id,
        publish: publish || undefined,
        remote: publish ? (remote ?? preview.remote ?? undefined) : undefined,
        expectedHead: preview.head
      })
      useApp.getState().notifyInfo(
        result.published
          ? t('Published {branch} to {upstream}', { branch: result.branch, upstream: result.upstream })
          : plural(result.pushed, 'Pushed {n} commit to {upstream}', 'Pushed {n} commits to {upstream}', { upstream: result.upstream })
      )
      onDone()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setReload((n) => n + 1)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const hidden = preview ? preview.commits.length : 0
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent initialFocus={cancelRef} className="gap-3 sm:max-w-[520px]">
        <DialogTitle className="text-base">{publish ? t('Publish branch') : t('Push')}</DialogTitle>
        <DialogDescription className="text-sm">
          {preview?.remote ? (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-xs">{preview.branch}</span>
              <span aria-hidden>→</span>
              <span className="sr-only">{t('to')}</span>
              <span className="min-w-0 truncate font-mono text-xs">{preview.target ?? preview.remote}</span>
            </span>
          ) : (
            t('Nothing is sent until you confirm.')
          )}
        </DialogDescription>

        <div className="flex min-h-[96px] flex-col gap-2" aria-busy={!preview && !loadError}>
          {loadError ? (
            <HostError error={loadError} />
          ) : !preview ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('Checking what would be sent…')}
            </p>
          ) : preview.problem === 'no-remote' ? (
            <p role="alert" className="text-sm text-muted-foreground">
              {t('This repository has no remote, so there is nowhere to push. Add one with git remote add.')}
            </p>
          ) : (
            <>
              {chooseRemote && (
                <div className="flex flex-col gap-1">
                  <span id="push-remote-label" className="text-xs font-medium text-muted-foreground">
                    {t('Remote')}
                  </span>
                  <Select value={remote ?? preview.remote ?? ''} onValueChange={(value) => setRemote(value || undefined)} disabled={busy}>
                    <SelectTrigger aria-labelledby="push-remote-label" className="w-full">
                      <SelectValue placeholder={t('Choose a remote')} />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {preview.remotes.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {preview.problem === 'choose-remote' && <p className="text-xs text-muted-foreground">{t('This branch has no upstream and the repository has several remotes. Choose where to publish it.')}</p>}
                </div>
              )}
              {preview.problem !== 'choose-remote' && (
                <>
                  <p className="text-sm font-medium">
                    {preview.total === 0
                      ? t('Nothing to push.')
                      : publish
                        ? plural(preview.total, 'Publishes {branch} with {n} commit', 'Publishes {branch} with {n} commits', { branch: preview.branch })
                        : plural(preview.total, '{n} commit will be pushed', '{n} commits will be pushed')}
                  </p>
                  {preview.commits.length > 0 && (
                    <ul tabIndex={0} aria-label={t('Commits to push')} className={`${LIST_CLASS} flex flex-col gap-0.5`}>
                      {preview.commits.map((commit) => (
                        <li key={commit.hash} className="flex min-w-0 gap-2 text-xs">
                          <span className="shrink-0 font-mono text-muted-foreground">{commit.hash}</span>
                          <span className="min-w-0 truncate">{commit.subject}</span>
                        </li>
                      ))}
                      {preview.total > hidden && (
                        <li className="text-xs text-muted-foreground">{plural(preview.total - hidden, 'and {n} more', 'and {n} more')}</li>
                      )}
                    </ul>
                  )}
                  {preview.upstreamElsewhere && preview.target && (
                    <p role="status" className="flex items-start gap-1.5 text-sm text-attention">
                      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 break-words">{t('The branch tracks {upstream} but will be published as {target}.', { upstream: preview.upstreamElsewhere, target: preview.target })}</span>
                    </p>
                  )}
                  {(preview.wouldBeRejected || preview.behind > 0) && (
                    <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
                      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {plural(
                          preview.behind,
                          'The remote is {n} commit ahead: the push would be rejected. Update the branch first.',
                          'The remote is {n} commits ahead: the push would be rejected. Update the branch first.'
                        )}
                      </span>
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {error && <HostError error={error} />}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onClose} disabled={busy}>
            {preview?.problem === 'no-remote' ? t('Close') : t('Cancel')}
          </Button>
          {preview?.problem !== 'no-remote' && (
            <Button type="button" onClick={() => void push()} disabled={!canPush} aria-busy={busy}>
              {publish ? <CloudUpload aria-hidden /> : <ArrowUp aria-hidden />}
              {busy ? (publish ? t('Publishing…') : t('Pushing…')) : publish ? t('Publish branch') : t('Push')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const METHODS: { id: PrMergeMethod; label: string; hint: string }[] = [
  { id: 'merge', label: 'Merge commit', hint: 'Keeps every commit and adds a merge commit.' },
  { id: 'squash', label: 'Squash and merge', hint: 'Combines the commits into one on the base branch.' },
  { id: 'rebase', label: 'Rebase and merge', hint: 'Replays the commits on top of the base branch.' }
]

const methodKey = (projectId: string) => `ladder.mergeMethod.${projectId}`

/** Ultimo metodo scelto nel progetto, se valido; altrimenti squash. */
function rememberedMethod(projectId: string): PrMergeMethod {
  try {
    const saved = window.localStorage.getItem(methodKey(projectId))
    if (saved === 'merge' || saved === 'squash' || saved === 'rebase') return saved
  } catch {
    // niente storage: si parte da squash
  }
  return 'squash'
}

/** Montare solo a dialogo aperto. `pr.merge` parte solo dalla conferma, con il metodo scelto; il branch remoto resta salvo spunta esplicita. */
export function MergeDialog({ projectId, session, pr, headOid: seenHeadOid, base, onClose, onDone }: { projectId: string; session: SessionSummary; pr: PrStatus; headOid: string | null | undefined; base: string; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<PrMergeMethod>(() => rememberedMethod(projectId))
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PrMergeResult | null>(null)
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Il commit della PR visto aprendo il dialogo: se nel frattempo cambia, l'host rifiuta invece di unire un'altra cosa.
  const [headOid] = useState(() => seenHeadOid ?? undefined)

  const merge = async () => {
    if (busy || result || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const data = await request<PrMergeResult>({ type: 'pr.merge', sessionId: session.id, number: pr.number, method, deleteBranch: deleteBranch || undefined, expectedHeadOid: headOid })
      try {
        window.localStorage.setItem(methodKey(projectId), method)
      } catch {
        // il metodo non si ricorda: pazienza
      }
      setResult(data)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent initialFocus={cancelRef} className="gap-3 sm:max-w-[520px]">
        <DialogTitle className="text-base">{result ? t('PR merged') : t('Merge pull request')}</DialogTitle>
        <DialogDescription className="text-sm">
          <span className="font-medium text-foreground">
            #{pr.number} {pr.title}
          </span>
          <span className="text-muted-foreground">{` · ${t('into {base}', { base })}`}</span>
        </DialogDescription>

        {result ? (
          <div className="flex flex-col gap-2 text-sm">
            <p role="status" className="flex items-start gap-1.5 text-success">
              <GitMerge aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('Merged #{n} with {method}.', { n: result.number, method: t(METHODS.find((m) => m.id === result.method)?.label ?? result.method).toLowerCase() })}</span>
            </p>
            {result.branchDeleted && <p role="status">{t('The remote branch was deleted.')}</p>}
            {result.branchDeleteError && (
              <p role="status" className="flex items-start gap-1.5 text-attention">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{t('The PR is merged, but the remote branch wasn’t deleted: {error}', { error: result.branchDeleteError })}</span>
              </p>
            )}
          </div>
        ) : (
          <>
            <fieldset className="flex flex-col gap-1" disabled={busy}>
              <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('Merge method')}</legend>
              {METHODS.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
                  <input type="radio" name="merge-method" value={item.id} checked={method === item.id} onChange={() => setMethod(item.id)} className="mt-1 size-3.5 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{t(item.label)}</span>
                    <span className="text-xs text-muted-foreground">{t(item.hint)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="flex cursor-pointer items-center gap-2 px-1.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} disabled={busy} className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
              {t('Delete the remote branch after merging')}
            </label>
            {error && <HostError error={error} />}
          </>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onClose} disabled={busy}>
            {result ? t('Close') : t('Cancel')}
          </Button>
          {!result && (
            <Button type="button" onClick={() => void merge()} disabled={busy} aria-busy={busy}>
              <GitMerge aria-hidden />
              {busy ? t('Merging…') : t('Merge')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Esito dell'archiviazione per l'utente: a cosa è successo al worktree. */
export function archiveMessage(result: GitArchiveResult): { text: string; warn: boolean } {
  if (result.worktreeRemoved) return { text: t('Session archived and its worktree removed.'), warn: false }
  switch (result.worktreeKept) {
    case 'shared':
      return { text: t('Session archived. The worktree is used by another session, so it stays.'), warn: false }
    case 'dirty':
      return { text: t('Session archived. The worktree has uncommitted files, so it stays.'), warn: true }
    case 'failed':
      return { text: t('Session archived, but git couldn’t remove the worktree. It stays.'), warn: true }
    default:
      return { text: t('Session archived.'), warn: false }
  }
}

/** Montare solo a dialogo aperto. La sessione si chiude con `git.archive`; l'app passa da sola a un'altra grazie a `session.upsert`. */
export function ArchiveDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Archiviata ma con il worktree rimasto per un problema: il dialogo resta aperto a dirlo.
  const [outcome, setOutcome] = useState<{ text: string; warn: boolean; reason: string | null } | null>(null)
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const archive = async () => {
    if (busy || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request<GitArchiveResult>({ type: 'git.archive', sessionId: session.id })
      // Il pannello può essere già passato a un'altra sessione: l'esito arriva come avviso dell'app.
      const message = archiveMessage(result)
      useApp.getState().notifyInfo(message.text)
      if (message.warn) setOutcome({ ...message, reason: result.worktreeError ?? null })
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent initialFocus={cancelRef} className="gap-3 sm:max-w-[480px]">
        <DialogTitle className="text-base">{outcome ? t('Session archived') : t('Archive session')}</DialogTitle>
        <DialogDescription className="text-sm">
          {outcome ? (
            <span className="flex items-start gap-1.5 text-attention">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{outcome.text}</span>
            </span>
          ) : (
            <>
              {t('“{title}” will be closed. If its worktree isn’t used by another session, the worktree is removed too. The branch stays.', { title: session.title })}
              {session.worktree && <span className="mt-1.5 block">{t('Files that git ignores in the worktree, such as .env.local, are deleted along with it.')}</span>}
            </>
          )}
        </DialogDescription>
        {outcome?.reason && <HostError error={outcome.reason} />}
        {error && <HostError error={error} />}
        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onClose} disabled={busy}>
            {outcome ? t('Close') : t('Cancel')}
          </Button>
          {!outcome && (
            <Button type="button" onClick={() => void archive()} disabled={busy} aria-busy={busy}>
              <Archive aria-hidden />
              {busy ? t('Archiving…') : t('Archive')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
