// Pezzi del catalogo ACP che dicono cosa è successo a un agente: blocco di sicurezza, firma, checksum e accesso (LAD-56).
// Descrivono lo stato e basta: niente "sicuro". Ladder non vede né salva credenziali: l'accesso lo fa l'agente.
import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, CircleAlert, CircleHelp, ExternalLink, KeyRound, Loader2, TriangleAlert } from 'lucide-react'
import type { AgentBlockCode, AgentCatalogEntry, AgentLogin, AgentSignature } from '@shared/protocol'
import { t } from '@shared/i18n'
import { CopyButton } from '@/components/connections/connection-row'
import { Button } from '@/components/ui/button'
import { blockText, blockTitle, groupedChecksum, openSecure, shortChecksum, signatureText, type AgentCatalogActions } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'

/** Link che apre una pagina https fuori da Ladder; il testo dice dove va. */
export function ExternalLinkButton({ url, label, aria }: { url: string; label: string; aria: string }) {
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={() => openSecure(url)}
      className="inline-flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ExternalLink aria-hidden className="size-3" />
      {label}
    </button>
  )
}

/**
 * Perché Ladder non scarica o non installa, con il link alla procedura del vendor.
 * Un conflitto di checksum è un avviso (colore e icona di attenzione, annunciato subito); gli altri sono note tenui.
 */
export function BlockNotice({
  code,
  name,
  installUrl,
  announce = false,
  onRetry,
  retrying = false
}: {
  code: AgentBlockCode
  name: string
  installUrl: string | null
  announce?: boolean
  /** Solo per `checksum-unavailable`: rilegge il catalogo. Quel blocco passa da solo, quindi niente link al sito del vendor. */
  onRetry?: () => void
  retrying?: boolean
}) {
  const transient = code === 'checksum-unavailable'
  const conflict = code === 'checksum-conflict'
  const Icon = conflict ? TriangleAlert : CircleAlert
  return (
    <div role={conflict || announce ? 'alert' : undefined} className={cn('flex flex-col gap-1.5 rounded-md p-3 text-xs', conflict ? 'border border-attention/50 bg-attention/10' : 'bg-muted')}>
      <p className={cn('flex items-center gap-1.5 font-medium', conflict && 'text-attention')}>
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {blockTitle(code)}
      </p>
      <p className="text-muted-foreground">{blockText(code, name)}</p>
      {installUrl && !transient && <ExternalLinkButton url={installUrl} label={t('Open the install guide')} aria={t('Install guide for {name}, opens in your browser', { name })} />}
      {transient && onRetry && (
        <Button variant="outline" size="sm" className="w-fit text-sm" aria-disabled={retrying} aria-label={t('Try again to read the checksum of {name}', { name })} onClick={() => !retrying && onRetry()}>
          {retrying && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {t('Try again')}
        </Button>
      )}
    </div>
  )
}

/** Aggiornamento disponibile ma checksum non leggibile ora: senza checksum non c'è conferma, quindi una nota e "Try again" che rilegge. */
export function UpdateNote({ name, version, onRetry, retrying = false }: { name: string; version: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted p-3 text-xs">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <CircleAlert aria-hidden className="size-3.5 shrink-0" />
        {t('Update to v{version} is available, but the checksum is not available now.', { version })}
      </p>
      <Button variant="outline" size="sm" className="w-fit text-sm" aria-disabled={retrying} aria-label={t('Try again to read the checksum of {name}', { name })} onClick={() => !retrying && onRetry()}>
        {retrying && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
        {t('Try again')}
      </Button>
    </div>
  )
}

/** Firma del binario installato: solo lo stato (chi ha firmato, ad hoc, non firmato). */
export function SignatureLine({ signature }: { signature: AgentSignature }) {
  const Icon = signature.state === 'signed' ? BadgeCheck : signature.state === 'adhoc' || signature.state === 'unverified' ? CircleHelp : CircleAlert
  const text = signatureText(signature)
  return (
    <span title={text} className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
}

/** Checksum sha256: breve per riconoscerlo, intero (a gruppi di 8) a richiesta, e copiabile per intero. */
export function ChecksumField({ sha256 }: { sha256: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <code className="break-all font-mono">{open ? groupedChecksum(sha256) : shortChecksum(sha256)}</code>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {open ? t('Show less') : t('Show full checksum')}
        </button>
        <CopyButton text={sha256} label={t('Copy checksum')} copiedLabel={t('Checksum copied')} />
      </div>
    </div>
  )
}

/**
 * Accesso di un agente già aggiunto che lo chiede (`required`): un bottone per ogni metodo di tipo `agent`,
 * che invia `agents.authenticate`; per i metodi `terminal` solo un testo (l'host non li supporta ancora, quindi niente bottone che fallisce).
 * Mentre si aspetta il bottone resta al suo posto (aria-disabled) per non far perdere il focus.
 */
export function LoginPanel({ entry, actions, projectId, onLogin }: { entry: AgentCatalogEntry; actions: AgentCatalogActions; projectId?: string; onLogin: (id: string, login: AgentLogin) => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ method: string; message: string } | null>(null)
  const attempt = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const agentMethods = entry.login.methods.filter((m) => m.type === 'agent')
  const terminalMethods = entry.login.methods.filter((m) => m.type === 'terminal')
  const terminalHints = terminalMethods.filter((m) => m.description)
  const unsupportedMethods = entry.login.methods.filter((m) => m.type === 'unsupported')

  function signIn(methodId: string): void {
    if (pending) return
    const mine = ++attempt.current
    setPending(methodId)
    setFailed(null)
    actions
      .authenticate(entry.id, methodId, projectId)
      .then((login) => {
        if (!mounted.current) return
        // La risposta vale anche se si è smesso di aspettare: l'accesso è comunque finito.
        onLogin(entry.id, login)
        if (mine === attempt.current && login.state !== 'ready') setFailed({ method: methodId, message: t('Still not signed in. Try again.') })
      })
      .catch((e: Error) => mounted.current && mine === attempt.current && setFailed({ method: methodId, message: e.message }))
      .finally(() => mounted.current && mine === attempt.current && setPending(null))
  }
  function stopWaiting(): void {
    attempt.current++
    setPending(null)
    // L'host ferma l'agente e libera l'id: la richiesta pendente risponde con il login com'era, e un nuovo Sign in parte subito.
    actions.cancelAuthenticate(entry.id).catch(() => undefined)
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound aria-hidden className="size-3.5 shrink-0" />
        {t('{name} needs you to sign in', { name: entry.name })}
      </p>
      {agentMethods.length > 0 && (
        <ul className="flex flex-col gap-2">
          {agentMethods.map((method) => {
            const label = method.name || method.id
            const retry = failed?.method === method.id
            return (
              <li key={method.id} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs">{label}</span>
                  {method.description && <span className="text-xs text-muted-foreground">{method.description}</span>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-sm"
                  aria-disabled={pending !== null}
                  aria-label={t('Sign in to {name} with {method}', { name: entry.name, method: label })}
                  onClick={() => signIn(method.id)}
                >
                  {pending === method.id ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
                  {retry ? t('Try again') : t('Sign in')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {terminalMethods.length > 0 && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <p>{t('Sign in from a terminal with the agent’s own command.')}</p>
          {terminalHints.map((method) => (
            <p key={method.id}>{`${method.name || method.id}: ${method.description}`}</p>
          ))}
        </div>
      )}
      {unsupportedMethods.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {unsupportedMethods.map((method) => (
            <li key={method.id} className="flex flex-col text-xs">
              <span>{method.name || method.id}</span>
              <span className="text-muted-foreground">{t('Ladder does not support this sign-in method.')}</span>
              {method.description && <span className="text-muted-foreground">{method.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {entry.login.methods.length === 0 && <p className="text-xs text-muted-foreground">{t('Sign in from a terminal with the agent’s own command.')}</p>}
      {pending && (
        <div className="flex items-center gap-2">
          <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('Waiting for {name} to finish signing in. It may open your browser.', { name: entry.name })}
          </p>
          <Button variant="ghost" size="sm" className="text-sm" onClick={stopWaiting}>
            {t('Stop waiting')}
          </Button>
        </div>
      )}
      {failed && !pending && (
        <p role="alert" className="text-xs text-destructive">
          {failed.message}
        </p>
      )}
      <p className="text-xs text-faint">{t('Ladder never sees your credentials: the agent handles the sign-in.')}</p>
    </div>
  )
}
