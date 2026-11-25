// Our own sheets (ui/Sheet.tsx) for Android and wide screens, where the iOS `formSheet` routes are not used.
// Opened by openSheet() (lib/sheets.ts); mounted once at the root. They close when the screen changes
// (disconnection, notification tap): a sheet must not stay on top of a route that is no longer its own.
import { usePathname } from 'expo-router'
import { useEffect, useState } from 'react'
import { nativeSheets, useSheets, type SheetSpec } from '@/lib/sheets'
import { t } from '@shared/i18n'
import { SheetTitle } from '@/ui/NativeSheet'
import { Sheet } from '@/ui/Sheet'
import { MacContent } from '../mac/MacContent'
import { RequestContent } from '../request/RequestSheet'
import { PermissionContent } from '../session/PermissionSheet'
import { SwitchContent } from '../session/SwitchSheet'
import { TurnContent } from '../session/TurnSheet'
import { NewSessionContent } from './NewSessionContent'

export function SheetHost() {
  const current = useSheets((s) => s.current)
  const close = useSheets((s) => s.close)
  const pathname = usePathname()
  // The last sheet stays in memory until the closing animation ends (Sheet unmounts itself).
  const [last, setLast] = useState<SheetSpec | null>(null)
  useEffect(() => {
    if (current) setLast(current)
  }, [current])
  useEffect(() => {
    close()
  }, [pathname, close])
  const spec = current ?? last
  if (!spec || nativeSheets()) return null
  return (
    <Sheet visible={!!current} onClose={close}>
      {spec.kind === 'request' ? <RequestContent sessionId={spec.sessionId} requestId={spec.requestId} onClose={close} /> : null}
      {spec.kind === 'permission' ? <PermissionContent sessionId={spec.sessionId} onClose={close} /> : null}
      {spec.kind === 'switch' ? <SwitchContent sessionId={spec.sessionId} onClose={close} /> : null}
      {spec.kind === 'turn' ? <TurnContent turn={spec.turn} /> : null}
      {spec.kind === 'mac' ? (
        <>
          <SheetTitle>{t('Your Mac')}</SheetTitle>
          <MacContent sheet />
        </>
      ) : null}
      {spec.kind === 'new-session' ? <NewSessionContent onClose={close} /> : null}
    </Sheet>
  )
}
