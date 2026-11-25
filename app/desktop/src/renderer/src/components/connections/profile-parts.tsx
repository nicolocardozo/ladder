// Agent profiles inside Settings → Subscriptions: a profile row with menu (rename, remove), collapsible usage limits
// and "Add account". Login stays the usual ConnectionRow: only the hooks are here.
import { useEffect, useRef, useState } from 'react'
import { EllipsisVertical, Loader2, Plus, RotateCw, TriangleAlert } from 'lucide-react'
import type { ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { UsageRow, updatedLabel, useUsage, usageAlert, usageAlertText } from '@/components/composer/usage-button'
import { CONNECTION_NAME, type ConnectionActions } from '@/lib/connections'
import { runningSessionsOn } from '@/lib/usage-accounts'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { ConnectionRow } from './connection-row'

/** Host messages are already translated; if missing, a generic text. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('Something went wrong. Try again.')
}

/**
 * Usage limits of the profile, already open: the 5-hour and weekly windows with the usual compact bars (`UsageRow`).
 * They are read on open (refreshed if the data is old), as in the composer panel.
 */
function ProfileUsage({ agent, profile }: { agent: ProfileAgent; profile: Profile }) {
  const { status, loading, failed, now, native, windows, refresh, opened } = useUsage(agent, profile.id)
  useEffect(() => {
    opened()
    // Only when the row opens: `opened` changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The plan windows (5 hours, weekly), not the per-model ones: the others stay in the composer panel.
  const plan = windows.filter((w) => !w.model)
  const shown = (plan.length ? plan : windows).slice().sort((a, b) => a.minutes - b.minutes).slice(0, 2)
  // As in the composer panel: running sessions with this account and a warning mark (shape as well as color).
  const running = useApp((s) => runningSessionsOn(Object.values(s.sessions), agent, profile.id))
  const alert = usageAlert(windows)
  const alertText = alert ? usageAlertText(alert, now) : null
  return (
    <div className="flex flex-col gap-2" aria-label={t('Usage limits')} role="group">
      {running > 0 && <span className="text-xs text-muted-foreground tabular-nums">{plural(running, '1 session in use', '{n} sessions in use')}</span>}
      {alert && alertText && (
        <p className="flex items-start gap-1.5 text-xs font-medium">
          <TriangleAlert aria-hidden className={cn('mt-px size-3.5 shrink-0', alert.limited ? 'text-destructive' : 'text-attention')} strokeWidth={2} />
          <span className="min-w-0">{alertText.what}</span>
        </p>
      )}
      {shown.length > 0 ? (
        shown.map((usage) => <UsageRow key={usage.key} usage={usage} now={now} compact />)
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {loading ? t('Reading your plan limits…') : t('No usage data yet. It appears after the first reply.')}
        </p>
      )}
      <div className="-mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-faint">{loading ? t('Updating…') : failed ? `${t('Update failed')} · ${updatedLabel(status?.usageAt, now)}` : updatedLabel(status?.usageAt, now)}</span>
        {native && (
          <Button variant="ghost" size="icon-xs" disabled={loading} aria-label={t('Refresh usage of {name}', { name: profile.name })} title={t('Refresh usage')} onClick={refresh}>
            <RotateCw aria-hidden className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        )}
      </div>
    </div>
  )
}

/** A connection row for a profile: name (with rename field), usage limits and menu. The default one can't be removed or renamed. */
export function ProfileRow({ agent, profile, count, status, actions, showTool }: { agent: ProfileAgent; profile: Profile; count: number; status: ConnectionStatus | null; actions: ConnectionActions; showTool?: boolean }) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'remove'>('idle')
  const [value, setValue] = useState(profile.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const cancelRemove = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (mode === 'rename') {
      const frame = requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
      return () => cancelAnimationFrame(frame)
    }
    if (mode === 'remove') cancelRemove.current?.focus()
  }, [mode])

  const title = count > 1 ? `${CONNECTION_NAME[agent]} · ${profile.name}` : CONNECTION_NAME[agent]
  const manageable = !profile.isDefault && Boolean(actions.renameProfile && actions.removeProfile)

  const close = () => {
    setMode('idle')
    setValue(profile.name)
    requestAnimationFrame(() => menuButton.current?.focus())
  }
  const rename = async () => {
    const name = value.trim()
    if (!name || name === profile.name) return close()
    setBusy(true)
    setError(null)
    try {
      await actions.renameProfile!(profile.id, name)
      if (mounted.current) {
        setMode('idle')
        requestAnimationFrame(() => menuButton.current?.focus())
      }
    } catch (e) {
      if (mounted.current) setError(messageOf(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await actions.removeProfile!(profile.id)
    } catch (e) {
      if (mounted.current) {
        setError(messageOf(e))
        setMode('idle')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <ConnectionRow
      id={agent}
      status={status}
      actions={actions}
      showTool={showTool}
      profileId={profile.isDefault ? undefined : profile.id}
      name={title}
      titleSlot={
        mode === 'rename' ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void rename()
            }}
          >
            <Input
              ref={input}
              value={value}
              disabled={busy}
              maxLength={40}
              aria-label={t('Account name')}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                close()
              }}
              className="h-7 w-44"
            />
            <Button type="submit" variant="outline" size="sm" className="text-sm" disabled={busy || !value.trim()}>
              {t('Save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-sm" onClick={close}>
              {t('Cancel')}
            </Button>
          </form>
        ) : undefined
      }
      usage={<ProfileUsage agent={agent} profile={profile} />}
      footer={
        <>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {mode === 'remove' && (
            <div
              role="group"
              aria-label={t('Confirm')}
              className="flex flex-col gap-2 rounded-md bg-muted p-3"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.stopPropagation()
                close()
              }}
            >
              <p className="text-xs">{t('Remove “{name}”? Its idle and archived sessions move to the default account, and their conversation restarts as a new one (the transcript stays in Ladder). The account’s folder and its sign-in stay on your Mac.', { name: profile.name })}</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" className="text-sm" disabled={busy} onClick={() => void remove()}>
                  {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
                  {t('Remove account')}
                </Button>
                <Button ref={cancelRemove} variant="ghost" size="sm" className="text-sm" onClick={close}>
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          )}
        </>
      }
      trailing={
        manageable ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button ref={menuButton} variant="ghost" size="icon-sm" aria-label={t('Options for {name}', { name: title })} />}>
              <EllipsisVertical aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={() => {
                  setError(null)
                  setMode('rename')
                }}
              >
                {t('Rename')}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setError(null)
                  setMode('remove')
                }}
              >
                {t('Remove account')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <TrailingSpace />
        )
      }
    />
  )
}

/** The space of the "⋮" in rows that don't have it: buttons stay aligned in columns. */
export function TrailingSpace() {
  return <span aria-hidden className="size-7 shrink-0" />
}

/** "Add account" below an agent's rows: a name field, inline. On creation focus goes to the new profile's "Sign in". */
export function AddProfile({ agent, actions, onCreated }: { agent: ProfileAgent; actions: ConnectionActions; onCreated: (profile: Profile) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  if (!actions.createProfile) return null

  const close = () => {
    setOpen(false)
    setName('')
    setError(null)
    requestAnimationFrame(() => opener.current?.focus())
  }
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const profile = await actions.createProfile!(agent, trimmed)
      setOpen(false)
      setName('')
      onCreated(profile)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="px-4 py-2">
        <Button ref={opener} variant="ghost" size="sm" className="-ml-2 text-sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          {t('Add {name} account', { name: CONNECTION_NAME[agent] })}
        </Button>
      </div>
    )
  }
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={`new-profile-${agent}`} className="text-xs font-semibold text-muted-foreground">
        {t('Account name')}
      </label>
      <div className="flex items-center gap-2">
        <Input
          ref={input}
          id={`new-profile-${agent}`}
          value={name}
          disabled={busy}
          maxLength={40}
          placeholder={t('Work, Personal…')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `new-profile-${agent}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            close()
          }}
          className="h-8 w-56"
        />
        <Button type="submit" variant="outline" size="sm" className="text-sm" disabled={busy || !name.trim()}>
          {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {t('Create')}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="text-sm" onClick={close}>
          {t('Cancel')}
        </Button>
      </div>
      {error && (
        <p id={`new-profile-${agent}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
