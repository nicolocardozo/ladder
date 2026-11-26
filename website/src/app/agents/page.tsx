import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { Check, Minus } from "lucide-react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { Code, PageHeader, PageShell, Prose, Section } from "@/components/page"
import { getRegistryAgents } from "./registry"

export const metadata: Metadata = {
  title: "Supported agents",
  description:
    "Coding agents Ladder runs on macOS: Claude, Codex, Gemini CLI, Cursor, GitHub Copilot, OpenCode, Goose, Cline and every ACP agent, plus any CLI in a terminal.",
  alternates: { canonical: "/agents" },
  openGraph: { url: "/agents" },
}

// Built-in agents: adapter written specifically in Ladder
const BUILT_IN = [
  {
    id: "claude",
    name: "Claude",
    how: "Runs the official claude binary (Claude Code) through Anthropic's Claude Agent SDK.",
    login: "Your own Claude login, done with Anthropic's sign-in flow in your browser. Add more than one account, such as Work and Personal.",
    extras: "Approvals and questions, sub-agent map, plan limits, model and effort per message, four permission levels.",
  },
  {
    id: "codex",
    name: "Codex",
    how: "Talks to codex app-server, using the Codex you already have: the CLI, the Codex app or the editor extension.",
    login: "Your ChatGPT login, handled by Codex itself. More than one account is supported here too.",
    extras: "Approve, allow for the session or deny with a reason, sub-agents, plan limits, threads that resume after a restart.",
  },
] as const

// ACP agents curated in the app (host/acp/catalog.ts), in the same order, with verified installs.
// `login` is the sign-in command the app knows (host/acp/others.ts); null where none is verified:
// the app shows the methods the agent declares, or opens the agent's CLI in a terminal.
const CURATED: { id: string; name: string; login: string | null }[] = [
  { id: "gemini", name: "Gemini CLI", login: "gemini" },
  { id: "cursor", name: "Cursor", login: "cursor-agent login" },
  { id: "github-copilot-cli", name: "GitHub Copilot", login: "copilot login" },
  { id: "opencode", name: "OpenCode", login: null },
  { id: "amp", name: "Amp", login: null },
  { id: "goose", name: "goose", login: null },
  { id: "cline", name: "Cline", login: null },
  { id: "qwen", name: "Qwen Code", login: null },
  { id: "kiro", name: "Kiro CLI", login: null },
  { id: "junie", name: "Junie", login: null },
  { id: "factory-droid", name: "Factory Droid", login: null },
  { id: "grok-build", name: "Grok Build", login: "grok login" },
]

// registry ids already described above, not to repeat in the full list
const SHOWN = new Set(["claude-acp", "codex-acp", "gemini", "cursor", "github-copilot-cli", "opencode", "amp-acp", "goose", "cline", "qwen-code", "kiro", "junie", "factory-droid", "grok-build"])

type Cell = boolean | string
const COLUMNS = ["Claude", "Codex", "ACP agents", "Terminal"] as const
const ROWS: { label: string; cells: [Cell, Cell, Cell, Cell] }[] = [
  { label: "Chat with live streaming", cells: [true, true, true, "Native TUI"] },
  { label: "Approvals as cards with shortcuts", cells: [true, true, "Agent's own options", "In the TUI"] },
  { label: "Shows up in Waiting", cells: [true, true, true, "claude and codex"] },
  { label: "Changes per turn, with restore", cells: [true, true, "Computed from git", false] },
  { label: "Sub-agent map", cells: [true, true, false, false] },
  { label: "Plan limits and reset times", cells: [true, true, false, false] },
  { label: "Model and effort per message", cells: [true, true, "Agent's own options", false] },
  { label: "Worktree per session", cells: [true, true, true, true] },
]

function CellValue({ value }: { value: Cell }) {
  if (value === true) return <Check aria-label="Yes" className="size-4 text-iris" />
  if (value === false) return <Minus aria-label="No" className="size-4 text-hairline" />
  return <span className="text-[13px] text-muted-ink">{value}</span>
}

const tile = "flex items-center gap-3 rounded-xl border border-hairline bg-surface p-3"
const glyph = "flex size-10 flex-none items-center justify-center rounded-lg bg-c-bg text-c-text"

export default function Page() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Agents"
        title="Every agent you already use, in one window"
        lead="Ladder doesn't replace your coding agents. It runs them with your own logins, configuration and skills, and shows you which ones are working and which ones are waiting for you."
      />

      <div className="mt-20 space-y-24">
        <Section
          id="built-in"
          title="Built in"
          intro="Two agents have a native adapter, so Ladder understands everything they do: approvals, edits, sub-agents and plan usage."
        >
          <ul className="mt-8 grid gap-3 md:grid-cols-2">
            {BUILT_IN.map((a) => (
              <li key={a.id} className="rounded-2xl border border-hairline bg-surface p-6">
                <div className="flex items-center gap-3">
                  <span className={glyph}>
                    <AgentIcon agent={a.id} name={a.name} className="size-5" />
                  </span>
                  <h3 className="text-xl font-semibold tracking-tight text-ink">{a.name}</h3>
                </div>
                <dl className="mt-5 space-y-3 text-[14.5px] leading-relaxed">
                  {[
                    ["How it runs", a.how],
                    ["Login", a.login],
                    ["In Ladder", a.extras],
                  ].map(([k, v]) => (
                    <div key={k} className="grid gap-1 sm:grid-cols-[110px_1fr] sm:gap-4">
                      <dt className="font-mono text-[11.5px] uppercase tracking-[0.08em] text-muted-ink sm:pt-0.5">{k}</dt>
                      <dd className="text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          id="acp"
          title="Agents that speak ACP"
          intro={
            <>
              The Agent Client Protocol is an open standard for connecting coding agents to editors. Add any of these from
              Settings → Agents. Ladder downloads them, checks the checksum and, where the vendor signs its binaries, the
              Apple Developer ID. Model, modes and permission options come from the agent itself, and so does the sign-in: Ladder
              shows the methods the agent offers, or opens its own command in a terminal. Where Ladder knows that command,
              it is shown under the name.
            </>
          }
        >
          <ul className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CURATED.map((a) => (
              <li key={a.id} className={tile}>
                <span className={glyph}>
                  <AgentIcon agent={a.id} name={a.name} className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium text-ink">{a.name}</span>
                  <span className="block break-words font-mono text-[11px] text-muted-ink">
                    {a.login ? <span className="text-ink">{a.login}</span> : "Agent's own sign-in"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Suspense fallback={null}>
            <RegistryList />
          </Suspense>
        </Section>

        <Section
          id="terminal"
          title="Any CLI, in a terminal session"
          intro="When you prefer the agent's own interface, start a terminal session instead of a chat. Ladder runs the original CLI in a real terminal, inside the project or its worktree."
        >
          <Prose className="mt-5">
            <ul>
              <li>
                <Code>claude</Code> reports its state through hooks Ladder adds for that process, so a permission prompt puts
                the session in Waiting.
              </li>
              <li>
                <Code>codex</Code> reports through the notifications of its TUI.
              </li>
              <li>For any other command, Ladder estimates whether it is working or idle from the terminal output.</li>
            </ul>
          </Prose>
        </Section>

        <Section id="compare" title="What Ladder sees, agent by agent">
          <div className="mt-8 overflow-x-auto rounded-2xl border border-hairline bg-surface">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <thead>
                <tr className="border-b border-hairline">
                  <th scope="col" className="px-5 py-3.5 font-medium text-muted-ink">
                    <span className="sr-only">Feature</span>
                  </th>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col" className="px-4 py-3.5 font-semibold text-ink">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label} className="border-b border-hairline last:border-0">
                    <th scope="row" className="px-5 py-3 font-medium text-ink">
                      {r.label}
                    </th>
                    {r.cells.map((v, i) => (
                      <td key={COLUMNS[i]} className="px-4 py-3">
                        <CellValue value={v} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="credentials" title="Your accounts stay yours">
          <Prose className="mt-5">
            <p>
              Every agent signs in with its own flow, in your browser or in its own CLI. Ladder never reads, stores or
              forwards your passwords or tokens, and there is no Ladder account. What Ladder shows, like the email and plan
              of each account and how much of your plan is left, it reads from the agent itself.
            </p>
            <p>
              GitHub goes through the <Code>gh</Code> CLI and its login. The Linear API key, if you add one, is encrypted in
              the macOS keychain. More in <Link href="/privacy">Privacy</Link>.
            </p>
          </Prose>
        </Section>
      </div>
    </PageShell>
  )
}

async function RegistryList() {
  const agents = (await getRegistryAgents()).filter((a) => !SHOWN.has(a.id))
  if (!agents.length) return null
  return (
    <div className="mt-12">
      <h3 className="text-lg font-semibold tracking-tight text-ink">More from the ACP registry</h3>
      <p className="mt-1.5 text-[14.5px] text-muted-ink">
        {agents.length} more agents, listed from the public registry and refreshed daily. Each one installs with npx, uvx or
        a binary download.
      </p>
      <ul className="mt-5 grid gap-x-8 sm:grid-cols-2">
        {agents.map((a) => (
          <li key={a.id} className="border-b border-hairline py-3">
            <p className="flex items-baseline justify-between gap-3">
              {a.website ? (
                <a href={a.website} rel="nofollow noopener" className="text-[15px] font-medium text-ink hover:text-iris">
                  {a.name}
                </a>
              ) : (
                <span className="text-[15px] font-medium text-ink">{a.name}</span>
              )}
              <span className="flex-none font-mono text-[11px] text-muted-ink">{a.via.join(" · ")}</span>
            </p>
            {a.description ? <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-muted-ink">{a.description}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
