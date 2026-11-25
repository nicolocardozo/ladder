import { useEffect, useState } from 'react'

/** The current time, refreshed every `everyMs`: makes reset windows disappear and keeps "Updated 3 min ago" honest. In Unix seconds. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
