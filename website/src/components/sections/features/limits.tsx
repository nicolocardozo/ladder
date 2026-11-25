"use client"

import { useEffect, useRef, useState } from "react"
import { Gauge } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { cn } from "@/lib/utils"
import { Panel, PanelHead } from "./panel"
import { useActive } from "./use-active"

const GROUPS = [
  { plan: "Claude Max", agent: "claude", running: "2 sessions running", rows: [["5-hour window", "resets in 2h 14m"], ["This week", "resets Mon 09:00"]] },
  { plan: "ChatGPT Plus", agent: "codex", running: "1 session running", rows: [["5-hour window", "resets in 3h 40m"], ["This week", "resets Thu 18:00"]] },
]
const START = [[58, 31], [22, 47]]

// Bars that rise while the agents consume the plan; amber above 80%
export function LimitsViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [vals, setVals] = useState(START)

  useEffect(() => {
    if (!active) return
    const iv = setInterval(() => {
      setVals((v) =>
        v.map((g) =>
          g.map((x, ri) => (x >= 92 ? (ri ? x : 4) : Math.min(96, x + (ri ? 1 : 2 + Math.round(Math.random() * 3))))),
        ),
      )
    }, 1400)
    return () => clearInterval(iv)
  }, [active])

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="top-[30px] left-1/2 w-[min(360px,88%)] -translate-x-1/2">
        <PanelHead right="updated now">
          <Gauge className="size-3.5 text-c-muted" aria-hidden />
          Plan limits
        </PanelHead>
        <div className="flex flex-col gap-3 px-3.5 py-3">
          {GROUPS.map((g, gi) => (
            <div key={g.plan} className="flex flex-col gap-3">
              {gi > 0 && <div className="my-0.5 h-px bg-c-line" />}
              <div className="flex items-center gap-2 font-semibold">
                <AgentIcon agent={g.agent} className="size-4" />
                {g.plan}
                <small className="ml-auto text-[11.5px] font-normal text-c-muted">{g.running}</small>
              </div>
              {g.rows.map(([label, reset], ri) => {
                const v = vals[gi][ri]
                return (
                  <div key={label}>
                    <div className="flex justify-between text-xs text-c-muted">
                      <span>{label} · {reset}</span>
                      <b className="font-medium tabular-nums text-c-text">{v}%</b>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-c-surface">
                      <div
                        className={cn("h-full rounded-full bg-c-accent transition-[width] duration-[900ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none", v >= 80 && "bg-c-waiting")}
                        style={{ width: `${v}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
