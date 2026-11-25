import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** The system's "Reduce Motion": `null` until known (a few ms), then true/false; follows changes while in use. */
export function useReduceMotion(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v))
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(v))
    return () => {
      alive = false
      sub.remove()
    }
  }, [])
  return reduce
}
