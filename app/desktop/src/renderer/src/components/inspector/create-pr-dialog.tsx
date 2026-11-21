// "Create PR…" (LAD-59): titolo e descrizione si scrivono qui (a mano, o con "Genera testo") e alla conferma vanno
// all'agente, che fa push e `gh pr create` senza riscriverli. Non parte niente finché non premi il pulsante di conferma.
import { useRef, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import type { PrPrepared, SessionSummary } from '@shared/protocol'
import { sendToSession } from '@/components/prompt-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { request } from '@/lib/host-client'
import { useSessionAgentLabel } from '@/lib/profiles'
import { t } from '@shared/i18n'
import { useWrittenText, WrittenTextBar, WrittenTextMeta, type TextValue } from './written-text'

/** Montare solo quando il dialogo è aperto: ogni apertura riparte da campi vuoti. */
export function CreatePrDialog({ projectId, session, branch, base, onClose }: { projectId: string; session: SessionSummary | null; branch: string; base: string; onClose: () => void }) {
  const agent = useSessionAgentLabel(session)
  const [value, setValue] = useState<TextValue>({ head: '', body: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const text = useWrittenText({ kind: 'pr', projectId, session, value, onFill: (next) => (setValue(next), setError(null)) })

  const title = value.head.trim()
  const canSubmit = Boolean(session) && title.length > 0 && !busy

  const submit = async () => {
    if (!session || !canSubmit || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      // L'host scrive titolo e descrizione in file temporanei e restituisce il prompt (personalizzabile in [prompts]) con i soli percorsi.
      const { prompt } = await request<PrPrepared>({ type: 'pr.prepare', sessionId: session.id, projectId, branch, base, title, body: value.body.trim() })
      await sendToSession(session, prompt)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="gap-3 sm:max-w-[620px]">
        <DialogTitle className="text-base">{t('Create pull request')}</DialogTitle>
        <DialogDescription className="text-sm">
          {session
            ? t('Nothing is sent until you confirm. Then “{title}” ({agent}) pushes {branch} and opens the PR into {base} with exactly this text.', { title: session.title, agent, branch, base })
            : t('Open a session on this branch to have the agent open the PR.')}
        </DialogDescription>

        <WrittenTextBar text={text} label={t('Title and description')} writeLabel={t('Generate text')} disabled={busy} />
        <Input
          value={value.head}
          onChange={(e) => (setValue({ ...value, head: e.target.value }), setError(null))}
          aria-label={t('PR title')}
          aria-required
          placeholder={t('Title')}
          readOnly={busy}
          className="font-mono"
        />
        <Textarea
          value={value.body}
          onChange={(e) => (setValue({ ...value, body: e.target.value }), setError(null))}
          rows={10}
          aria-label={t('PR description')}
          placeholder={t('Description (optional)')}
          readOnly={busy}
          className="min-h-[200px] resize-y font-mono leading-[1.55]"
        />
        <WrittenTextMeta text={text} />
        {error && (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit} aria-busy={busy}>
            <GitPullRequest aria-hidden />
            {busy ? t('Sending…') : session?.mode === 'terminal' ? t('Paste into terminal') : t('Send to {agent}', { agent })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
