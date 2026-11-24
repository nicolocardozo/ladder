import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"

// Agenti mostrati con il comando di accesso, solo quelli presenti nel codice dell'app
// (host/connections.ts, host/acp/others.ts). Dove non c'è un comando verificato: null.
const AGENTS = [
  { id: "claude", name: "Claude Code", login: "claude auth login" },
  { id: "codex", name: "Codex", login: "codex login" },
  { id: "gemini", name: "Gemini CLI", login: "gemini" },
  { id: "opencode", name: "OpenCode", login: null },
  { id: "goose", name: "Goose", login: null },
  { id: "qwen", name: "Qwen Code", login: null },
  { id: "amp", name: "Amp", login: null },
  { id: "cline", name: "Cline", login: null },
  { id: "kimi", name: "Kimi CLI", login: null },
] as const

const TILE =
  "group flex items-center gap-3 rounded-xl border border-hairline bg-surface p-3 transition-colors hover:border-iris/30"

export function Agents() {
  return (
    <section
      id="agents"
      className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-24 sm:px-8 sm:py-32 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16"
    >
      <div className="lg:pt-2">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-iris">Agents</p>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Use the subscriptions you already have
        </h2>
        <p className="mt-4 text-base text-muted-ink sm:text-lg">
          Ladder does not sell tokens and does not ask for another subscription. Each agent signs in
          with your own account, the same way it does in a terminal.
        </p>
        <p className="mt-4 rounded-xl border border-hairline bg-surface p-4 text-[15px] text-ink">
          No resold tokens. No extra quotas. Your plan&apos;s limits stay yours, and Ladder shows
          them before you run out.
        </p>
        <Link
          href="/agents"
          className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-medium text-iris hover:underline"
        >
          See all supported agents <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>

      <ul className="grid gap-2 min-[480px]:grid-cols-2">
        {AGENTS.map((a) => (
          <li key={a.id} className="contents">
            <div className={TILE}>
              <span className="flex size-10 flex-none items-center justify-center rounded-lg bg-c-bg text-c-text transition-colors group-hover:text-c-accent">
                <AgentIcon agent={a.id} name={a.name} className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium text-ink">{a.name}</span>
                <span className="block break-words font-mono text-[11px] text-muted-ink">{a.login ? <span className="text-ink">{a.login}</span> : "Sign in from its app"}</span>
              </span>
            </div>
          </li>
        ))}
        <li className="contents">
          <Link href="/agents" className={`${TILE} justify-between text-muted-ink hover:text-ink`}>
            <span className="pl-1 text-[15px] font-medium">+30 more</span>
            <ArrowRight aria-hidden className="mr-1 size-4" />
          </Link>
        </li>
      </ul>
    </section>
  )
}
