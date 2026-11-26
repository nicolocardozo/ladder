"use client"

import { useEffect, useRef } from "react"
import { useActive, useReducedMotion } from "@/components/sections/features/use-active"

// The recording is 1290×2796 (iPhone 17 Pro). During a screen recording iOS widens the Dynamic Island and adds a
// red dot: this pill covers it, in the island's position and size within the recording.
const ISLAND = { left: "28.6%", width: "41.2%", top: "1%", height: "4.4%" }

// iPhone drawn in CSS around a screen recording of the phone app with sample data.
export function PhoneDemo() {
  const ref = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const active = useActive(ref)
  const reduced = useReducedMotion()

  // Plays only while visible; with reduced motion it stays on the poster.
  useEffect(() => {
    const v = video.current
    if (!v) return
    if (active) void v.play().catch(() => undefined)
    else v.pause()
  }, [active])

  return (
    <div ref={ref} className="relative w-[232px] sm:w-[248px]">
      {/* Side buttons: action and volume on the left, power on the right */}
      <span className="absolute top-[17%] -left-[3px] h-[5%] w-[4px] rounded-l-sm bg-[#3a3744]" />
      <span className="absolute top-[25%] -left-[3px] h-[9%] w-[4px] rounded-l-sm bg-[#3a3744]" />
      <span className="absolute top-[36%] -left-[3px] h-[9%] w-[4px] rounded-l-sm bg-[#3a3744]" />
      <span className="absolute top-[28%] -right-[3px] h-[13%] w-[4px] rounded-r-sm bg-[#3a3744]" />
      <div className="rounded-[46px] bg-[linear-gradient(145deg,#5b5766,#24212c_35%,#18161e_65%,#4a4654)] p-[3px] shadow-[0_40px_80px_-30px_rgb(60_30_160/0.55),0_12px_30px_-12px_rgb(20_16_30/0.5)]">
        <div className="rounded-[43px] bg-[#09080c] p-[7px]">
          <div className="relative aspect-[1290/2796] overflow-hidden rounded-[36px] bg-[#171321]">
            <video
              ref={video}
              className="absolute inset-0 size-full object-cover"
              src="/mobile/app-demo.mp4"
              poster="/mobile/app-demo-poster.jpg"
              muted
              loop
              playsInline
              preload={reduced ? "none" : "metadata"}
              aria-label="The Ladder phone app: the session list, requests to approve, a proposed file change and an agent's question"
            />
            <span aria-hidden className="absolute rounded-full bg-black" style={ISLAND} />
          </div>
        </div>
      </div>
    </div>
  )
}
