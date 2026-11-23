import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { CatalogViz } from "./catalog"
import { LimitsViz } from "./limits"
import { SubagentsViz } from "./subagents"
import { WaitingViz } from "./waiting"
import { WorktreesViz } from "./worktrees"

// Scheda: area visiva con fondo a puntini, poi titolo e testo (server-rendered per la SEO)
function Card({ viz, title, wide, children }: { viz: ReactNode; title: string; wide?: boolean; children: ReactNode }) {
  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-[18px] border border-hairline bg-surface transition-[transform,box-shadow] duration-300",
        "hover:-translate-y-[3px] hover:shadow-[0_20px_50px_-20px_rgb(40_22_90/0.18)] motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        wide && "min-[861px]:col-span-2",
      )}
    >
      <div aria-hidden className="relative h-[300px] overflow-hidden border-b border-hairline bg-frame min-[861px]:data-[wide]:h-[330px]" data-wide={wide ? "" : undefined}>
        <div
          className="absolute inset-0 opacity-80"
          style={{ backgroundImage: "radial-gradient(circle, var(--color-dot) 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}
        />
        {viz}
      </div>
      <div className="px-6 pt-[22px] pb-[26px]">
        <h3 className="text-lg font-semibold tracking-[-0.015em]">{title}</h3>
        <p className={cn("mt-1.5 text-[14.5px]", wide ? "max-w-[96ch]" : "max-w-[56ch]", "leading-[1.55] text-muted-ink")}>{children}</p>
      </div>
    </article>
  )
}

export function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-4 pt-10 pb-28 sm:px-8">
      <p className="text-[13px] font-semibold text-iris">Built for waves of work</p>
      <h2 className="mt-2.5 max-w-[20ch] text-[clamp(30px,3.8vw,44px)] leading-[1.08] font-[650] tracking-[-0.03em] text-balance">
        You write a request. Somewhere else, an agent needs you.
      </h2>
      <p className="mt-3.5 max-w-[58ch] text-[16.5px] text-muted-ink">
        Ladder keeps every project in view, so switching costs one keystroke instead of your train of thought.
      </p>

      <div className="mt-12 grid grid-cols-1 gap-5 min-[861px]:grid-cols-2">
        <Card viz={<WaitingViz />} title="One place for everything waiting on you">
          Approvals and questions from every repository land in one list, oldest first. Answer with ⏎ and the next one is already there.
        </Card>
        <Card viz={<SubagentsViz />} title="Sub-agents you can follow">
          When an agent splits the work, Ladder draws the map: who started whom, what each one is doing, and the report that comes back.
        </Card>
        <Card viz={<WorktreesViz />} title="A worktree for every session">
          Each agent works on its own branch in its own folder. Review the diff, merge it, or throw it away without touching your checkout.
        </Card>
        <Card viz={<LimitsViz />} title="Plan limits before they surprise you">
          See what is left of your Claude and Codex plans, per window, while the agents spend it. Ladder warns you before a long run stops halfway.
        </Card>
        <Card wide viz={<CatalogViz />} title="No surprise downloads">
          Agents from the ACP registry install only after you have seen the version, host, size and full sha256. Ladder checks the signature afterwards and never updates an agent on its own.
        </Card>
      </div>
    </section>
  )
}
