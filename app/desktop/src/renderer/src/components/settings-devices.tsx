// Settings → Devices: access from the phone, QR pairing, paired phones, password, "Allow Full", advanced and activity.
import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { t } from '@shared/i18n'
import { DeviceRow } from '@/components/devices/device-row'
import { PairDialog } from '@/components/devices/pair-dialog'
import { PhoneLog } from '@/components/devices/phone-log'
import { RemoteAdvanced } from '@/components/devices/remote-advanced'
import { Outcome, SettingRow, SettingsBlock, settingsButton, Toggle } from '@/components/settings-parts'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { usePrefs } from '@/hooks/use-prefs'
import { REMOTE_PASSWORD_MAX, REMOTE_PASSWORD_MIN, remoteCommands, useRemoteStatus } from '@/lib/remote'

export function DevicesSection() {
  const [prefs] = usePrefs()
  const status = useRemoteStatus()
  // In development the channel can be turned on by environment variables: the host's state counts as much as the preference.
  const on = Boolean(prefs?.remote?.enabled || status?.enabled)
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Devices')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Follow your sessions and answer requests from your phone. Agents keep running on this Mac.')}
      </DialogDescription>
      {/* From 820 px: access and phones on the left, activity and advanced on the right. */}
      <div className="grid items-start gap-x-10 @[820px]:grid-cols-2">
        <div className="min-w-0">
          <AccessBlock on={on} />
          {on && <PhonesBlock />}
        </div>
        {on && (
          <div className="min-w-0">
            <SettingsBlock id="phone-log-title" title={t('Phone activity')} description={t('The latest things done from a phone: answers, messages and stops.')}>
              <PhoneLog />
            </SettingsBlock>
            <RemoteAdvanced />
          </div>
        )}
      </div>
    </>
  )
}

function AccessBlock({ on }: { on: boolean }) {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  const remote = { enabled: prefs.remote?.enabled ?? false, relayUrl: prefs.remote?.relayUrl ?? null, allowFull: prefs.remote?.allowFull ?? true }
  return (
    <SettingsBlock id="phone-access-title" title={t('Phone access')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <Toggle
          label={t('Access from your phone')}
          description={t('See sessions, approve requests and send messages from your phone. Everything is end-to-end encrypted through a relay that can’t read it. Agents keep running on this Mac.')}
          checked={remote.enabled}
          onChange={(enabled) => update({ remote: { ...remote, enabled } })}
        />
        {on && <PasswordRow />}
        {on && (
          <Toggle
            label={t('Allow Full access from phone')}
            description={t('Lets a paired phone switch a session to Full access, where the agent runs commands without asking. Turn it off to keep phones at Edit or below.')}
            checked={remote.allowFull}
            onChange={(allowFull) => update({ remote: { ...remote, allowFull } })}
          />
        )}
      </div>
    </SettingsBlock>
  )
}

function PhonesBlock() {
  const status = useRemoteStatus()
  const [pairing, setPairing] = useState(false)
  const devices = status?.devices ?? []
  return (
    <SettingsBlock id="phones-title" title={t('Paired phones')}>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{devices.length === 0 ? t('No phones yet.') : t('These phones can reach this Mac.')}</p>
        <Button size="sm" className="text-sm" data-connect-phone disabled={!status?.enabled} onClick={() => setPairing(true)}>
          <Smartphone aria-hidden data-icon="inline-start" />
          {t('Connect a phone')}
        </Button>
      </div>
      {devices.length === 0 ? (
        <p className="mt-3 rounded-lg border border-border px-4 py-3.5 text-xs text-muted-foreground">{t('Connect a phone to follow your sessions and answer requests from it.')}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border" aria-labelledby="phones-title">
          {devices.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      )}
      <PairDialog open={pairing} onClose={() => setPairing(false)} />
    </SettingsBlock>
  )
}

function PasswordRow() {
  const status = useRemoteStatus()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const has = Boolean(status?.hasPassword)
  const valid = value.length >= REMOTE_PASSWORD_MIN && value.length <= REMOTE_PASSWORD_MAX

  const close = () => {
    setEditing(false)
    setValue('')
    setError(null)
    const back = opener.current
    opener.current = null
    if (back) requestAnimationFrame(() => back.isConnected && back.focus())
  }
  const save = (password: string | null, success: string) => {
    setBusy(true)
    setError(null)
    remoteCommands
      .setPassword(password)
      .then(() => {
        if (!mounted.current) return
        setDone(success)
        close()
      })
      .catch((e: Error) => mounted.current && setError(e.message))
      .finally(() => mounted.current && setBusy(false))
  }

  return (
    <div className="flex flex-col">
      <SettingRow
        label={t('Require a password to pair')}
        hint={has ? t('A password is set. It’s asked only when pairing a new phone, on top of the code.') : t('Off. Anyone who scans the code on this screen can pair a phone. A password is asked only when pairing a new phone.')}
      >
        <button
          type="button"
          className={settingsButton}
          disabled={busy}
          onClick={(e) => {
            opener.current = e.currentTarget
            setDone(null)
            setEditing(true)
          }}
        >
          {has ? t('Change password') : t('Set password')}
        </button>
        {has && (
          <button type="button" className={settingsButton} disabled={busy} onClick={() => save(null, t('Password removed.'))}>
            {t('Remove')}
          </button>
        )}
      </SettingRow>
      {editing && (
        <form
          className="flex flex-col gap-2 px-4 pb-3.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !busy) save(value, has ? t('Password changed.') : t('Password set.'))
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            close()
          }}
        >
          <label htmlFor="remote-password" className="text-xs text-muted-foreground">
            {t('{min} to {max} characters. Phones already paired keep working.', { min: REMOTE_PASSWORD_MIN, max: REMOTE_PASSWORD_MAX })}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="remote-password"
              autoFocus
              type="password"
              autoComplete="new-password"
              value={value}
              maxLength={REMOTE_PASSWORD_MAX}
              aria-label={has ? t('New password') : t('Password')}
              onChange={(e) => setValue(e.target.value)}
              className="max-w-[280px]"
            />
            <Button type="submit" size="sm" className="text-sm" disabled={!valid || busy}>
              {t('Save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-sm" onClick={close}>
              {t('Cancel')}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="px-4 pb-3">
          <Outcome tone="error">{error}</Outcome>
        </div>
      )}
      {done && !editing && (
        <div className="px-4 pb-3">
          <Outcome>{done}</Outcome>
        </div>
      )}
    </div>
  )
}
