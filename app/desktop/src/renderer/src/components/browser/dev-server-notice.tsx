// Avviso discreto quando il terminale del progetto stampa un indirizzo locale: propone di aprirlo nella colonna browser,
// ma non apre niente da solo. Con la colonna aperta lo stesso avviso sta nella sua barra (browser-view.tsx).
import { Globe, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { browserAddress } from '@/lib/browser-tabs'
import { isBrowserColumnOpen, useApp } from '@/store/app-store'

export function DevServerNotice({ projectId }: { projectId: string }) {
  const server = useApp((s) => (s.selection.projectId === projectId && !isBrowserColumnOpen(s, projectId) ? s.devServers[projectId] : undefined))
  const available = Boolean(window.ladder?.browser)
  const dismiss = useApp((s) => s.dismissDevServer)
  if (!server || !available) return null
  const address = browserAddress(server.url)
  return (
    <div role="status" className="absolute top-[52px] right-3 z-20 flex h-9 max-w-[min(420px,calc(100%-24px))] items-center gap-2 rounded-lg border border-border bg-popover pr-1 pl-3 text-sm text-popover-foreground shadow-md">
      <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <span className="min-w-0 truncate text-muted-foreground">{t('Dev server found')}</span>
      <Button size="xs" variant="outline" className="shrink-0" onClick={() => useApp.getState().openBrowser(projectId, { url: server.url })}>
        {t('Open {address} in the browser', { address })}
      </Button>
      <button
        type="button"
        aria-label={t('Dismiss')}
        onClick={() => dismiss(projectId)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
