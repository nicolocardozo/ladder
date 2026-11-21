"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef, useState } from "react"

const GhostFibers = dynamic(() => import("@/components/react-bits/GhostFibers"), { ssr: false })

// Layer assoluto a tutta la sezione (nessun layout shift); WebGL montato solo vicino al viewport.
export function FibersLazy() {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [reduced, setReduced] = useState(false)

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
    <div ref={box} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      {near && (
        <GhostFibers
          className="absolute inset-0"
          lightMode
          paused={reduced}
          fiberStyle="dots"
          glowColor="#7A8094"
          lineColor="#6B7280"
          secondaryColor="#8A8FA3"
          spread={1.6}
          waves={1.4}
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
