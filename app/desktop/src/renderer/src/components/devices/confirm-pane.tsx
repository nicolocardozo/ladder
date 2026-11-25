// Confirmation pane inside a row (the same as "Sign out" and the agent download): focus goes to "Cancel", Esc closes only the pane
// and returns focus to the button that opened it.
import { useEffect, useRef, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'

export function ConfirmPane({ children, confirmLabel, busy, onConfirm, onCancel }: { children: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    opener.current = document.activeElement
    cancel.current?.focus()
  }, [])
  const close = () => {
    onCancel()
    const back = opener.current
    if (back instanceof HTMLElement && back.isConnected && !(back as HTMLButtonElement).disabled) requestAnimationFrame(() => back.focus())
  }
  return (
    <div
      role="group"
      aria-label={t('Confirm')}
      className="flex flex-col gap-2 rounded-md bg-muted p-3"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // Esc closes only the pane, not Settings.
        e.stopPropagation()
        close()
      }}
    >
      <p className="text-xs">{children}</p>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" className="text-sm" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button ref={cancel} variant="ghost" size="sm" className="text-sm" onClick={close}>
          {t('Cancel')}
        </Button>
      </div>
    </div>
  )
}
