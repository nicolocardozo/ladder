import { useEffect, useState } from 'react'

/** L'ora, aggiornata ogni `everyMs`: serve a far sparire le finestre azzerate e a tenere "Updated 3 min ago" onesto. In secondi Unix. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
