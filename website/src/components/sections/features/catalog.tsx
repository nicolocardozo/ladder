"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Package } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { cn } from "@/lib/utils"
import { Panel, PanelHead } from "./panel"
import { useActive } from "./use-active"

const C = [
  { a: "gemini", n: "Gemini CLI", s: "Binary · 38.4 MiB", v: "0.19.2", h: "github.com/google-gemini", z: "38.4 MiB", sha: "9f2c4e1a7b03d58e6c91f0a2b47e3d65c8a19f04e2b7d36a5c10e98f4b2a7d31" },
  { a: "opencode", n: "OpenCode", s: "npx on first use", v: "1.4.0", h: "registry.npmjs.org", z: "12.1 MiB", sha: "4b7d1e09a3f2c8650de1b97a24f3c06e5d8b1a92f07c34e6b5d2a18c90f4e7b2" },
  { a: "goose", n: "Goose", s: "Binary · 61.0 MiB", v: "1.12.1", h: "github.com/block", z: "61.0 MiB", sha: "c03e9a7f12b4d6850e2f1a3b9c7d4e5061f8a2b3c4d5e6f708192a3b4c5d6e7f8" },
]
const BUILT_IN = [
  { a: "claude", n: "Claude Code" },
  { a: "codex", n: "Codex" },
]

type Phase = { cur: number; k: number; label: string; ok: boolean; added: number[] }
// Stato statico completo: Gemini CLI verificato e aggiunto
const STATIC: Phase = { cur: 0, k: 64, label: "Added", ok: true, added: [0] }

// Righe Install/Added e sha256 verificato carattere per carattere
export function CatalogViz() {
  const ref = useRef<HTMLDivElement>(null)
  const active = useActive(ref)
  const [pRaw, setP] = useState<Phase>(STATIC)
  const p = active ? pRaw : STATIC

  useEffect(() => {
    if (!active) return
    let stop = false
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    ;(async () => {
      let cur = 0
      let added: number[] = []
      while (!stop) {
        setP({ cur, k: 0, label: "Download", ok: false, added })
        await sleep(1400)
        setP({ cur, k: 0, label: "Verifying…", ok: false, added })
        for (let n = 0; n <= 64 && !stop; n += 2) {
          setP({ cur, k: n, label: "Verifying…", ok: false, added })
          await sleep(45)
        }
        added = [...added, cur]
        setP({ cur, k: 64, label: "Added", ok: true, added })
        await sleep(2400)
        cur = (cur + 1) % C.length
        if (cur === 0) added = []
      }
    })()
    return () => {
      stop = true
    }
  }, [active])

  const c = C[p.cur]
  const rowBase = "flex items-center gap-2.5 border-b border-c-line px-3.5 py-2"
  const pill = "whitespace-nowrap rounded-md border border-c-border px-2 py-[3px] text-[11.5px] text-c-muted"

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="inset-x-0 top-6 mx-auto grid w-[min(760px,92%)] grid-cols-1 min-[700px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="hidden border-r border-c-line min-[700px]:block">
          <PanelHead>
            <Package className="size-3.5 text-c-muted" aria-hidden />
            Agents
          </PanelHead>
          {BUILT_IN.map((b) => (
            <div key={b.a} className={rowBase}>
              <AgentIcon agent={b.a} className="size-4" />
              <span className="min-w-0 flex-1">
                {b.n}
                <small className="block text-[11px] text-c-muted">Built in</small>
              </span>
              <span className={cn(pill, "border-c-success/50 text-c-success")}>Added</span>
            </div>
          ))}
          {C.map((a, i) => {
            const isAdded = p.added.includes(i)
            return (
              <div key={a.n} className={cn(rowBase, "last:border-b-0", i === p.cur && "bg-c-selection/50")}>
                <AgentIcon agent={a.a} className="size-4" />
                <span className="min-w-0 flex-1">
                  {a.n}
                  <small className="block text-[11px] text-c-muted">{a.s}</small>
                </span>
                <span className={cn(pill, isAdded && "border-c-success/50 text-c-success")}>{isAdded ? "Added" : "Install"}</span>
              </div>
            )
          })}
        </div>
        <div className="min-w-0">
          <PanelHead right="ACP registry">
            Install <span className="-ml-1">{c.n}</span>
          </PanelHead>
          <div className="flex flex-col gap-1.5 px-4 py-3.5">
            {[["Version", c.v], ["From", c.h], ["Size", c.z]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-xs">
                <span className="text-c-muted">{k}</span>
                <span className="min-w-0 truncate text-right font-mono text-[11.5px] leading-normal">{v}</span>
              </div>
            ))}
            <div className="mt-1 break-all rounded-lg bg-c-code px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-c-muted">
              sha256 <i className="not-italic text-c-success">{c.sha.slice(0, p.k)}</i>
              {c.sha.slice(p.k)}
            </div>
            <div className="mt-1.5 flex min-h-7 items-center justify-between gap-2 text-xs text-c-muted">
              <span className={cn("inline-flex items-center gap-1.5 text-c-success opacity-0 transition-opacity duration-300", p.ok && "opacity-100")}>
                <Check className="size-3.5" aria-hidden />
                Checksum verified · signature checked
              </span>
              <span className="shrink-0 rounded-md bg-c-accent px-2.5 py-1 text-[11.5px] font-medium text-c-bg">{p.label}</span>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
