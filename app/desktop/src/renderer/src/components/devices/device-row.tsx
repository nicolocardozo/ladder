// One row per paired phone (like the connection rows): platform mark, name that is renamed in place, "Connected" or
// "Last seen …", and "Revoke" with the confirmation pane in the row.
import { useEffect, useRef, useState } from 'react'
import { Check, CircleDashed, Pencil, Smartphone } from 'lucide-react'
import appleIcon from '@lobehub/icons-static-svg/icons/apple.svg?url'
import type { RemoteDeviceInfo } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'
import { ConfirmPane } from '@/components/devices/confirm-pane'
import { SIGN_OUT } from '@/components/connections/connection-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { relativeTime, remoteCommands } from '@/lib/remote'

const NAME_MAX = 80

function PlatformMark({ platform }: { platform: RemoteDeviceInfo['platform'] }) {
  if (platform === 'android') return <Smartphone aria-hidden className="mt-0.5 size-[18px] shrink-0 text-foreground" strokeWidth={1.75} />
  const mask = `url("${appleIcon}")`
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-block size-[18px] shrink-0 bg-current text-foreground"
      style={{ maskImage: mask, WebkitMaskImage: mask, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  )
}

export function DeviceRow({ device }: { device: RemoteDeviceInfo }) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const renameButton = useRef<HTMLButtonElement>(null)
  /** The name has already been saved or discarded: the blur that follows the field unmounting does not save it a second time. */
  const settled = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  function finishRename(save: boolean, viaKeyboard: boolean): void {
    if (settled.current) return
    settled.current = true
    const name = draft.trim().slice(0, NAME_MAX)
    setRenaming(false)
    if (viaKeyboard) requestAnimationFrame(() => renameButton.current?.focus())
    if (!save || !name || name === device.name) return
    setError(null)
    remoteCommands.rename(device.id, name).catch((e: Error) => mounted.current && setError(e.message))
  }

  function revoke(): void {
    setBusy(true)
    setError(null)
    remoteCommands
      .revoke(device.id)
      // The row disappears with the new state: focus moves to "Connect a phone", the action that takes its place.
      .then(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-connect-phone]')?.focus()))
      .catch((e: Error) => {
        if (!mounted.current) return
        setError(e.message)
        setConfirming(false)
      })
      .finally(() => mounted.current && setBusy(false))
  }

  const platform = device.platform === 'ios' ? t('iPhone') : t('Android phone')
  const paired = new Date(device.createdAt).toLocaleDateString(localeTag(), { dateStyle: 'medium' })

  return (
    <li data-device={device.id} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 px-4 py-3.5">
      <PlatformMark platform={device.platform} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {renaming ? (
            <Input
              autoFocus
              aria-label={t('Phone name')}
              value={draft}
              maxLength={NAME_MAX}
              className="h-7 w-[220px] text-sm"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => finishRename(true, false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  finishRename(true, true)
                } else if (e.key === 'Escape') {
                  // Esc cancels only the name, not Settings.
                  e.stopPropagation()
                  finishRename(false, true)
                }
              }}
            />
          ) : (
            <>
              <span className="min-w-0 truncate text-sm font-medium">{device.name}</span>
              <Button
                ref={renameButton}
                variant="ghost"
                size="icon-xs"
                aria-label={t('Rename {name}', { name: device.name })}
                onClick={() => {
                  setDraft(device.name)
                  settled.current = false
                  setRenaming(true)
                }}
              >
                <Pencil aria-hidden />
              </Button>
            </>
          )}
          {device.connected ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check aria-hidden className="size-3" />
              {t('Connected')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CircleDashed aria-hidden className="size-3" />
              {device.lastSeenAt ? t('Last seen {time}', { time: relativeTime(device.lastSeenAt) }) : t('Never connected')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('{platform} · Paired {date}', { platform, date: paired })}</p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {confirming && (
          <ConfirmPane confirmLabel={t('Revoke')} busy={busy} onConfirm={revoke} onCancel={() => setConfirming(false)}>
            {t('{name} is disconnected right away and can’t reconnect. To use it again, pair it with a new code.', { name: device.name })}
          </ConfirmPane>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        <Button variant="ghost" size="sm" className={SIGN_OUT} disabled={busy} aria-label={t('Revoke {name}', { name: device.name })} onClick={() => setConfirming(true)}>
          {t('Revoke')}
        </Button>
      </div>
    </li>
  )
}
