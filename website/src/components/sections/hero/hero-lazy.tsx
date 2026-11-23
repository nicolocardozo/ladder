"use client"

// Parti client del hero, caricate dopo il primo paint (ssr:false). Il contenitore server
// ha già le stesse dimensioni, quindi non c'è layout shift.
import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"
import { useTheme } from "@/lib/theme"

const GradientWaves = dynamic(() => import("@/components/react-bits/GradientWaves"), { ssr: false })

export const HeroWindow = dynamic(() => import("./ladder-window"), { ssr: false })

const subscribeRM = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}

/** Onde calme nei colori del brand, chiare o scure secondo il tema; ferme con movimento ridotto. */
export function HeroWaves() {
  const reduced = useSyncExternalStore(
    subscribeRM,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  )
  const dark = useTheme() === "dark"
  return (
    <GradientWaves
      lightMode={!dark}
      backgroundColor={dark ? "#130F1C" : "#F4F3F8"}
      horizonColor={dark ? "#3A1E9C" : "#5525CF"}
      waveColor={dark ? "#7B5CF0" : "#AC97FF"}
      crestColor={dark ? "#C9BCFF" : "#FFFFFF"}
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
