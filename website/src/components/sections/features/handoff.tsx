"use client"

import { useEffect, useRef, useState } from "react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { DoneCheck, RunningRing } from "@/components/ladder-ui/status"
import { cn } from "@/lib/utils"
import { sleep, useActive } from "./use-active"

const NODE =
  "absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[10px] bg-c-bg px-[11px] py-2 text-[11px] text-c-text shadow-[0_0_0_1px_rgb(24_20_36/0.9),0_12px_28px_-10px_rgb(60_30_160/0.4)] transition-[opacity,transform] duration-[350ms] sm:text-xs motion-reduce:transition-none"

// Node centers, in percent of the visual area
const FROM = { x: 35, y: 22 }
const TO = { x: 64, y: 50 }
const ADVICE = { x: 38, y: 80 }

type Stage = { claudeDone: boolean; handoff: boolean; codex: boolean; advice: boolean; sent: boolean }
const DONE: Stage = { claudeDone: true, handoff: true, codex: true, advice: true, sent: true }
const START: Stage = { claudeDone: false, handoff: false, codex: false, advice: false, sent: false }

// Claude hands the session to Codex with a summary, then another agent's advice is sent to Codex
export function HandoffViz() {
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
  // Off screen or with reduced motion: the complete final state
  const [stageRaw, setStage] = useState<Stage>(DONE)
  const s = active ? stageRaw : DONE

  useEffect(() => {
    if (!active) return
    let stop = false
    ;(async () => {
      while (!stop) {
        let st = START
        const step = async (ms: number, patch: Partial<Stage>) => {
          await sleep(ms)
          if (stop) return
          st = { ...st, ...patch }
          setStage(st)
        }
        setStage(st)
        await step(1100, { claudeDone: true })
        await step(500, { handoff: true })
        await step(900, { codex: true })
        await step(1500, { advice: true })
        await step(1100, { sent: true })
        await sleep(2600)
      }
    })()
    return () => {
      stop = true
    }
  }, [active])

  const px = (p: { x: number; y: number }) => ({ x: (size.w * p.x) / 100, y: (size.h * p.y) / 100 })
  const a = px(FROM)
  const b = px(TO)
  const c = px(ADVICE)
  const handoffPath = `M${a.x} ${a.y + 17} C ${a.x} ${(a.y + b.y) / 2 + 20}, ${b.x - 80} ${b.y}, ${b.x - 70} ${b.y}`
  const advicePath = `M${c.x + 60} ${c.y - 17} C ${c.x + 80} ${c.y - 40}, ${b.x} ${b.y + 40}, ${b.x} ${b.y + 17}`
  const draw = (on: boolean) => ({
    strokeDasharray: "1 1",
    strokeDashoffset: on ? 0 : 1,
    transition: on ? "stroke-dashoffset .7s cubic-bezier(.6,0,.2,1)" : "none",
  })

  return (
    <div ref={ref} className="absolute inset-0">
      {size.w > 0 && (
        <svg width={size.w} height={size.h} className="absolute inset-0" aria-hidden>
          <path d={handoffPath} fill="none" pathLength={1} strokeWidth={1.5} strokeLinecap="round" className="stroke-c-accent/70" style={draw(s.handoff)} />
          <path d={advicePath} fill="none" pathLength={1} strokeWidth={1.5} strokeLinecap="round" className="stroke-c-success/70" style={draw(s.sent)} />
        </svg>
      )}

      <div className={NODE} style={{ left: `${FROM.x}%`, top: `${FROM.y}%` }}>
        {s.claudeDone ? <DoneCheck /> : <RunningRing />}
        <AgentIcon agent="claude" name="Claude" className="size-4" />
        <b className="font-medium">Pagination refactor</b>
      </div>

      <div
        className={cn(NODE, "gap-1.5 px-2.5 py-1 text-[10.5px] text-c-muted sm:text-[11px]", !s.handoff && "opacity-0")}
        style={{ left: `${(FROM.x + TO.x) / 2 - 6}%`, top: `${(FROM.y + TO.y) / 2 - 2}%` }}
      >
        <span className="text-c-accent">/handoff codex</span>
        <span className="hidden sm:inline">· summary</span>
      </div>

      <div className={cn(NODE, !s.codex && "translate-y-[-30%] opacity-0")} style={{ left: `${TO.x}%`, top: `${TO.y}%` }}>
        <RunningRing />
        <AgentIcon agent="codex" name="Codex" className="size-4" />
        <b className="font-medium">Pagination refactor</b>
        <small className="hidden text-[11px] text-c-muted sm:inline">from Claude</small>
      </div>

      <div
        className={cn(NODE, "flex-col items-start gap-1 py-2", !s.advice && "translate-y-[30%] opacity-0")}
        style={{ left: `${ADVICE.x}%`, top: `${ADVICE.y}%` }}
      >
        <span className="flex items-center gap-2">
          <AgentIcon agent="gemini" name="Gemini CLI" className="size-4" />
          <b className="font-medium">Advice</b>
          <span className={cn("text-[10.5px] text-c-success transition-opacity duration-300", !s.sent && "opacity-0")}>Sent to Codex</span>
        </span>
        <span className="text-c-muted">Cover page 0 and the last page.</span>
      </div>
    </div>
  )
}
