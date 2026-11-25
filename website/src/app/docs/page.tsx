import type { Metadata } from "next"
import Link from "next/link"
import { Code, CodeBlock, Kbd, PageHeader, PageShell, Prose, Section } from "@/components/page"
import { DOWNLOADS, SITE } from "@/lib/site"
import { DownloadLink } from "@/components/download-link"

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How to use Ladder on macOS: projects and sessions, the Waiting view, reviewing changes, branches and merge, the built-in browser, worktrees and .ladder/settings.toml, agents and accounts, plan limits, themes and settings, and every keyboard shortcut.",
  alternates: { canonical: "/docs" },
  openGraph: { url: "/docs" },
}

const TOC = [
  { id: "start", label: "Getting started" },
  { id: "sessions", label: "Sessions and Waiting" },
  { id: "review", label: "Reviewing changes" },
  { id: "merge", label: "Branches and merge" },
  { id: "browser", label: "Built-in browser" },
  { id: "worktrees", label: "Worktrees and settings" },
  { id: "terminal", label: "Terminal sessions" },
  { id: "agents", label: "Agents, accounts and profiles" },
  { id: "limits", label: "Plan limits" },
  { id: "settings", label: "Look, language and settings" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "help", label: "Troubleshooting" },
] as const

// Defaults from the registry (app/desktop/src/shared/shortcuts.ts). ⌘⇧P works in every preset, "ladder" included
const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "Navigation",
    items: [
      [["⌘", "K"], "Search Ladder: sessions, projects, actions and conversation text"],
      [["⌘", "⇧", "P"], "Search Ladder from anywhere, also with the terminal focused"],
      [["⌘", "P"], "Open a file by name, also as path:line"],
      [["⌘", "B"], "Show or hide the sidebar"],
      [["⌘", "["], "Back"],
      [["⌘", "]"], "Forward"],
      [["⌘", "1…9"], "Go to project 1 to 9"],
    ],
  },
  {
    group: "Sessions and tabs",
    items: [
      [["⌘", "N"], "New chat"],
      [["⌘", "⇧", "N"], "New session from an issue, a pull request or a branch"],
      [["⌘", "\\"], "Open a session side by side"],
      [["⌘", "⇧", "A"], "Go to the next session waiting for you"],
      [["⌘", "."], "Stop the running session"],
      [["⌘", "W"], "Close tab"],
      [["⌘", "⌥", "←/→"], "Focus the column on the left or right"],
      [["⌘", "⌥", "⇧", "←/→"], "Move tab left or right"],
    ],
  },
  {
    group: "Panels",
    items: [
      [["⌘", "⌥", "1"], "Changes"],
      [["⌘", "⌥", "2"], "Files"],
      [["⌘", "⌥", "3"], "History"],
      [["⌘", "⌥", "4"], "Branches and merge"],
      [["⌘", "⌥", "B"], "Show or hide the right panel"],
      [["⌃", "`"], "Show or hide the terminal"],
      [["⌘", "K"], "Clear the terminal, when it has focus"],
    ],
  },
  {
    group: "Editor, message box and app",
    items: [
      [["⌘", "S"], "Save file"],
      [["⇧", "Tab"], "Change permission level"],
      [["Esc"], "Stop the reply from the message box"],
      [["⌘", ","], "Open Settings"],
      [["⌘", "⇧", "W"], "Close window"],
    ],
  },
  {
    group: "Added by the VS Code and Cursor presets",
    items: [
      [["⌃", "Tab"], "Next tab"],
      [["⌃", "⇧", "Tab"], "Previous tab"],
      [["⌘", "⇧", "T"], "Reopen closed tab"],
      [["⌘", "⇧", "F"], "Search in project"],
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
                Ladder runs on <strong>macOS</strong>, on Apple Silicon and Intel Macs. It is in early preview:{" "}
                <DownloadLink>download the latest version</DownloadLink> (the link picks the right build for your Mac,
                or choose <a href={DOWNLOADS.arm64}>Apple Silicon</a> or <a href={DOWNLOADS.x64}>Intel</a>), open the
                disk image and drag Ladder into Applications.
              </p>
              <ol>
                <li>
                  Open Ladder and add a project by choosing its folder. Any git repository works, and you can add as many
                  as you like.
                </li>
                <li>
                  Connect your agents in <strong>Settings → Subscriptions</strong> and <strong>Settings → Agents</strong>.
                  Claude Code and Codex sign in with their own flow; agents that speak ACP install from the catalog. See <Link href="/agents">supported agents</Link>.
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
                  <strong>Do Not Disturb for 1 hour</strong> pauses every banner. Turn it on from the Ladder menu,{" "}
                  <Kbd>⌘</Kbd> <Kbd>K</Kbd> or Settings.
                </li>
              </ul>
              <h3>Sub-agents</h3>
              <p>
                When an agent starts sub-agents, a chip above the message box shows how many are running. It opens a list
                with the state, duration, model, tokens and tools of each one, or a graph from left to right that shows who
                started whom. A row in the chat opens the detail of each sub-agent, and Ladder tells you when they finish.
              </p>
              <h3>Organizing sessions</h3>
              <ul>
                <li>
                  Group sessions inside a project and sort projects into sections from the sidebar menu, or drag them
                  around. <Kbd>⌘</Kbd> <Kbd>1…9</Kbd> switches project.
                </li>
                <li>
                  <Kbd>⌘</Kbd> <Kbd>\</Kbd> opens a second session in a column next to the first. Tabs can be moved and a
                  closed tab reopened.
                </li>
                <li>
                  <strong>All sessions</strong> lists the ones that are not in the sidebar, with search by title or branch,
                  filters by agent and branch, and bulk archive. Live, unread and draft sessions stay in the sidebar.
                </li>
                <li>
                  The session menu has <strong>Regenerate title</strong> and <strong>Restart agent</strong> for an agent that got stuck. A
                  setting in <strong>Data and system</strong> archives idle sessions after a while; their conversations are
                  kept.
                </li>
              </ul>
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
                The session header shows the state of the branch (commits ahead and behind, uncommitted changes). In a
                session on the main checkout, click it to switch branch: Ladder offers to bring your changes along or set
                them aside with a stash, and it won&apos;t switch while an agent is working in that folder. There the same
                chip also creates a new branch from the current commit; in a worktree session it opens the merge panel.
              </p>
              <p>
                The panel also draws a <strong>branch map</strong>: your main checkout and every worktree with its
                branches, which ones are in progress, ready to merge or already merged, and the history as a graph.
              </p>
              <p>
                A model from your own provider writes the commit message and the pull request title and description when
                you ask, and names the branch when a session is created. You can edit the result, and a single project can
                turn it off.
              </p>
              <p>
                <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>N</Kbd> starts a session from a GitHub issue or pull request, a Linear issue
                or a branch, with the prompt already written and the worktree on the right branch. GitHub works through the{" "}
                <Code>gh</Code> CLI and its login.
              </p>
            </Prose>
          </Section>

          <Section id="browser" title="Built-in browser">
            <Prose className="mt-5">
              <p>
                Open a page in a column next to your chat from <Kbd>⌘</Kbd> <Kbd>K</Kbd>: a local development server, the
                docs you are reading or a preview. It has an address bar, back, forward, reload and developer tools, and you
                can send a screenshot or a selection of the page to the chat. Cookies stay in the project.
              </p>
              <h3>A browser for the agent</h3>
              <p>
                In <strong>Settings → New sessions</strong> you can let the agent use a browser of its own. It is a separate
                browser, without your cookies or logins, and it only reaches <Code>localhost</Code> unless you allow another
                site. The agent can open and read pages and, with your approval according to the session&apos;s permission
                level, click and type. Stop it from its tab or with Stop in the chat, and resume it from the same tab or
                from <Kbd>⌘</Kbd> <Kbd>K</Kbd>. A project can override the setting.
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
                  Ignored files such as <Code>.env</Code> can be listed in a <Code>.worktreeinclude</Code> file at the root
                  (same syntax as <Code>.gitignore</Code>); they are copied into each new worktree.{" "}
                  <Code>node_modules</Code> never is.
                </li>
                <li>
                  <Code>[agents]</Code>: which agents the project allows, which one is proposed and the highest permission
                  level.
                </li>
                <li>
                  <Code>[prompts]</Code>: replace the prompts behind Create PR, Fix CI and the other buttons with your own
                  text or a file path.
                </li>
                <li>
                  Where worktrees live, the branch prefix, whether the first message waits for the setup script and your own
                  background services are in <strong>Settings → Workspace</strong>.
                </li>
              </ul>
            </Prose>
          </Section>

          <Section id="terminal" title="Terminal sessions">
            <Prose className="mt-5">
              <p>
                The terminal (<Kbd>⌃</Kbd> <Kbd>`</Kbd>) has tabs per project, stays alive when you switch projects and
                restarts in the same folder after a relaunch. <Kbd>⌘</Kbd> <Kbd>K</Kbd> clears it while it has focus (use{" "}
                <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>P</Kbd> to open the command palette from there). Type <Code>@terminal</Code> in the message box to attach a
                terminal&apos;s output to your message.
              </p>
              <p>
                A new chat can also be a terminal session running <Code>claude</Code>, <Code>codex</Code> or any command.
                Ladder still tracks its state: see <Link href="/agents#terminal">how each CLI reports it</Link>.
              </p>
            </Prose>
          </Section>

          <Section id="agents" title="Agents, accounts and profiles">
            <Prose className="mt-5">
              <p>
                <strong>Settings → Subscriptions</strong> signs you in to Claude, Codex and GitHub from inside Ladder: it
                opens your browser and you come back connected. Claude Code and Codex can have more than one account, for
                example Work and Personal, each with its own plan and usage. Ladder never reads or stores the agents&apos;
                credentials.
              </p>
              <p>
                <strong>Settings → Agents</strong> has the catalog of ACP agents: the ones already on your Mac, a curated
                list and the public ACP registry. When Ladder downloads an agent, it first shows the version, the host, the
                size and the full SHA-256, verifies the checksum and, where the vendor signs its binaries, the Apple
                Developer ID, and it never updates the agent on its own. See <Link href="/agents">supported agents</Link>.
                Any other agent works with the command that starts it.
              </p>
              <p>
                In <strong>Settings → Subscriptions</strong>, <strong>Other agents</strong> lists the agents that sign in
                from their own command line: Ladder shows whether each one is signed in and opens its sign-in in a terminal.
              </p>
              <h3>Defaults and session profiles</h3>
              <p>
                <strong>Settings → New sessions</strong> sets what a new chat starts with (agent, model, effort and
                permission level), with values of its own for each project. A session profile saves a combination of agent,
                account, model, effort and permissions: pick it in the new chat or from <Kbd>⌘</Kbd> <Kbd>K</Kbd>, or save
                the current session as a profile from its menu.
              </p>
            </Prose>
          </Section>

          <Section id="limits" title="Plan limits">
            <Prose className="mt-5">
              <p>
                A button in the message box shows the usage windows of the current agent and account (the five-hour window,
                the weekly one and per model) and when each one resets. Ladder warns you as you get close to a limit, and it
                can keep the Mac awake while an agent works.
              </p>
            </Prose>
          </Section>

          <Section id="settings" title="Look, language and settings">
            <Prose className="mt-5">
              <ul>
                <li>
                  <strong>Themes:</strong> fifteen light and dark themes around the Circuit identity. Change one from
                  Settings → Appearance or from <Kbd>⌘</Kbd> <Kbd>K</Kbd>.
                </li>
                <li>
                  <strong>Language:</strong> English by default, with an Italian translation.
                </li>
                <li>
                  <strong>Reading:</strong> chat font, text size and width, code font, editor size and the density of the
                  sidebar.
                </li>
                <li>
                  <strong>Message box:</strong> choose whether Enter or a modifier and Enter sends, and what a message sent
                  while the agent works does: go into the turn or wait in the queue.
                </li>
                <li>
                  <strong>Notifications:</strong> a sound for approvals and questions, a test notification and Do not
                  disturb.
                </li>
                <li>
                  <strong>Shortcuts:</strong> every shortcut can be changed, searched by name or key, with the VS Code and
                  Cursor presets as a starting point.
                </li>
                <li>
                  <strong>Integrations:</strong> a Linear API key, stored encrypted in the macOS Keychain, to start sessions
                  from Linear issues.
                </li>
                <li>
                  <strong>Data and system:</strong> the data folder, backups and export of the database, opening Ladder at
                  login and keeping the Mac awake while an agent works.
                </li>
                <li>
                  <strong>Updates:</strong> Ladder checks every few hours and tells you when an update is ready. It installs
                  when you quit, or when you restart from the notice.
                </li>
              </ul>
            </Prose>
          </Section>

          <Section
            id="shortcuts"
            title="Keyboard shortcuts"
            intro="These are the defaults. Every shortcut can be changed in Settings → Shortcuts, where the VS Code and Cursor presets add the bindings you already know."
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
                Open <strong>Settings → Subscriptions</strong> (ACP agents are under <strong>Other agents</strong>) and
                sign in again. The login is the agent&apos;s own, so it can
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
