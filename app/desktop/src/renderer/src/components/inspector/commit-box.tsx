// Commit message in the "Ready to merge" panel. Ladder makes the commit with git (`git.commit`),
// not the agent, and only when you press "Commit". The text proposed by the model stays editable; a host error
// (even a failing hook) is shown below and doesn't erase what you wrote.
import { useRef, useState } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { MAX_COMMIT_SUBJECT, type GitCommitResult, type SessionSummary } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { useWrittenText, WrittenTextBar, WrittenTextMeta, type TextValue } from './written-text'

export function CommitBox({ projectId, session, dirty }: { projectId: string; session: SessionSummary | null; dirty: number }) {
  const [value, setValue] = useState<TextValue>({ head: '', body: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<GitCommitResult | null>(null)
  const inFlight = useRef(false)
  const headRef = useRef<HTMLInputElement>(null)
  const text = useWrittenText({ kind: 'commit', projectId, session, value, onFill: (next) => (setValue(next), setError(null)) })

  const subject = value.head.trim()
  const tooLong = value.head.length > MAX_COMMIT_SUBJECT
  const hasFiles = dirty > 0
  const canCommit = Boolean(session) && hasFiles && subject.length > 0 && !tooLong && !busy && !text.loading

  const commit = async () => {
    if (!session || !canCommit || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setDone(null)
    let ok = false
    try {
      // `paths: 'all'` only applies if nothing is staged: if there is a stage the host commits that and nothing else.
      const result = await request<GitCommitResult>({ type: 'git.commit', sessionId: session.id, subject, body: value.body.trim() || undefined, paths: 'all' })
      setValue({ head: '', body: '' })
      setDone(result)
      text.reset()
      ok = true
      useApp.getState().notifyInfo(t('Committed {hash}: {subject}', { hash: result.hash, subject: result.subject }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(false)
      if (ok) requestAnimationFrame(() => headRef.current?.focus())
    }
  }

  // The first line of the error is the reason; the rest (hook or git output) goes in a separate block.
  const [reason, ...rest] = (error ?? '').split('\n')
  const output = rest.join('\n').trim()

  if (!hasFiles && !done && !value.head && !value.body) {
    return <p className="text-sm text-muted-foreground">{t('Nothing to commit.')}</p>
  }

  const why = !session ? t('Open a session on this branch to commit.') : null
  const idBase = 'commit-box'
  return (
    <div className="flex flex-col gap-1.5">
      <WrittenTextBar text={text} label={t('Message')} writeLabel={t('Write message')} disabled={busy || !hasFiles} />
      <Input
        value={value.head}
        onChange={(e) => (setValue({ ...value, head: e.target.value }), setError(null))}
        aria-label={t('Commit subject')}
        aria-invalid={tooLong || undefined}
        aria-describedby={`${idBase}-count`}
        placeholder={t('Subject')}
        readOnly={busy}
        ref={headRef}
        className="font-mono"
      />
      <div className="flex justify-end text-xs">
        <span id={`${idBase}-count`} className={tooLong ? 'font-medium text-destructive' : 'text-muted-foreground'}>
          {tooLong ? t('Too long: {n} of {max} characters', { n: value.head.length, max: MAX_COMMIT_SUBJECT }) : `${value.head.length}/${MAX_COMMIT_SUBJECT}`}
        </span>
      </div>
      <Textarea
        value={value.body}
        onChange={(e) => (setValue({ ...value, body: e.target.value }), setError(null))}
        rows={5}
        aria-label={t('Commit body')}
        placeholder={t('Body (optional)')}
        readOnly={busy}
        className="min-h-[110px] resize-y font-mono leading-[1.55]"
      />
      <WrittenTextMeta text={text} />

      {error && (
        <div role="alert" className="flex flex-col gap-1.5 text-sm text-destructive">
          <p className="break-words">{reason}</p>
          {output && (
            <pre tabIndex={0} aria-label={t('Command output')} className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {output}
            </pre>
          )}
        </div>
      )}
      {done && !error && (
        <p role="status" className="text-sm text-success">
          {t('Committed {hash}: {subject}', { hash: done.hash, subject: done.subject })}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {why ?? (!hasFiles ? t('Nothing to commit.') : plural(dirty, 'Staged files are committed. With nothing staged, all {n} changed file is committed.', 'Staged files are committed. With nothing staged, all {n} changed files are committed.'))}
        </p>
        <Button type="button" size="sm" onClick={() => void commit()} disabled={!canCommit} aria-busy={busy}>
          <GitCommitHorizontal aria-hidden />
          {busy ? t('Committing…') : t('Commit')}
        </Button>
      </div>
    </div>
  )
}
