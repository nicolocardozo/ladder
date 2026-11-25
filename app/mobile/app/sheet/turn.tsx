import { useEffect } from 'react'
import { useSheets } from '@/lib/sheets'
import { TurnContent } from '@/features/session/TurnSheet'
import { NativeSheet } from '@/ui/NativeSheet'

export default function TurnRoute() {
  const turn = useSheets((s) => s.turn)
  // The turn doesn't stay in memory when the sheet closes.
  useEffect(() => () => useSheets.setState({ turn: null }), [])
  return <NativeSheet>{turn ? <TurnContent turn={turn} /> : null}</NativeSheet>
}
