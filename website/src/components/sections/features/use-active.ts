"use client"

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

// Vero se l'utente chiede meno movimento; sul server resta falso (lo stato statico è già completo)
export function useReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(QUERY)
      mq.addEventListener("change", cb)
      return () => mq.removeEventListener("change", cb)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}

// Vero solo mentre l'elemento è visibile e il movimento non è ridotto: le animazioni partono e si fermano da qui
export function useActive(ref: RefObject<Element | null>) {
  const reduced = useReducedMotion()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])

  return visible && !reduced
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
