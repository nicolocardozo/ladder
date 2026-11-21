"use client"

import { useEffect, useRef, useState } from "react"
import { Inbox } from "lucide-react"
import { NeedsYou, DoneCheck } from "@/components/ladder-ui/status"
import { cn } from "@/lib/utils"
import { Panel, PanelHead } from "./panel"
import { useActive } from "./use-active"

const REQ: [string, string][] = [
  ["billing-api", "Codex wants to run pnpm test"],
  ["infra", "Claude Code asks: keep Node 20 in the CI matrix?"],
  ["marketing-web", "Gemini CLI wants to edit 4 files"],
  ["ladder", "Claude Code wants to run pnpm typecheck"],
  ["billing-api", "Codex wants to write outside the worktree"],
]

type Item = { id: number; p: string; t: string }
const initial: Item[] = REQ.slice(0, 4).map(([p, t], i) => ({ id: i, p, t }))

// Le richieste si approvano una alla volta ed escono; ne arriva una nuova in fondo
export function WaitingViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [itemsRaw, setItems] = useState<Item[]>(initial)
  const [stageRaw, setStage] = useState<"idle" | "ok" | "out">("idle")
  const [entering, setEntering] = useState<number | null>(null)
  const next = useRef(4)
  // Fuori schermo o con movimento ridotto: lista iniziale, senza stati intermedi
  const items = active ? itemsRaw : initial
  const stage = active ? stageRaw : "idle"

  useEffect(() => {
    if (!active) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const iv = setInterval(() => {
      setStage("ok")
      timers.push(setTimeout(() => setStage("out"), 500))
      timers.push(
        setTimeout(() => {
          const n = next.current++
          const [p, t] = REQ[n % REQ.length]
          setItems((prev) => [...prev.slice(1), { id: n, p, t }])
          setStage("idle")
          setEntering(n)
          requestAnimationFrame(() => requestAnimationFrame(() => setEntering(null)))
        }, 950),
      )
    }, 2800)
    return () => {
      clearInterval(iv)
      timers.forEach(clearTimeout)
    }
  }, [active])

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="top-[34px] bottom-[-1px] left-1/2 w-[min(420px,88%)] -translate-x-1/2 rounded-b-none">
        <PanelHead right="3 requests">
          <Inbox className="size-3.5 text-c-muted" aria-hidden />
          Waiting
        </PanelHead>
        <div className="flex flex-col gap-2 p-2.5">
          {items.map((it, i) => {
            const first = i === 0
            const ok = first && stage !== "idle"
            return (
              <div
                key={it.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] border border-transparent bg-c-surface px-3 py-2.5 transition-[transform,opacity,border-color] duration-[450ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
                  first && !ok && "border-c-waiting/45",
                  ok && "border-c-success/50",
                  first && stage === "out" && "translate-x-[50px] opacity-0",
                  entering === it.id && "-translate-y-3 opacity-0",
                )}
              >
                {ok ? <DoneCheck /> : <NeedsYou />}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-[11px] text-c-muted">{it.p}</span>
                  <br />
                  {it.t}
                </span>
                <kbd className={cn("rounded-[5px] border border-c-border px-[5px] py-[3px] font-mono text-[11px] leading-none text-c-muted", ok && "border-c-success/50 text-c-success")}>⏎</kbd>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}
