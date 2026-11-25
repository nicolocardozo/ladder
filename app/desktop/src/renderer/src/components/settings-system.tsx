// Settings → Data and system: automatic archiving, Ladder data (folder, copies and export), launch at login, keep Mac awake and updates.
import { useCallback, useEffect, useState } from 'react'
import { Download, FolderOpen } from 'lucide-react'
import { localeTag, plural, t } from '@shared/i18n'
import type { DataInfo } from '@shared/protocol'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Outcome, SettingRow, SettingsBlock, settingsButton, Toggle } from '@/components/settings-parts'
import { CliBlock } from '@/components/settings-cli'
import { usePrefs } from '@/hooks/use-prefs'
import { request } from '@/lib/host-client'
import { formatBytes, system } from '@/lib/system-bridge'
import { checkForUpdate, installUpdate, useUpdate } from '@/lib/updates'

const NEVER = 'never'
const ARCHIVE_DAYS = [7, 14, 30, 60, 90, 180, 365]

export function SystemSection() {
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Data and system')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('What Ladder keeps on this Mac, and how it behaves alongside the rest of the system.')}
      </DialogDescription>
      {/* From 820 px: archiving and system on the left, data on the right. */}
      <div className="grid items-start gap-x-10 @[820px]:grid-cols-2">
        <div className="min-w-0">
          <ArchiveBlock />
          <SystemBlock />
          <CliBlock />
          <UpdatesBlock />
        </div>
        <div className="min-w-0">
          <DataBlock />
        </div>
      </div>
    </>
  )
}

function ArchiveBlock() {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  const days = prefs.autoArchiveDays
  // A value written by hand in the preferences file stays a valid entry of the list.
  const options = days !== null && !ARCHIVE_DAYS.includes(days) ? [...ARCHIVE_DAYS, days].sort((a, b) => a - b) : ARCHIVE_DAYS
  const dayLabel = (n: number) => plural(n, '{n} day', '{n} days')
  return (
    <SettingsBlock id="archive-title" title={t('Archiving')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t('Archive idle sessions')} hint={t('Archives sessions with no turn running, no request waiting and nothing queued for this long. Their conversations are kept.')}>
          <Select value={days === null ? NEVER : String(days)} onValueChange={(value) => update({ autoArchiveDays: value === NEVER ? null : Number(value) })}>
            <SelectTrigger aria-label={t('Archive idle sessions')} className="w-[150px]">
              <SelectValue>{(value: string) => (value === NEVER ? t('Never') : t('After {days}', { days: dayLabel(Number(value)) }))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEVER}>{t('Never')}</SelectItem>
              {options.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('After {days}', { days: dayLabel(n) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>
    </SettingsBlock>
  )
}

/** YYYYMMDD-HHMMSS, like the name of the host's copies. */
function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

type Result = { tone: 'muted' | 'error'; text: string } | null

function DataBlock() {
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'backup' | 'export' | null>(null)
  const [outcome, setOutcome] = useState<Result>(null)

  const load = useCallback(() => {
    request<DataInfo>({ type: 'data.info' })
      .then((data) => {
        setInfo(data)
        setLoadError(null)
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [])
  useEffect(load, [load])

  const backup = async (to?: string) => {
    setBusy(to ? 'export' : 'backup')
    setOutcome(null)
    try {
      const done = await request<{ path: string; bytes: number }>({ type: 'data.backup', ...(to ? { to } : {}) })
      setOutcome({ tone: 'muted', text: t('Saved {path} ({size}).', { path: done.path, size: formatBytes(done.bytes, localeTag()) }) })
      load()
    } catch (e) {
      setOutcome({ tone: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const exportTo = async () => {
    const path = await system.pickSavePath(`ladder-${stamp()}.db`)
    if (path) await backup(path)
  }
  const date = (at: number) => new Date(at).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <SettingsBlock id="data-title" title={t('Your data')} description={t('Sessions, conversations and settings live in one database on this Mac. A copy is consistent even while sessions are working.')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t('Data folder')} hint={info ? <span className="font-mono">{info.dir}</span> : loadError ? undefined : t('Reading…')} warning={loadError}>
          <button type="button" onClick={() => void request({ type: 'data.openFolder' }).catch((e: Error) => setOutcome({ tone: 'error', text: e.message }))} className={settingsButton}>
            <FolderOpen aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
            {t('Open folder')}
          </button>
        </SettingRow>
        <SettingRow label={t('Database')} hint={info ? <span className="font-mono">{info.dbPath}</span> : undefined}>
          <span className="text-sm text-muted-foreground tabular-nums">{info ? formatBytes(info.dbBytes, localeTag()) : '…'}</span>
        </SettingRow>
        <SettingRow label={t('Back up now')} hint={t('Adds a copy to the backups folder inside the data folder.')}>
          <button type="button" disabled={busy !== null} onClick={() => void backup()} className={settingsButton}>
            {busy === 'backup' ? t('Backing up…') : t('Back up')}
          </button>
        </SettingRow>
        <SettingRow label={t('Export a copy')} hint={t('Choose where to save it. Ladder can’t restore from a copy yet, so keep it somewhere safe.')}>
          <button type="button" disabled={busy !== null} onClick={() => void exportTo()} className={settingsButton}>
            <Download aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
            {busy === 'export' ? t('Exporting…') : t('Export…')}
          </button>
        </SettingRow>
      </div>
      {outcome && (
        <div className="mt-2">
          <Outcome tone={outcome.tone}>{outcome.text}</Outcome>
        </div>
      )}
      {info && info.backups.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground">{t('Latest copies')}</h4>
          <ul className="mt-1 flex flex-col text-xs text-muted-foreground">
            {info.backups.slice(0, 3).map((copy) => (
              <li key={copy.path} className="flex items-baseline gap-3 leading-5">
                <span className="shrink-0">{date(copy.at)}</span>
                <span className="shrink-0 tabular-nums">{formatBytes(copy.bytes, localeTag())}</span>
                <span className="min-w-0 truncate font-mono text-faint" title={copy.path}>
                  {copy.path}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsBlock>
  )
}

function SystemBlock() {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  return (
    <SettingsBlock id="system-title" title={t('System')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <Toggle label={t('Open Ladder at login')} description={t('Starts with your Mac. Works in the installed app only.')} checked={prefs.openAtLogin} onChange={(openAtLogin) => update({ openAtLogin })} />
        <Toggle label={t('Keep the Mac awake while agents work or a phone is connected')} description={t('The screen can still turn off. The Mac sleeps again when no session is working and no phone is connected.')} checked={prefs.keepAwake} onChange={(keepAwake) => update({ keepAwake })} />
      </div>
    </SettingsBlock>
  )
}

/** Installed version and updates: Ladder checks by itself every few hours; here you can check right away or restart. */
function UpdatesBlock() {
  const update = useUpdate()
  const version = update?.version ?? '…'
  const time = (at: number) => new Date(at).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
  const hint = (() => {
    switch (update?.status) {
      case undefined:
      case 'unsupported':
        return t('Updates work in the installed app only.')
      case 'idle':
        return update.checkedAt ? t('Up to date. Last checked at {time}.', { time: time(update.checkedAt) }) : t('Ladder checks for updates every few hours.')
      case 'checking':
        return t('Checking for updates…')
      case 'downloading':
        return t('Downloading {version}… {percent}%', { version: update.next, percent: update.percent })
      case 'ready':
        return t('{version} is ready. It installs when you restart or quit Ladder.', { version: update.next })
      case 'error':
        return null
    }
  })()
  const ready = update?.status === 'ready'
  return (
    <SettingsBlock id="updates-title" title={t('Updates')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t('Ladder {version}', { version })} hint={hint} warning={update?.status === 'error' ? t('Couldn’t check for updates: {message}', { message: update.message }) : null}>
          <button
            type="button"
            disabled={!update || update.status === 'unsupported' || update.status === 'checking' || update.status === 'downloading'}
            onClick={() => void (ready ? installUpdate() : checkForUpdate())}
            className={settingsButton}
          >
            {ready ? t('Restart') : t('Check now')}
          </button>
        </SettingRow>
      </div>
    </SettingsBlock>
  )
}
