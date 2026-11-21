"use client"

import dynamic from "next/dynamic"

// DotGrid (WebGL2) caricato solo sul client: il primo paint usa il pattern CSS statico sotto
const DotGrid = dynamic(() => import("@/components/react-bits/DotGrid"), { ssr: false })

export function ClosingDots() {
  return (
    <DotGrid
      baseColor="#4A4357"
      activeColor="#AC97FF"
      dotSize={4}
      gap={22}
      opacity={0.7}
      clickShock={false}
      className="absolute inset-0 h-full w-full"
    />
  )
}
