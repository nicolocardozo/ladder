"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "@/lib/theme"

const GhostFibers = dynamic(() => import("@/components/react-bits/GhostFibers"), { ssr: false })

// Layer a tutta la sezione: la fascia resta bassa riducendo spread e onde, non l'altezza del canvas
// (con un canvas basso e largo la camera inquadra più mondo in orizzontale e le fibre non arrivano ai bordi) (nessun layout shift); WebGL montato solo vicino al viewport.
export function FibersLazy() {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [reduced, setReduced] = useState(false)
  const dark = useTheme() === "dark"

  useEffect(() => {
    const el = box.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: "300px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={box} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 [mask-image:linear-gradient(transparent,#000_25%,#000_75%,transparent)]"
    >
      {near && (
        <GhostFibers
          className="absolute inset-0"
          lightMode={!dark}
          paused={reduced}
          fiberStyle="dots"
          glowColor={dark ? "#8B84A6" : "#7A8094"}
          lineColor={dark ? "#6E6788" : "#6B7280"}
          secondaryColor={dark ? "#A99FD0" : "#8A8FA3"}
          spread={0.9}
          waves={0.7}
          speed={0.3}
          flow={0.15}
          density={0.8}
          brightness={0.85}
          vignette={0.05}
          grain={0}
          mouseInteraction={false}
        />
      )}
    </div>
  )
}
