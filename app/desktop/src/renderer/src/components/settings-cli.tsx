// Settings → Data and system → Command line: the `ladder` command in the terminal. Status, installation, PATH and examples.
import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { CliStatus } from '@shared/protocol'
import { Outcome, SettingRow, SettingsBlock, settingsButton } from '@/components/settings-parts'
import { request } from '@/lib/host-client'

/** A line of code with its "Copy" button: the outcome is announced separately. */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div className="flex min-w-0 items-center gap-2 px-4 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={text}>
        {text}
      </code>
      <button
        type="button"
        aria-label={t('Copy {text}', { text })}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1800)
          })
        }}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {copied ? <Check aria-hidden className="size-3.5 text-success" strokeWidth={2.4} /> : <Copy aria-hidden className="size-3.5" strokeWidth={1.8} />}
      </button>
      <span role="status" className="sr-only">
        {copied ? t('Copied') : ''}
      </span>
    </div>
  )
}

const EXAMPLES = ['ladder ls', 'ladder new . "Fix the failing test" --agent codex --wait', 'ladder wait <id>', 'ladder attach <id>']

const dirOf = (path: string) => path.replace(/\/[^/]*$/, '') || '/'

export function CliBlock() {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    request<CliStatus>({ type: 'cli.status' })
      .then((next) => {
        setStatus(next)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const run = async (type: 'cli.install' | 'cli.uninstall') => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await request<CliStatus>({ type }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const profileLine = status ? `export PATH="${dirOf(status.path)}:$PATH"` : ''
  return (
    <SettingsBlock id="cli-title" title={t('Command line')} description={t('Start, message and wait for sessions from the terminal. Agents can do the same with Ladder’s tools.')}>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <SettingRow
          label={t('The ladder command')}
          hint={status ? (status.installed ? t('Installed at {path}', { path: status.path }) : t('Not installed. It would go to {path}.', { path: status.path })) : t('Checking…')}
        >
          <button type="button" disabled={!status || busy} onClick={() => void run(status?.installed ? 'cli.uninstall' : 'cli.install')} className={settingsButton}>
            {busy ? t('Working…') : status?.installed ? t('Uninstall') : t('Install')}
          </button>
        </SettingRow>
        {status && (
          <SettingRow
            label={t('Connection')}
            hint={status.socket ? t('Ladder is listening for commands.') : t('Ladder is not listening. Restart it if the command can’t connect.')}
          >
            <span className="text-xs text-muted-foreground">{status.socket ? t('Listening') : t('Not listening')}</span>
          </SettingRow>
        )}
        {status?.installed && !status.inPath && (
          <div className="flex flex-col gap-1 py-2">
            <p className="px-4 pt-1 text-xs text-muted-foreground">{t('{folder} is not in your PATH. Add this line to your shell profile, then open a new terminal.', { folder: dirOf(status.path) })}</p>
            <CopyLine text={profileLine} />
          </div>
        )}
      </div>
      {error && (
        <div className="mt-2">
          <Outcome tone="error">{error}</Outcome>
        </div>
      )}
      <h4 className="mt-4 text-xs font-semibold text-muted-foreground">{t('Examples')}</h4>
      <div className="mt-1.5 flex flex-col divide-y divide-border rounded-lg border border-border">
        {EXAMPLES.map((example) => (
          <CopyLine key={example} text={example} />
        ))}
      </div>
    </SettingsBlock>
  )
}
