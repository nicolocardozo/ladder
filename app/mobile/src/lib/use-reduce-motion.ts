import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** "Reduce Motion" del sistema: `null` finché non si sa (pochi ms), poi true/false; segue le modifiche in corso d'uso. */
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
