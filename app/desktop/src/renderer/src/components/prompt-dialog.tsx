// Prompt dietro un pulsante (Crea PR, Correggi la CI, Risolvi i conflitti, Invia i commenti): lo leggi e lo cambi
// prima di mandarlo all'agente. Il testo di partenza viene da [prompts] in .ladder/settings.toml o da quello di Ladder.
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { request, send } from '@/lib/host-client'
import { t } from '@shared/i18n'
import { Kbd } from '@/components/ui/kbd'
import { useSessionAgentLabel } from '@/lib/profiles'
import { isSendKey, sendKeyCombos, useSendKey } from '@/lib/send-key'

export interface PromptRequest {
  name: string
  title: string
  vars: Record<string, string>
}

/** Invia il testo alla sessione: in chat come messaggio, nel terminale incollato (lo invii tu con Invio). */
export function sendToSession(session: SessionSummary, text: string): Promise<unknown> {
  if (session.mode === 'terminal') {
    if (session.terminalId) send({ type: 'terminal.input', id: session.terminalId, data: `\x1b[200~${text}\x1b[201~` })
    return Promise.resolve()
  }
  return request({ type: 'session.send', sessionId: session.id, text })
}

export function PromptDialog({
  projectId,
  session,
  prompt,
  onClose
}: {
  projectId: string
  session: SessionSummary | null
  prompt: PromptRequest | null
  onClose: () => void
}) {
  const sendKey = useSendKey()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!prompt) return
    setText('')
    setError(null)
    request<string>({ type: 'prompt.render', projectId, name: prompt.name, vars: prompt.vars })
      .then((value) => {
        setText(value)
        requestAnimationFrame(() => area.current?.focus())
      })
      .catch((e: Error) => setError(e.message))
  }, [prompt, projectId])

  const submit = async () => {
    if (!session || !text.trim()) return
    setBusy(true)
    try {
      await sendToSession(session, text.trim())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const agent = useSessionAgentLabel(session)
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-[620px]">
        <DialogTitle className="text-base">{prompt?.title}</DialogTitle>
        <DialogDescription className="text-sm">
          {session
            ? t('Sent to “{title}” ({agent}). You can edit it first; the starting text is set in .ladder/settings.toml, under [prompts].', { title: session.title, agent })
            : t('Open a session that works on this branch to send it to the agent. Meanwhile, you can copy it.')}
        </DialogDescription>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendKey(e, sendKey)) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={12}
          aria-label={t('Prompt text')}
          placeholder={error ? '' : t('Preparing the prompt…')}
          className="min-h-[220px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm leading-[1.55] outline-none focus-visible:border-ring"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(text)}
            disabled={!text}
            className="inline-flex h-8 items-center rounded-lg border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {t('Copy')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!session || !text.trim() || busy}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {busy ? t('Sending…') : session?.mode === 'terminal' ? t('Paste into terminal') : t('Send to {agent}', { agent })}
            <Kbd>{sendKeyCombos(sendKey).send}</Kbd>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
