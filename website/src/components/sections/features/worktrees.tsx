"use client"

import { useEffect, useRef, useState } from "react"
import { GitBranch } from "lucide-react"
import { Panel, PanelHead } from "./panel"
import { useActive } from "./use-active"

const BR = [
  { d: "M70 150 C 100 150, 100 60, 140 60 H 330 C 370 60, 370 150, 400 150", cls: "stroke-c-accent", l: "restore-tabs", lx: 150, ly: 48 },
  { d: "M150 150 C 180 150, 180 100, 215 100 H 470", cls: "stroke-c-waiting", l: "rate-limit", lx: 225, ly: 90 },
  { d: "M240 150 C 270 150, 270 190, 300 190 H 440 C 470 190, 470 150, 495 150", cls: "stroke-c-success", l: "pricing-copy", lx: 310, ly: 204 },
]
const MONO = { fontFamily: "var(--font-mono)" }

// Git graph: the branches draw one after another, then "Merged" appears
export function WorktreesViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [drawnRaw, setDrawn] = useState(true)
  const [mergedRaw, setMerged] = useState(true)
  const drawn = active ? drawnRaw : true
  const merged = active ? mergedRaw : true

  useEffect(() => {
    if (!active) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const run = () => {
      setDrawn(false)
      setMerged(false)
      timers.push(setTimeout(() => setDrawn(true), 60))
      timers.push(setTimeout(() => setMerged(true), 2300))
    }
    timers.push(setTimeout(run, 0))
    const iv = setInterval(run, 7500)
    return () => {
      clearInterval(iv)
      timers.forEach(clearTimeout)
    }
  }, [active])

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="inset-x-6 top-7 h-[244px]">
        <PanelHead right="ladder">
          <GitBranch className="size-3.5 text-c-muted" aria-hidden />
          Worktrees
        </PanelHead>
        <svg viewBox="0 0 560 206" preserveAspectRatio="xMidYMid meet" className="block h-[206px] w-full" aria-hidden>
          <path d="M30 150 H530" className="stroke-c-border" strokeWidth={2} fill="none" strokeLinecap="round" />
          <text x={30} y={172} fontSize={11} className="fill-c-muted" style={MONO}>main</text>
          {BR.map((b, i) => (
            <g key={b.l}>
              <path
                d={b.d}
                pathLength={1}
                className={b.cls}
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                style={{
                  strokeDasharray: "1 1",
                  strokeDashoffset: drawn ? 0 : 1,
                  transition: drawn ? `stroke-dashoffset 1.8s ${i * 0.45}s cubic-bezier(.6,0,.2,1)` : "none",
                }}
              />
              <text x={b.lx} y={b.ly} fontSize={11} className="fill-c-text" style={MONO}>{b.l}</text>
            </g>
          ))}
          {[70, 150, 240, 400, 495].map((x) => (
            <circle key={x} cx={x} cy={150} r={4.5} className="fill-c-bg stroke-c-muted" strokeWidth={2} />
          ))}
          <g style={{ opacity: merged ? 1 : 0, transition: "opacity .3s" }}>
            <rect x={378} y={112} width={58} height={20} rx={6} className="fill-c-surface stroke-c-success" strokeOpacity={0.5} />
            <text x={407} y={126} textAnchor="middle" fontSize={11} className="fill-c-success">Merged</text>
          </g>
          <circle cx={470} cy={100} r={4} className="fill-c-waiting">
            <animate attributeName="r" values="4;7;4" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;.3;1" dur="1.6s" repeatCount="indefinite" />
          </circle>
          <text x={482} y={104} fontSize={11} className="fill-c-waiting">working</text>
        </svg>
      </Panel>
    </div>
  )
}
