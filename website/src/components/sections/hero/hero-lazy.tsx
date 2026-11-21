"use client"

// Parti client del hero, caricate dopo il primo paint (ssr:false). Il contenitore server
// ha già le stesse dimensioni, quindi non c'è layout shift.
import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"

const GradientWaves = dynamic(() => import("@/components/react-bits/GradientWaves"), { ssr: false })

export const HeroWindow = dynamic(() => import("./ladder-window"), { ssr: false })

const subscribeRM = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}

/** Onde calme in modalità chiara, colori del brand; ferme con movimento ridotto. */
export function HeroWaves() {
  const reduced = useSyncExternalStore(
    subscribeRM,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  )
  return (
    <GradientWaves
      lightMode
      backgroundColor="#F4F3F8"
      horizonColor="#5525CF"
      waveColor="#AC97FF"
      crestColor="#FFFFFF"
      speed={0.15}
      amplitude={1.6}
      waveScale={0.5}
      sheen={0.2}
      grain={0.05}
      opacity={0.85}
      intro={false}
      swellOnClick={false}
      paused={reduced}
    />
  )
}
