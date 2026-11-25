"use client"

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

// True if the user asks for less motion; on the server it stays false (the static state is already complete)
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

// True only while the element is visible and motion is not reduced: animations start and stop from here
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
