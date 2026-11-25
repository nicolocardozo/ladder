"use client"

import { useEffect, useRef, useState } from "react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { DoneCheck, RunningRing } from "@/components/ladder-ui/status"
import { cn } from "@/lib/utils"
import { useActive } from "./use-active"

const SUBS = [
  { x: 24, y: 68, label: "Map the host", kind: "Explore" },
  { x: 50, y: 82, label: "Check renderer", kind: "Explore" },
  { x: 76, y: 68, label: "Write tests", kind: "General" },
]

const NODE =
  "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[10px] bg-c-bg px-[11px] py-2 text-[11px] text-c-text shadow-[0_0_0_1px_rgb(24_20_36/0.9),0_12px_28px_-10px_rgb(60_30_160/0.4)] transition-[opacity,transform] duration-[350ms] sm:text-xs motion-reduce:transition-none"

// A map that builds itself: the main agent launches three subagents, which finish one at a time
export function SubagentsViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Complete static state: all visible and finished
  const [shownRaw, setShown] = useState([true, true, true])
  const [doneRaw, setDone] = useState([true, true, true])
  const shown = active ? shownRaw : [true, true, true]
  const done = active ? doneRaw : [true, true, true]

  useEffect(() => {
    if (!active) return
    let stop = false
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const set = (arr: boolean[], i: number, v: boolean) => arr.map((x, j) => (j === i ? v : x))
    ;(async () => {
      while (!stop) {
        let s = [false, false, false]
        let d = [false, false, false]
        setShown(s)
        setDone(d)
        await sleep(700)
        for (let i = 0; i < 3 && !stop; i++) {
          await sleep(380)
          s = set(s, i, true)
          setShown(s)
          await sleep(200)
        }
        for (const i of [0, 1, 2]) {
          if (stop) return
          await sleep(900 + Math.random() * 500)
          d = set(d, i, true)
          setDone(d)
        }
        await sleep(1800)
      }
    })()
    return () => {
      stop = true
    }
  }, [active])

  return (
    <div ref={ref} className="absolute inset-0">
      {/* Lines in real pixels (not a distorted viewBox), so the animated dashing stays clean */}
      {size.w > 0 && (
        <svg width={size.w} height={size.h} className="absolute inset-0" aria-hidden>
          {SUBS.map((n, i) => {
            const x0 = size.w / 2
            const y0 = size.h * 0.2 + 17
            const x1 = (size.w * n.x) / 100
            const y1 = (size.h * n.y) / 100 - 17
            const my = (y0 + y1) / 2
            return (
              <path
                key={n.label}
                d={`M${x0} ${y0} C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`}
                fill="none"
                pathLength={1}
                strokeWidth={1.5}
                strokeLinecap="round"
                className={cn("transition-[stroke] duration-300", done[i] ? "stroke-c-success/70" : "stroke-c-accent/70")}
                style={{
                  strokeDasharray: "1 1",
                  strokeDashoffset: shown[i] ? 0 : 1,
                  transition: shown[i] ? "stroke-dashoffset .7s cubic-bezier(.6,0,.2,1), stroke .3s" : "none",
                }}
              />
            )
          })}
        </svg>
      )}
      <div className={cn(NODE, "left-1/2 top-[20%]")}>
        <AgentIcon agent="claude" className="size-4" />
        <b className="font-medium">Restore tabs</b>
        <small className="hidden text-[11px] text-c-muted sm:inline">Opus 5.5</small>
      </div>
      {SUBS.map((n, i) => (
        <div
          key={n.label}
          className={cn(NODE, !shown[i] && "translate-y-[-30%] opacity-0")}
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
        >
          {done[i] ? <DoneCheck /> : <RunningRing />}
          {n.label}
          <small className="hidden text-[11px] text-c-muted sm:inline">{n.kind}</small>
        </div>
      ))}
    </div>
  )
}
