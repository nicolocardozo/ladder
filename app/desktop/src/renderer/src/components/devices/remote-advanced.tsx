// Advanced (closed by default): relay address, the Mac's key fingerprint for verification and "Regenerate key".
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { REMOTE_DEFAULT_RELAY_URL } from '@shared/protocol'
import { t } from '@shared/i18n'
import { ConfirmPane } from '@/components/devices/confirm-pane'
import { Outcome, SettingRow, settingsButton } from '@/components/settings-parts'
import { Input } from '@/components/ui/input'
import { usePrefs } from '@/hooks/use-prefs'
import { relayUrlError, remoteCommands, useRemoteStatus } from '@/lib/remote'
import { cn } from '@/lib/utils'

export function RemoteAdvanced() {
  const [open, setOpen] = useState(false)
  const panel = useId()
  return (
    <div className="mt-8">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight aria-hidden className={cn('size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        {t('Advanced')}
      </button>
      {open && (
        <div id={panel} className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
          <RelayRow />
          <FingerprintRow />
          <RegenerateRow />
        </div>
      )}
    </div>
  )
}

function RelayRow() {
  const [prefs, update] = usePrefs()
  const saved = prefs?.remote?.relayUrl ?? ''
  const [draft, setDraft] = useState(saved)
  const [touched, setTouched] = useState(false)
  // A change coming from outside (another window, the preferences file) rewrites the field, but not while it is being typed in.
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setDraft(saved)
  }, [saved])
  const error = touched ? relayUrlError(draft) : null

  const commit = () => {
    editing.current = false
    setTouched(true)
    if (!prefs || relayUrlError(draft)) return
    const next = draft.trim() || null
    if (next === (prefs.remote?.relayUrl ?? null)) return
    update({ remote: { enabled: prefs.remote?.enabled ?? false, allowFull: prefs.remote?.allowFull ?? true, relayUrl: next } })
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <label htmlFor="relay-url" className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t('Relay address')}</span>
        <span className="text-xs text-muted-foreground">{t('Leave it empty to use the default relay. Change it only if you host your own. The relay can’t read your sessions.')}</span>
      </label>
      <Input
        id="relay-url"
        value={draft}
        placeholder={REMOTE_DEFAULT_RELAY_URL}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'relay-url-error' : undefined}
        className="font-mono text-xs"
        onFocus={() => (editing.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape' && draft !== saved) {
            // Esc restores the saved address without closing Settings.
            e.stopPropagation()
            setDraft(saved)
            setTouched(false)
          }
        }}
      />
      {error && (
        <p id="relay-url-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function FingerprintRow() {
  const status = useRemoteStatus()
  return (
    <SettingRow label={t('Mac key fingerprint')} hint={t('Your phone shows the same fingerprint before it connects. If they differ, don’t connect.')}>
      <span className="font-mono text-xs tracking-wide">{status?.fingerprint ?? t('Not created yet')}</span>
    </SettingRow>
  )
}

function RegenerateRow() {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const regenerate = () => {
    setBusy(true)
    setError(null)
    remoteCommands
      .regenerateKey()
      .then(() => {
        if (!mounted.current) return
        setConfirming(false)
        setDone(true)
        // The confirmation pane disappears: focus returns to the button that opened it.
        requestAnimationFrame(() => button.current?.focus())
      })
      .catch((e: Error) => mounted.current && setError(e.message))
      .finally(() => mounted.current && setBusy(false))
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-6">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t('Regenerate key')}</span>
          <span className="text-xs text-muted-foreground">{t('Creates a new key for this Mac. Use it if a phone is lost or you think someone else paired.')}</span>
        </span>
        <button
          ref={button}
          type="button"
          className={cn(settingsButton, 'text-destructive hover:bg-destructive/10')}
          onClick={() => {
            setDone(false)
            setConfirming(true)
          }}
        >
          {t('Regenerate key')}
        </button>
      </div>
      {confirming && (
        <ConfirmPane confirmLabel={t('Regenerate key')} busy={busy} onConfirm={regenerate} onCancel={() => setConfirming(false)}>
          {t('Every paired phone is disconnected and must pair again with a new code. This can’t be undone.')}
        </ConfirmPane>
      )}
      {error && <Outcome tone="error">{error}</Outcome>}
      {done && <Outcome>{t('Key regenerated. All phones were disconnected.')}</Outcome>}
    </div>
  )
}
