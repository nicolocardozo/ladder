// Prompt dietro un pulsante (Crea PR, Correggi la CI, Risolvi i conflitti, Invia i commenti): lo leggi e lo cambi
// prima di mandarlo all'agente. Il testo di partenza viene da [prompts] in .ladder/settings.toml o da quello di Ladder.
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { request, send } from '@/lib/host-client'

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

  const agent = session?.mode === 'terminal' ? `${session.command ?? 'claude'} nel terminale` : 'Claude Code'
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-[620px]">
        <DialogTitle className="text-[15px]">{prompt?.title}</DialogTitle>
        <DialogDescription className="text-[12.5px]">
          {session ? `Lo invii a “${session.title}” (${agent}). Puoi cambiarlo prima; il testo di partenza si imposta in .ladder/settings.toml, sotto [prompts].` : 'Apri una sessione che lavora su questo branch per inviarlo all’agente. Intanto puoi copiarlo.'}
        </DialogDescription>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={12}
          aria-label="Testo del prompt"
          placeholder={error ? '' : 'Preparo il prompt…'}
          className="min-h-[220px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-[12.5px] leading-[1.55] outline-none focus-visible:border-ring"
        />
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(text)}
            disabled={!text}
            className="inline-flex h-8 items-center rounded-lg border border-input px-3 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            Copia
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!session || !text.trim() || busy}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {busy ? 'Invio…' : session?.mode === 'terminal' ? 'Incolla nel terminale' : 'Invia a Claude Code'}
            <kbd className="font-mono text-[11px] opacity-70">⌘↵</kbd>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
