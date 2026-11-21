"use client"

import { useEffect, useRef, useState } from "react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { DoneCheck, RunningRing } from "@/components/ladder-ui/status"
import { cn } from "@/lib/utils"
import { useActive } from "./use-active"

const SUBS = [
  { x: 19, y: 68, label: "Map the host", kind: "Explore" },
  { x: 50, y: 82, label: "Check renderer", kind: "Explore" },
  { x: 81, y: 68, label: "Write tests", kind: "General" },
]

const NODE =
  "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[10px] bg-c-bg px-[11px] py-2 text-[11px] text-c-text shadow-[0_0_0_1px_rgb(24_20_36/0.9),0_12px_28px_-10px_rgb(60_30_160/0.4)] transition-[opacity,transform] duration-[350ms] sm:text-xs motion-reduce:transition-none"

// Mappa che si costruisce: l'agente principale lancia tre sotto-agenti, che finiscono uno alla volta
export function SubagentsViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  // Stato statico completo: tutti visibili e finiti
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
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
        {SUBS.map((n, i) => {
          const y1 = n.y - 8
          return (
            <path
              key={n.label}
              d={`M50 26 C 50 ${(26 + y1) / 2}, ${n.x} ${(26 + y1) / 2}, ${n.x} ${y1}`}
              fill="none"
              pathLength={1}
              strokeWidth={1.5}
              strokeOpacity={0.6}
              vectorEffect="non-scaling-stroke"
              className={done[i] ? "stroke-c-success" : "stroke-c-accent"}
              style={{
                strokeDasharray: "1 1",
                strokeDashoffset: shown[i] ? 0 : 1,
                transition: shown[i] ? "stroke-dashoffset .7s cubic-bezier(.6,0,.2,1)" : "none",
              }}
            />
          )
        })}
      </svg>
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
