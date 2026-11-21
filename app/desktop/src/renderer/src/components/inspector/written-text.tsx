// Testo scritto da un modello su richiesta (LAD-59), comune a messaggio di commit e a titolo e descrizione della PR.
// Una proposta non sostituisce mai ciò che hai già scritto senza un tuo "Replace"; annullare ferma anche l'host;
// una risposta arrivata dopo l'annullamento, un cambio di sessione o un reset si ignora.
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, Sparkles } from 'lucide-react'
import type { GeneratedCommit, GeneratedPr, GeneratedTextCut, SessionSummary } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import { useGeneratedText, type GeneratedTextState } from '@/lib/generated-text'
import { request, send } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'

export type WrittenTextKind = 'commit' | 'pr'

export interface TextValue {
  head: string
  body: string
}

export interface TextMeta {
  files: number
  truncated: GeneratedTextCut | null
  staged: boolean
  issue: { ref: string; url: string | null } | null
}

export interface WrittenText {
  availability: GeneratedTextState
  loading: boolean
  proposal: TextValue | null
  meta: TextMeta | null
  generate: () => void
  cancel: () => void
  /** Ferma la generazione e butta proposta e note (dopo un commit, o riaprendo il dialogo). */
  reset: () => void
  accept: () => void
  dismiss: () => void
}

/** `value` è il testo attuale dei campi, `onFill` lo imposta. `resetKey` cambia quando si riparte da zero. */
export function useWrittenText({
  kind,
  projectId,
  session,
  value,
  onFill,
  resetKey
}: {
  kind: WrittenTextKind
  projectId: string
  session: SessionSummary | null
  value: TextValue
  onFill: (next: TextValue) => void
  resetKey?: unknown
}): WrittenText {
  const availability = useGeneratedText(projectId, session)
  const [proposal, setProposal] = useState<TextValue | null>(null)
  const [meta, setMeta] = useState<TextMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)
  const valueRef = useRef(value)
  valueRef.current = value
  const fillRef = useRef(onFill)
  fillRef.current = onFill
  const sessionId = session?.id ?? null

  // Sessione con una generazione in corso: serve per dire all'host di fermarla.
  const pending = useRef<string | null>(null)
  const stopHost = () => {
    if (pending.current) send({ type: 'text.cancel', sessionId: pending.current })
    pending.current = null
  }
  const stopRef = useRef(stopHost)
  stopRef.current = stopHost

  // Altra sessione o altro dialogo: si riparte da zero. Chiudere o cambiare sessione durante la generazione la ferma nell'host.
  useEffect(() => {
    latest.current++
    setProposal(null)
    setMeta(null)
    setLoading(false)
    return () => stopRef.current()
  }, [kind, sessionId, resetKey])

  const generate = () => {
    if (!sessionId) return
    const id = ++latest.current
    setLoading(true)
    setProposal(null)
    pending.current = sessionId
    request<GeneratedCommit | GeneratedPr>(kind === 'commit' ? { type: 'text.commit', sessionId } : { type: 'text.pr', sessionId })
      .then((result) => {
        if (id !== latest.current) return
        const next: TextValue = 'subject' in result ? { head: result.subject, body: result.body } : { head: result.title, body: result.body }
        setMeta({ files: result.files, truncated: result.truncated, staged: 'source' in result && result.source === 'staged', issue: 'issue' in result ? result.issue : null })
        // Con qualcosa già scritto (anche durante l'attesa) la proposta aspetta la tua conferma.
        const current = valueRef.current
        if (current.head.trim() || current.body.trim()) setProposal(next)
        else fillRef.current(next)
      })
      .catch((e: unknown) => id === latest.current && useApp.getState().notifyError(e))
      .finally(() => {
        if (id !== latest.current) return
        pending.current = null
        setLoading(false)
      })
  }

  const cancel = () => {
    latest.current++
    setLoading(false)
    stopHost()
  }

  return {
    availability,
    loading,
    proposal,
    meta,
    generate,
    cancel,
    reset: () => {
      cancel()
      setProposal(null)
      setMeta(null)
    },
    accept: () => {
      if (proposal) fillRef.current(proposal)
      setProposal(null)
    },
    dismiss: () => setProposal(null)
  }
}

/** Etichetta del campo, pulsante "Scrivi…" (o "Scrittura in corso… Annulla"), motivo se spento e proposta da confermare. */
export function WrittenTextBar({ text, label, writeLabel, disabled }: { text: WrittenText; label: string; writeLabel: string; disabled?: boolean }) {
  const { availability, loading, proposal } = text
  return (
    <>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        {loading ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            {t('Writing…')}
            <Button type="button" variant="ghost" size="sm" onClick={text.cancel}>
              {t('Cancel')}
            </Button>
          </span>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={text.generate} disabled={!availability.available || disabled}>
            <Sparkles aria-hidden />
            {writeLabel}
          </Button>
        )}
      </div>
      {!availability.available && <p className="text-xs text-muted-foreground">{availability.reason}</p>}
      {proposal && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">{t('Proposed text, your text is unchanged')}</span>
            <span className="block truncate font-medium">{proposal.head}</span>
          </span>
          <Button type="button" variant="outline" size="sm" onClick={text.accept}>
            {t('Replace')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={text.dismiss}>
            {t('Dismiss')}
          </Button>
        </div>
      )}
    </>
  )
}

/** Sotto i campi: su quanti file si basa il testo, avviso se il diff è stato tagliato, issue collegata (PR). */
export function WrittenTextMeta({ text }: { text: WrittenText }) {
  const { meta } = text
  if (!meta) return null
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>
        {plural(meta.files, 'Based on {n} changed file', 'Based on {n} changed files')}
        {meta.staged && ` ${t('(staged)')}`}
        {meta.truncated && (
          <>
            {' · '}
            <span role="note">{plural(meta.truncated.files, 'Diff too long: {n} file not sent', 'Diff too long: {n} files not sent')}</span>
          </>
        )}
      </p>
      {meta.issue && (
        <p className="flex items-center gap-1.5">
          {t('Linked issue')}
          {meta.issue.url ? (
            <button
              type="button"
              onClick={() => void window.ladder?.openExternal(meta.issue!.url!)}
              className="inline-flex items-center gap-1 rounded-[5px] border border-input px-1.5 py-px font-mono text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {meta.issue.ref}
              <ExternalLink aria-hidden className="size-3 text-faint" />
            </button>
          ) : (
            <span className="rounded-[5px] border border-input px-1.5 py-px font-mono text-foreground">{meta.issue.ref}</span>
          )}
        </p>
      )}
    </div>
  )
}
