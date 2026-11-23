import type { Metadata } from "next"
import Link from "next/link"
import { Code, CodeBlock, Kbd, PageHeader, PageShell, Prose, Section } from "@/components/page"
import { CTA, SITE } from "@/lib/site"

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How to use Ladder on macOS: projects and sessions, the Waiting view, reviewing changes, worktrees and .ladder/settings.toml, terminal sessions, plan limits and every keyboard shortcut.",
  alternates: { canonical: "/docs" },
  openGraph: { url: "/docs" },
}

const TOC = [
  { id: "start", label: "Getting started" },
  { id: "sessions", label: "Sessions and Waiting" },
  { id: "review", label: "Reviewing changes" },
  { id: "merge", label: "Branches and merge" },
  { id: "worktrees", label: "Worktrees and settings" },
  { id: "terminal", label: "Terminal sessions" },
  { id: "limits", label: "Accounts and plan limits" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "help", label: "Troubleshooting" },
] as const

// Predefiniti del preset "Ladder" (app/desktop/src/shared/shortcuts.ts)
const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "Navigation",
    items: [
      [["⌘", "K"], "Command palette: sessions, projects, actions and conversation text"],
      [["⌘", "P"], "Open a file by name, also as path:line"],
      [["⌘", "B"], "Show or hide the sidebar"],
      [["⌘", "["], "Back"],
      [["⌘", "]"], "Forward"],
      [["⌘", "1…9"], "Switch project"],
    ],
  },
  {
    group: "Sessions and tabs",
    items: [
      [["⌘", "N"], "New chat"],
      [["⌘", "⇧", "N"], "New session from an issue, a pull request or a branch"],
      [["⌘", "\\"], "Open a session side by side"],
      [["⌘", "⇧", "A"], "Next session waiting for you"],
      [["⌘", "."], "Interrupt the agent"],
      [["⌘", "W"], "Close tab"],
      [["⌘", "⌥", "←/→"], "Move focus between columns"],
    ],
  },
  {
    group: "Panels",
    items: [
      [["⌘", "⌥", "1"], "Changes"],
      [["⌘", "⌥", "2"], "Files"],
      [["⌘", "⌥", "3"], "History"],
      [["⌘", "⌥", "4"], "Merge"],
      [["⌃", "`"], "Terminal"],
    ],
  },
  {
    group: "Editor and message box",
    items: [
      [["⌘", "S"], "Save file"],
      [["⇧", "Tab"], "Cycle permission level"],
      [["Esc"], "Stop the current turn"],
      [["⌘", ","], "Settings"],
    ],
  },
]

export default function Page() {
  return (
    <PageShell className="max-w-6xl">
      <PageHeader
        eyebrow="Docs"
        title="Using Ladder"
        lead="Everything you need to run several agents across several repositories without losing track of any of them."
      />

      <div className="mt-16 grid gap-12 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16">
        <nav aria-label="On this page" className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-ink">On this page</p>
          <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[14px] lg:flex-col">
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`} className="text-muted-ink transition-colors hover:text-ink">
                  {t.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 space-y-20">
          <Section id="start" title="Getting started">
            <Prose className="mt-5">
              <p>
                Ladder runs on <strong>macOS with Apple Silicon</strong>. It is in private preview:{" "}
                <a href={CTA.href}>join the waitlist</a> to get the first build.
              </p>
              <ol>
                <li>
                  Open Ladder and add a project by choosing its folder. Any git repository works, and you can add as many
                  as you like.
                </li>
                <li>
                  Connect your agents in <strong>Settings → Agents</strong>. Claude Code and Codex sign in with their own
                  flow; agents that speak ACP install from the catalog. See <Link href="/agents">supported agents</Link>.
                </li>
                <li>
                  Start a chat with <Kbd>⌘</Kbd> <Kbd>N</Kbd>, pick the agent, model, effort and permission level, and
                  write what you want done. Type <Code>@</Code> to mention a file, paste or drop images, and keep writing
                  while the agent works: new messages wait in a queue you can edit.
                </li>
              </ol>
              <p>
                Everything stays on your Mac. There is no Ladder account and no server: sessions, settings and history
                live in a local folder.
              </p>
            </Prose>
          </Section>

          <Section id="sessions" title="Sessions and the Waiting view">
            <Prose className="mt-5">
              <p>
                Each project in the sidebar lists its sessions with a state you can read at a glance: <strong>working</strong>,{" "}
                <strong>waiting for you</strong>, <strong>unread</strong> or <strong>done</strong>. The provider mark and
                the model are shown wherever a session appears.
              </p>
              <h3>Waiting</h3>
              <p>
                Approvals and questions from every project collect in one place, followed by errors and replies to read.
                You can approve or answer without leaving the session in front of you: your draft and cursor stay where they
                were. Edits longer than 40 lines are approved from the session, after you have read them.
              </p>
              <p>
                <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>A</Kbd> jumps to the oldest request with the focus on Approve, and{" "}
                <Kbd>⌘</Kbd> <Kbd>[</Kbd> takes you back where you were.
              </p>
              <h3>Notifications</h3>
              <ul>
                <li>Approvals and questions notify you right away, unless you are looking at that session.</li>
                <li>Replies notify you only for turns longer than a minute, grouped by project.</li>
                <li>The Dock badge counts requests and errors you haven&apos;t seen.</li>
                <li>
                  <strong>Do not disturb for 1 hour</strong> pauses every banner. Turn it on from the Ladder menu,{" "}
                  <Kbd>⌘</Kbd> <Kbd>K</Kbd> or Settings.
                </li>
              </ul>
              <h3>Sub-agents</h3>
              <p>
                When an agent starts sub-agents, a chip above the message box shows how many are running. It opens a tree
                with the state, duration, model, tokens and tools of each one, and Ladder tells you when they finish.
              </p>
            </Prose>
          </Section>

          <Section id="review" title="Reviewing changes">
            <Prose className="mt-5">
              <p>The inspector on the right has three views.</p>
              <ul>
                <li>
                  <strong>Changes</strong> shows edits per turn, per session or uncommitted, unified or side by side.
                  Comment on any line and send all your comments to the agent in one message. Restore one file or
                  everything, and undo the restore.
                </li>
                <li>
                  <strong>Files</strong> is the project tree with git status and the turn that touched each file. Select
                  code and add it to the chat.
                </li>
                <li>
                  <strong>History</strong> puts checkpoints, restores and commits on one timeline.
                </li>
              </ul>
              <p>
                <strong>Ask for a review</strong> lets a different agent read the changes in read-only mode. Its comments
                land in the diff, ready to send to the agent that wrote the code.
              </p>
              <p>
                Click a file reference in the chat to open it in Ladder, or <Kbd>⌥</Kbd>-click to open it in Cursor or VS
                Code at the right line.
              </p>
            </Prose>
          </Section>

          <Section id="merge" title="Branches and merge">
            <Prose className="mt-5">
              <p>
                The <strong>Merge</strong> panel (<Kbd>⌘</Kbd> <Kbd>⌥</Kbd> <Kbd>4</Kbd>) shows the branch, its pull
                request, CI and review comments. Conflicts with the base branch are computed without touching your folder.
              </p>
              <p>
                <strong>Create PR</strong>, <strong>Fix CI</strong>, <strong>Resolve conflicts</strong> and{" "}
                <strong>Send comments</strong> each send the agent a prompt you can edit first. Push and merge always ask for
                confirmation. When the pull request is merged, the session is archived and a clean worktree is removed; the
                branch stays.
              </p>
              <p>
                <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>N</Kbd> starts a session from a GitHub issue or pull request, a Linear issue
                or a branch, with the prompt already written and the worktree on the right branch. GitHub works through the{" "}
                <Code>gh</Code> CLI and its login.
              </p>
            </Prose>
          </Section>

          <Section id="worktrees" title="Worktrees and .ladder/settings.toml">
            <Prose className="mt-5">
              <p>
                A session can run in its own git worktree, so agents working in parallel never step on each other. Describe
                how a worktree gets ready in <Code>.ladder/settings.toml</Code> at the root of the project. Personal
                overrides go in <Code>.ladder/settings.local.toml</Code>, which Ladder keeps out of git.
              </p>
            </Prose>
            <CodeBlock title=".ladder/settings.toml">{`[worktree]
setup   = "pnpm install --frozen-lockfile"
copy    = [".env.local"]
archive = "docker compose down"

[[run]]
name    = "dev"
command = "pnpm dev --port $LADDER_PORT"
default = true

[agents]
allowed         = ["claude-code", "codex"]
default         = "claude-code"
permissions_max = "edit"`}</CodeBlock>
            <Prose>
              <ul>
                <li>
                  <Code>[worktree]</Code>: the setup command, the files to copy from the main folder and a command to run
                  when the worktree is archived.
                </li>
                <li>
                  <Code>[[run]]</Code>: actions that become buttons in the toolbar and run in the session&apos;s terminal.
                </li>
                <li>
                  <Code>$LADDER_PORT</Code>: each folder gets its own block of ports (4100 for the first project, then 4200
                  and so on, with a separate block for every worktree), so dev servers never collide.
                </li>
                <li>
                  <Code>[agents]</Code>: which agents the project allows, which one is proposed and the highest permission
                  level.
                </li>
                <li>
                  <Code>[prompts]</Code>: replace the prompts behind Create PR, Fix CI and the other buttons with your own
                  text or a file path.
                </li>
              </ul>
            </Prose>
          </Section>

          <Section id="terminal" title="Terminal sessions">
            <Prose className="mt-5">
              <p>
                The terminal (<Kbd>⌃</Kbd> <Kbd>`</Kbd>) has tabs per project, stays alive when you switch projects and
                restarts in the same folder after a relaunch. Type <Code>@terminal</Code> in the message box to attach a
                terminal&apos;s output to your message.
              </p>
              <p>
                A new chat can also be a terminal session running <Code>claude</Code>, <Code>codex</Code> or any command.
                Ladder still tracks its state: see <Link href="/agents#terminal">how each CLI reports it</Link>.
              </p>
            </Prose>
          </Section>

          <Section id="limits" title="Accounts and plan limits">
            <Prose className="mt-5">
              <p>
                <strong>Settings → Agents</strong> shows which account each agent is signed in with and its plan. A button in
                the message box shows the usage windows of the current agent (the five-hour window, the weekly one and per
                model) and when each one resets. Ladder warns you as you get close to a limit.
              </p>
              <p>
                Session profiles save a default agent, model, effort and permission level, so a new chat starts the way you
                usually work.
              </p>
            </Prose>
          </Section>

          <Section
            id="shortcuts"
            title="Keyboard shortcuts"
            intro="These are the defaults. Every shortcut can be changed in Settings → Shortcuts, where VS Code and Cursor presets add the bindings you already know."
          >
            <div className="mt-8 grid gap-8 md:grid-cols-2">
              {SHORTCUTS.map((g) => (
                <div key={g.group}>
                  <h3 className="text-[15px] font-semibold text-ink">{g.group}</h3>
                  <dl className="mt-3 divide-y divide-hairline rounded-xl border border-hairline bg-surface">
                    {g.items.map(([keys, label]) => (
                      <div key={label} className="flex items-center justify-between gap-4 px-4 py-2.5">
                        <dt className="text-[14px] text-muted-ink">{label}</dt>
                        <dd className="flex flex-none gap-1">
                          {keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </Section>

          <Section id="help" title="Troubleshooting">
            <Prose className="mt-5">
              <h3>An agent says it is signed out</h3>
              <p>
                Open <strong>Settings → Agents</strong> and sign in again. The login is the agent&apos;s own, so it can
                expire like it would in the terminal.
              </p>
              <h3>Codex doesn&apos;t show up</h3>
              <p>
                Ladder uses the Codex you already have installed: the CLI in your <Code>PATH</Code>, the Codex app or the
                one bundled with the Cursor and VS Code extensions. Install one of them and reopen the new chat menu.
              </p>
              <h3>An ACP agent won&apos;t install</h3>
              <p>
                Ladder refuses a download whose checksum, host or signature doesn&apos;t match what it expects. Check that
                you are on the latest version of Ladder, or add the agent with a command you write yourself.
              </p>
              <h3>Something else</h3>
              <p>
                Write to <a href={`mailto:${SITE.email}`}>{SITE.email}</a>.
              </p>
            </Prose>
          </Section>
        </div>
      </div>
    </PageShell>
  )
}
