"use client"

import { useEffect, useRef, useState } from "react"
import { ListChecks } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { DoneCheck, RunningRing } from "@/components/ladder-ui/status"
import { cn } from "@/lib/utils"
import { Panel, PanelHead } from "./panel"
import { sleep, useActive } from "./use-active"

type Status = "pending" | "running" | "done"

const TASKS = [
  { title: "Schema and migration", agent: "claude", name: "Claude", after: null, where: "plan folder" },
  { title: "Export endpoint", agent: "codex", name: "Codex", after: "after 1", where: "worktree" },
  { title: "Export button", agent: "claude", name: "Claude", after: "after 1", where: "worktree" },
  { title: "Review", agent: "gemini", name: "Gemini CLI", after: "after 2, 3", where: "read-only" },
] as const

// Each step of the run: tasks 2 and 3 run side by side in their own worktrees
const STEPS: Status[][] = [
  ["pending", "pending", "pending", "pending"],
  ["running", "pending", "pending", "pending"],
  ["done", "running", "running", "pending"],
  ["done", "done", "running", "pending"],
  ["done", "done", "done", "running"],
  ["done", "done", "done", "done"],
]
// Static state: the parallel step, the most telling one
const STATIC = STEPS[2]

function Glyph({ status }: { status: Status }) {
  if (status === "done") return <DoneCheck />
  if (status === "running") return <RunningRing />
  return <span aria-hidden className="inline-block size-3.5 rounded-full border border-c-muted/60" />
}

// A plan runs task by task: dependencies first, independent tasks in parallel, a review at the end
export function PlansViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [stepRaw, setStep] = useState(2)
  const statuses = active ? STEPS[stepRaw] : STATIC
  const complete = statuses.every((x) => x === "done")

  useEffect(() => {
    if (!active) return
    let stop = false
    ;(async () => {
      while (!stop) {
        for (let i = 0; i < STEPS.length && !stop; i++) {
          setStep(i)
          await sleep(i === 0 ? 700 : i === STEPS.length - 1 ? 2600 : 1500)
        }
      }
    })()
    return () => {
      stop = true
    }
  }, [active])

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="inset-x-6 top-7 h-[244px]">
        <PanelHead right={complete ? "Plan complete" : "Running"}>
          <ListChecks className="size-3.5 text-c-muted" aria-hidden />
          Plan · Billing export
        </PanelHead>
        <ol className="divide-y divide-c-line">
          {TASKS.map((task, i) => (
            <li key={task.title} className="flex h-[51px] items-center gap-3 px-3.5">
              <span className="w-3 text-[11px] text-c-muted tabular-nums">{i + 1}</span>
              <Glyph status={statuses[i]} />
              <span className={cn("min-w-0 flex-1 truncate transition-colors duration-300", statuses[i] === "pending" && "text-c-muted")}>
                {task.title}
                {task.after ? <span className="ml-2 hidden text-[11px] text-c-muted sm:inline">{task.after}</span> : null}
              </span>
              <span
                className={cn(
                  "hidden rounded-md px-1.5 py-0.5 text-[10.5px] text-c-muted ring-1 ring-c-line transition-opacity duration-300 sm:inline",
                  statuses[i] !== "running" && "opacity-0",
                )}
              >
                {task.where}
              </span>
              <AgentIcon agent={task.agent} name={task.name} className="size-4" />
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  )
}
