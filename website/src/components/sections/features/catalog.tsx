"use client"

import { useEffect, useRef, useState } from "react"
import { Check, CircleDashed, Download, Loader2, Package } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { cn } from "@/lib/utils"
import { Panel, PanelHead } from "./panel"
import { useActive } from "./use-active"

// Downloadable binary entries (sample data): descriptions and texts as in the app's catalog
const C = [
  { a: "goose", n: "goose", d: "Block’s extensible local agent, with tools through MCP.", v: "1.12.1", h: "github.com/block", z: "61.0 MiB", from: "The ACP registry", sha: "c03e9a7f12b4d6850e2f1a3b9c7d4e5061f8a2b3c4d5e6f708192a3b4c5d6e7f8" },
  { a: "opencode", n: "OpenCode", d: "Open-source coding agent that works with many model providers.", v: "1.4.0", h: "github.com/sst", z: "12.1 MiB", from: "The GitHub release", sha: "4b7d1e09a3f2c8650de1b97a24f3c06e5d8b1a92f07c34e6b5d2a18c90f4e7b2" },
  { a: "amp", n: "Amp", d: "Sourcegraph’s agent for large codebases.", v: "0.9.2", h: "github.com/sourcegraph", z: "38.4 MiB", from: "The GitHub release", sha: "9f2c4e1a7b03d58e6c91f0a2b47e3d65c8a19f04e2b7d36a5c10e98f4b2a7d31" },
]

type Phase = { cur: number; k: number; label: string; ok: boolean; added: number[] }
// Complete static state: Gemini CLI verified and added
const STATIC: Phase = { cur: 0, k: 64, label: "Added", ok: true, added: [0] }

// Install/Added rows and sha256 verified character by character
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
        setP({ cur, k: 0, label: "Download and add", ok: false, added })
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
  const verifying = p.label === "Verifying…"
  const btn = "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium"

  return (
    <div ref={ref} className="absolute inset-0">
      <Panel className="inset-x-0 top-4 mx-auto grid w-[min(880px,94%)] grid-cols-1 min-[700px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="hidden border-r border-c-line min-[700px]:block">
          <PanelHead>
            <Package className="size-3.5 text-c-muted" aria-hidden />
            Add an agent
          </PanelHead>
          <div className="flex flex-col gap-1.5 p-2">
            <div className="px-1 text-[11.5px] font-semibold text-c-muted">Most used</div>
            <div className="flex flex-col divide-y divide-c-line rounded-lg border border-c-line">
              {C.map((a, i) => {
                const isAdded = p.added.includes(i)
                return (
                  <div key={a.n} className="flex items-start gap-2.5 px-3 py-2">
                    <AgentIcon agent={a.a} className="mt-0.5 size-[18px]" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="text-[13px] font-medium">{a.n}</span>
                        {isAdded ? (
                          <span className="inline-flex items-center gap-1 text-[11.5px] text-c-success">
                            <Check className="size-3" aria-hidden />
                            Added
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11.5px] text-c-muted">
                            <CircleDashed className="size-3" aria-hidden />
                            Available to download
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-1 text-[11.5px] text-c-muted">{a.d}</p>
                      <p className="truncate font-mono text-[11px] text-c-muted/70">
                        Binary from {a.h} · v{a.v}
                      </p>
                    </div>
                    {isAdded ? null : (
                      <span className={cn(btn, "border border-c-border", i === p.cur && "opacity-50")}>
                        <Download className="size-3.5" aria-hidden />
                        Download and add
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <div className="min-w-0 p-3">
          <div className="flex flex-col gap-2 rounded-md bg-c-code p-3">
            <p className="text-[12px] font-medium">
              Download {c.n} v{c.v}?
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-c-muted">Version</dt>
              <dd className="tabular-nums">v{c.v}</dd>
              <dt className="text-c-muted">Downloads from</dt>
              <dd className="min-w-0 break-all font-mono">{c.h}</dd>
              <dt className="text-c-muted">Size</dt>
              <dd className="tabular-nums">{c.z}</dd>
              <dt className="text-c-muted">Checksum (SHA-256)</dt>
              <dd className="min-w-0 break-all font-mono text-[11px] leading-[1.5] text-c-muted">
                <i className="not-italic text-c-success">{c.sha.slice(0, p.k)}</i>
                {c.sha.slice(p.k)}
              </dd>
              <dt className="text-c-muted">Checksum from</dt>
              <dd>{c.from}</dd>
            </dl>
            <div className="flex min-h-7 items-center gap-2 text-[12px]">
              {p.ok ? (
                <span className="inline-flex items-center gap-1.5 text-c-success">
                  <Check className="size-3.5" aria-hidden />
                  Added · checksum verified
                </span>
              ) : verifying ? (
                <span className="inline-flex items-center gap-2 text-c-muted">
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  Verifying the download…
                </span>
              ) : (
                <>
                  <span className={cn(btn, "border border-c-border")}>Download and add</span>
                  <span className={cn(btn, "text-c-muted")}>Cancel</span>
                </>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
