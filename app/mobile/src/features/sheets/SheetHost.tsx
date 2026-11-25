// Sheet "nostri" (ui/Sheet.tsx) per Android e per gli schermi larghi, dove non si usano le rotte `formSheet` di iOS.
// Aperti da openSheet() (lib/sheets.ts); montati una volta sola nella radice. Si chiudono se cambia la schermata
// (scollegamento, tocco su una notifica): uno sheet non deve restare sopra una rotta che non è più la sua.
import { usePathname } from 'expo-router'
import { useEffect, useState } from 'react'
import { nativeSheets, useSheets, type SheetSpec } from '@/lib/sheets'
import { Sheet } from '@/ui/Sheet'
import { RequestContent } from '../request/RequestSheet'
import { PermissionContent } from '../session/PermissionSheet'
import { SwitchContent } from '../session/SwitchSheet'
import { TurnContent } from '../session/TurnSheet'
import { NewSessionContent } from './NewSessionContent'

export function SheetHost() {
  const current = useSheets((s) => s.current)
  const close = useSheets((s) => s.close)
  const pathname = usePathname()
  // L'ultimo sheet resta in memoria finché l'animazione di chiusura non finisce (Sheet lo smonta da sé).
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
      {spec.kind === 'new-session' ? <NewSessionContent onClose={close} /> : null}
    </Sheet>
  )
}
