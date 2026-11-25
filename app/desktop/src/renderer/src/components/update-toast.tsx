// One-time notice when an update has been downloaded: bottom left (on the right the browser column, a native view, would cover it).
// It closes with the X or with Restart; once closed, it does not return for that version. The row above the sidebar footer stays regardless.
import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { installUpdate, useUpdate } from '@/lib/updates'
import { useApp } from '@/store/app-store'

const DISMISSED = 'ladder.updateToast.dismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

export function UpdateToast() {
  const update = useUpdate()
  const [dismissed, setDismissed] = useState(readDismissed)
  // Like the sidebar row: if any agent is working, restarting interrupts it and we say so beforehand.
  const working = useApp((s) => Object.values(s.sessions).some((session) => session.run === 'running' || session.run === 'starting' || session.run === 'waiting'))
  if (update?.status !== 'ready' || dismissed === update.next) return null
  const next = update.next
  const dismiss = () => {
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED, next)
    } catch {
      // Without storage the notice will return at the next launch: that is fine.
    }
  }
  return (
    <div
      role="status"
      className="fixed bottom-16 left-3 z-50 flex w-[300px] max-w-[calc(100vw-24px)] items-start gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
    >
      <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{t('Ladder {version} is ready', { version: next })}</p>
          <p className="text-xs text-muted-foreground">
            {working ? t('Restarting now interrupts the agents that are working. Otherwise it installs when you quit Ladder.') : t('Restart to update now, or it installs when you quit Ladder.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void installUpdate()}>
            {t('Restart')}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {t('Later')}
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label={t('Dismiss')}
        onClick={dismiss}
        className="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
