// "Connect a phone": il QR di abbinamento con nome del Mac, impronta della chiave e conto alla rovescia. Il codice è monouso e vale 5 minuti.
// L'indirizzo del QR è un segreto: sta solo in memoria di questo componente, va solo al disegno del QR e non si copia né si scrive nei log.
import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Loader2, Lock } from 'lucide-react'
import type { RemoteDeviceInfo, RemotePairStart } from '@shared/protocol'
import { t } from '@shared/i18n'
import { QrCode } from '@/components/devices/qr-code'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { onHostEvent } from '@/lib/host-client'
import { countdown, remoteCommands, useRemoteStatus } from '@/lib/remote'

/** Quanto resta aperto il dialogo dopo l'abbinamento, il tempo di leggere "is connected". */
const PAIRED_CLOSE_MS = 1800

export function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && <PairContent onClose={onClose} />}
    </Dialog>
  )
}

type Phase = { kind: 'loading' } | { kind: 'ready'; start: RemotePairStart } | { kind: 'error'; message: string } | { kind: 'paired'; device: RemoteDeviceInfo }

function PairContent({ onClose }: { onClose: () => void }) {
  const status = useRemoteStatus()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  /** Il codice non vale più prima della scadenza (troppi tentativi, sostituito): l'host lo dice con un `remote.status` senza QR. */
  const [burned, setBurned] = useState(false)
  const seenActive = useRef(false)
  const attempt = useRef(0)
  const mounted = useRef(true)
  const paired = useRef(false)
  const primary = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  function start(): void {
    setPhase({ kind: 'loading' })
    const mine = ++attempt.current
    remoteCommands
      .pairStart()
      .then((result) => {
        // Una richiesta superata da una più recente (rimontaggio, "Refresh code") non conta: il suo codice è già stato sostituito.
        if (mine !== attempt.current) return
        // Chiuso mentre l'host rispondeva: il codice appena creato si annulla subito.
        if (!mounted.current) return void remoteCommands.pairCancel().catch(() => undefined)
        setNow(Date.now())
        setBurned(false)
        seenActive.current = false
        setPhase({ kind: 'ready', start: result })
      })
      .catch((e: Error) => mounted.current && mine === attempt.current && setPhase({ kind: 'error', message: e.message }))
  }

  useEffect(() => {
    mounted.current = true
    start()
    return () => {
      mounted.current = false
      // Chiudere il dialogo annulla il codice, a meno che non sia già stato usato.
      if (!paired.current) remoteCommands.pairCancel().catch(() => undefined)
    }
  }, [])

  useEffect(
    () =>
      onHostEvent((event) => {
        if (event.type !== 'remote.paired') return
        paired.current = true
        setPhase({ kind: 'paired', device: event.device })
      }),
    []
  )

  useEffect(() => {
    if (phase.kind !== 'paired') return
    const timer = window.setTimeout(() => closeRef.current(), PAIRED_CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [phase.kind])

  // Un `remote.status` senza QR dopo che ce n'era uno: il codice è stato bruciato o sostituito.
  const active = status?.pairing ?? null
  useEffect(() => {
    if (phase.kind !== 'ready') return
    if (active) seenActive.current = true
    else if (seenActive.current) setBurned(true)
  }, [active, phase.kind])

  const expiresAt = phase.kind === 'ready' ? phase.start.expiresAt : 0
  useEffect(() => {
    if (phase.kind !== 'ready') return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [phase.kind])
  const remaining = expiresAt - now
  const expired = phase.kind === 'ready' && (remaining <= 0 || burned)

  // Il focus parte sul bottone in fondo: un Invio per sbaglio non fa niente di pericoloso e Esc annulla.
  useEffect(() => {
    if (phase.kind === 'ready' && expired) primary.current?.focus()
  }, [phase.kind, expired])

  const macName = status?.macName ?? ''

  return (
    <DialogContent initialFocus={primary} showCloseButton={false} className="gap-4 sm:max-w-[440px]">
      {phase.kind === 'paired' ? (
        <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-success/15 text-success">
            <Check aria-hidden className="size-5" strokeWidth={2.25} />
          </span>
          <DialogTitle className="text-xl font-semibold">{t('{name} is connected', { name: phase.device.name })}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{t('It can now see your sessions and answer requests.')}</DialogDescription>
          <Button ref={primary} variant="secondary" className="mt-2" onClick={onClose}>
            {t('Done')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-semibold">{t('Connect a phone')}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t('Open Ladder on your phone and scan this code.')}</DialogDescription>
          </div>
          <div className="mx-auto grid size-[280px] place-items-center rounded-lg ring-1 ring-border" style={{ background: expired || phase.kind !== 'ready' ? undefined : '#fff' }}>
            {phase.kind === 'ready' && !expired && <QrCode value={phase.start.url} label={t('QR code to connect a phone to {mac}', { mac: macName })} />}
            {phase.kind === 'loading' && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                {t('Creating a code…')}
              </p>
            )}
            {phase.kind === 'error' && (
              <p role="alert" className="flex max-w-[220px] items-start gap-2 text-sm text-destructive">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {phase.message}
              </p>
            )}
            {expired && <p className="text-sm text-muted-foreground">{t('This code is no longer valid.')}</p>}
          </div>
          {phase.kind === 'ready' && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('Mac')}</dt>
              <dd className="truncate font-medium">{macName}</dd>
              <dt className="text-muted-foreground">{t('Key fingerprint')}</dt>
              <dd className="font-mono text-xs leading-5 tracking-wide">{phase.start.fingerprint}</dd>
              <dt className="text-muted-foreground">{t('Code')}</dt>
              <dd className="tabular-nums">{expired ? t('No longer valid') : t('Expires in {time}', { time: countdown(remaining) })}</dd>
            </dl>
          )}
          {phase.kind === 'ready' && !expired && <p className="text-xs text-muted-foreground">{t('Your phone shows the same fingerprint before it connects. If they differ, don’t connect.')}</p>}
          {status?.hasPassword && phase.kind === 'ready' && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
              {t('Your phone will also ask for the password you set in Settings.')}
            </p>
          )}
          <span role="status" className="sr-only">
            {expired ? t('This code is no longer valid.') : ''}
          </span>
          <div className="flex justify-end gap-2">
            <Button ref={expired || phase.kind === 'error' ? undefined : primary} variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
            {(expired || phase.kind === 'error') && (
              <Button ref={primary} onClick={start}>
                {phase.kind === 'error' ? t('Try again') : t('Refresh code')}
              </Button>
            )}
          </div>
        </>
      )}
    </DialogContent>
  )
}
