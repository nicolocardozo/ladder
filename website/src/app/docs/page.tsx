import type { Metadata } from "next"
import Link from "next/link"
import { Code, CodeBlock, Kbd, PageHeader, PageShell, Prose, Section } from "@/components/page"
import { DOWNLOADS, SITE } from "@/lib/site"
import { DownloadLink } from "@/components/download-link"

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How to use Ladder: sessions, reviewing changes, worktrees, terminals, handing work between agents, executable plans, plan limits and shortcuts.",
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
  { id: "handoff", label: "Handoff, advice and delegation" },
  { id: "plans", label: "Executable plans" },
  { id: "cli", label: "The ladder command" },
  { id: "together", label: "Getting agents to work together" },
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
                  Claude and Codex sign in with their own flow; agents that speak ACP install from the catalog. See <Link href="/agents">supported agents</Link>.
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
                  around. Groups, and the sessions inside a group, can be dragged into the order you want: Ladder keeps it. <Kbd>⌘</Kbd> <Kbd>1…9</Kbd> switches project.
                </li>
                <li>
                  A green mark next to a project&apos;s name means a server is listening on localhost from its folder or one
                  of its worktrees, whoever started it: you, an agent or a run button. Hover it to see the ports, open one in
                  the built-in browser or stop it; the project menu has <strong>Stop localhost</strong> too.
                </li>
                <li>
                  A Claude or Codex session whose agent left a command running after its turn, such as a test suite or a watcher, says how
                  many are still going, so an idle session that promised to come back is not a mystery.
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
permissions_max = "edit"
auto_switch     = "codex"
cross_review    = "codex"

[[agents.delegates]]
name       = "reviewer"
agent      = "codex"
model      = "gpt-6-luna"
effort     = "high"
permission = "plan"
note       = "Reviews and second opinions"`}</CodeBlock>
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
                  level. Agents are written as <Code>claude-code</Code>, <Code>codex</Code> or an ACP id such as{" "}
                  <Code>gemini</Code>; <Code>claude-code</Code> is still the id of the Claude agent.
                </li>
                <li>
                  <Code>auto_switch</Code> and <Code>cross_review</Code>, also in <Code>[agents]</Code>: an agent to
                  continue with when the plan limit is reached, and an agent that reviews the changes after each turn (see{" "}
                  <a href="#handoff">Handoff, advice and delegation</a>). Both are off unless you set them, and an empty
                  string in your personal file turns off the project&apos;s value. With a project selected, Settings → New
                  sessions sets them for you in <Code>.ladder/settings.local.toml</Code>.
                </li>
                <li>
                  <Code>[[agents.delegates]]</Code>: the agents you prefer to delegate to. One block per delegate, with a{" "}
                  <Code>name</Code> (up to 40 characters) and an <Code>agent</Code>, both required, and optionally{" "}
                  <Code>model</Code>, <Code>effort</Code> (<Code>low</Code>, <Code>medium</Code>, <Code>high</Code>,{" "}
                  <Code>xhigh</Code> or <Code>max</Code>), <Code>permission</Code> (<Code>plan</Code> if you leave it out,
                  and never above <Code>permissions_max</Code>) and a short <Code>note</Code> of up to 300 characters. A
                  delegate whose agent is not in <Code>allowed</Code> is ignored with an error, and a personal block with the
                  same name replaces the project&apos;s. Settings → New sessions lists them, read-only.
                </li>
                <li>
                  <Code>[prompts]</Code>: replace the prompts behind Create PR, Fix CI and the other buttons with your own
                  text or a file path.
                </li>
                <li>
                  Where worktrees live, the branch prefix, whether the first message waits for the setup script and your own
                  background services are in <strong>Settings → Workspace</strong>.
                </li>
                <li>
                  Ladder removes a worktree by itself once its branch is merged. Archiving a session without merging leaves
                  the folder on disk: <strong>Settings → Workspace → Worktrees on disk</strong> lists them with their size and
                  what they still hold (uncommitted files, commits only on their branch), and removes the ones nothing needs.
                  The branch always stays; files git ignores, like <Code>.env.local</Code> or a local database, go with the
                  folder.
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
                Shell code blocks in the chat have a <strong>Run</strong> button: the command runs in a terminal of the
                session, in its folder (the worktree, when it has one), so it never lands in the wrong checkout.
              </p>
              <p>
                Agents can do the same with <Code>run_in_terminal</Code>, <Code>read_terminal</Code> and{" "}
                <Code>stop_terminal</Code>: builds, test suites, dev servers and release scripts run in a terminal you can
                watch and answer prompts in, instead of a command for you to copy. The session&apos;s permission level
                decides: Plan can&apos;t run anything, Ask and Edit ask you with a card, Full access runs.
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
                opens your browser and you come back connected. Claude and Codex can have more than one account, for
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

          <Section id="handoff" title="Handoff, advice and delegation">
            <Prose className="mt-5">
              <p>
                Agents can work with each other without you copying anything around. Chat sessions get a small Ladder server
                with the tools <Code>list_agents</Code>, <Code>handoff</Code> and <Code>delegate</Code>, plus the plan and session
                tools; <Code>report_result</Code> is there only when someone waits for the result: plan tasks, delegated tasks
                and sessions reached by a handoff. Sessions started from the terminal or by another agent can&apos;t hand off,
                plan tasks can only report, terminal sessions don&apos;t have the server, and ACP agents get it only if they
                support MCP over HTTP. Only agents that are available and allowed by the project can be chosen.
              </p>
              <h3>Handing a session to another agent</h3>
              <p>
                Choose <strong>Hand off to…</strong> in the session menu, or type <Code>/handoff</Code> (or{" "}
                <Code>/handoff codex</Code>, with an optional note) in the message box. It works on a chat that is idle. The
                current agent writes a summary of the goal, the decisions and what is left; then the work continues in a
                linked session with the other agent, in the same folder and worktree. The new session shows where it came
                from. Handing it back to the original agent resumes the first session, when it is idle, instead of opening a third one. An
                agent can also ask for a handoff itself, when you tell it to switch, in a session you started. If a handoff is interrupted, for
                example by a restart, its card offers <strong>Resume handoff</strong> or <strong>Reassign…</strong>.
              </p>
              <h3>Advice from other agents</h3>
              <p>
                <Code>/advisor</Code> (or <strong>Ask for advice…</strong> in the session menu) asks another agent to read the
                work and the diff, with an optional question, and give an opinion. <Code>/committee</Code> asks two to four
                different agents, each on their own. They work read-only, so nothing is edited, and their answers appear as a
                card in the chat, with the agent&apos;s session one click away. <strong>Send to…</strong> forwards the advice to
                the agent you are talking to, with a note if you want.
              </p>
              <h3>Plans as documents</h3>
              <p>
                When a session in Plan permission ends a turn, <strong>Open plan</strong> shows the answer as a document.
                Click a line to comment on it; the comments travel with the plan. <strong>Implement with…</strong> sends it to
                the same agent or another one, with the permission level you choose. For plans that run task by task, see{" "}
                <a href="#plans">Executable plans</a>.
              </p>
              <h3>Delegation</h3>
              <p>
                With <Code>delegate</Code> an agent gives a self-contained task to an agent from another provider, for example
                a review from Codex while Claude keeps the lead, and gets the result back inside its turn. The delegate runs
                as a child session that you follow in the agent map; it can be read-only or work in a worktree of its own. You
                can stop it, and after a restart an interrupted delegation shows a card to <strong>Resume delegation</strong>{" "}
                or dismiss it. A delegated task goes back through <Code>report_result</Code>.
              </p>
              <p>
                A delegate starts at the lowest of three levels: the delegating session&apos;s, the one in its{" "}
                <Code>[[agents.delegates]]</Code> block and the project&apos;s maximum. A delegate that writes files can then be
                moved between Ask, Edit and Full access from its own message box, within the project&apos;s maximum; a
                read-only delegate stays in Plan.
              </p>
              <p>
                In <Code>.ladder/settings.toml</Code>, <Code>[[agents.delegates]]</Code> lists the delegates you prefer, each
                with its agent, model, effort, permission and a note on what it is for. The agent still decides when and to
                whom; Ladder only tells it who is there.
              </p>
              <h3>Cross-review</h3>
              <p>
                Set <Code>cross_review</Code> to an agent in <strong>Settings → New sessions</strong> and, after each completed turn
                that changed files in a session you talk to, that agent reads the diff read-only and posts a verdict: no issues, minor or serious. A
                serious verdict is sent back to the session&apos;s agent by itself, once per message of yours. It is off by
                default, saved in <Code>.ladder/settings.local.toml</Code>, and skipped when the reviewer is the session&apos;s own
                agent.
              </p>
            </Prose>
          </Section>

          <Section id="plans" title="Executable plans">
            <Prose className="mt-5">
              <p>
                For work that is bigger than one session, type <Code>/plan</Code> and the goal in the message box, or ask
                the agent for an executable plan in your own words. It proposes it with <Code>propose_plan</Code> and the
                plan appears in the chat as a card, <strong>Plan to review</strong>. This is different from the agent&apos;s
                own plan mode: Ladder runs the plan, task by task, each in its own session.{" "}
                <strong>Nothing runs until you approve it.</strong> You can also start from a saved template with{" "}
                <strong>Use plan template…</strong> in <Kbd>⌘</Kbd> <Kbd>K</Kbd>.
              </p>
              <h3>Review and edit</h3>
              <p>
                The card is editable: the goal, the constraints every task must respect, and for each task its instruction,
                the agent, model and effort that will run it, its permission level (never above the project&apos;s maximum), what
                it runs after, and a &ldquo;done when&rdquo; criterion. A plan can have up to 20 tasks. A review task can send
                blocking issues back to an earlier task, up to five rounds, and then asks you. Mark a task with{" "}
                <strong>Pause after</strong> to make it a stop point. Choose where the tasks write, in a new worktree (the
                default in a git project) or in the main checkout, then <strong>Approve and run</strong>, or{" "}
                <strong>Reject…</strong> with a message for the agent.
              </p>
              <h3>Running</h3>
              <ul>
                <li>
                  Each task runs in its own session, in dependency order. Tasks that don&apos;t depend on each other start
                  together.
                </li>
                <li>
                  One task at a time writes in the plan folder. Independent tasks that write run in parallel in separate
                  worktrees, and their changes are merged back into the plan folder when they finish.
                </li>
                <li>
                  The plan pauses when a task fails or is interrupted, when a review still finds blocking issues, at a stop
                  point, or when the agent asks to change the plan (you accept or reject its changes). Then you choose{" "}
                  <strong>Continue</strong>, <strong>Retry</strong>, <strong>Reassign…</strong> to another agent (from the
                  partial work, or from the start of the task with the partial work saved as a patch),{" "}
                  <strong>Skip task</strong> or <strong>Stop plan</strong>. Stopping leaves the sessions open.
                </li>
                <li>
                  If Ladder closes in the middle of a plan, it comes back paused on the interrupted task, which you can retry, reassign or skip.
                </li>
                <li>
                  <strong>Save as template</strong> on the card keeps the tasks, executors, permissions and stop points; the
                  goal is asked again each time.
                </li>
              </ul>
              <h3>Agents starting sessions</h3>
              <p>
                Agents can also start and follow other sessions of the project with <Code>ladder_list_sessions</Code>,{" "}
                <Code>ladder_start_session</Code>, <Code>ladder_send</Code> and <Code>ladder_wait</Code>. A session never gets
                more permission than the one that started it or than the project&apos;s maximum; from an agent at the Ask level,
                each start waits for your approval. Sessions started by agents nest up to two levels deep, with at most five
                working at once and twenty starts an hour. In a git project, a session that writes gets its own worktree by
                default.
              </p>
              <p>
                Agents also see the sessions you started. <Code>ladder_list_sessions</Code> and{" "}
                <Code>ladder_read_session</Code> show what each one is doing and which files it changed that they changed too;{" "}
                <Code>ladder_wait</Code> waits for any of them to finish. A message to a session the agent did not start goes
                through only after you approve it with a card, even in Full access; in Plan it can&apos;t send one. The session header shows{" "}
                <strong>Waiting for…</strong> while an agent waits for another session, and <strong>Same files as…</strong>{" "}
                when two sessions changed the same files.
              </p>
              <p>
                A session started by an agent, or from the terminal, says so in its header, with a link to the agent session
                that started it when there is one.
              </p>
            </Prose>
          </Section>

          <Section id="cli" title="The ladder command">
            <Prose className="mt-5">
              <p>
                <Code>ladder</Code> starts, messages and follows Ladder sessions from a terminal, so you can script them or
                call them from another tool. It talks to the running app, which has to be open, over a local socket that only
                your user can use.
              </p>
              <h3>Install it</h3>
              <p>
                Open <strong>Settings → Data and system → Command line</strong> and press <strong>Install</strong>. Ladder
                links <Code>~/.local/bin/ladder</Code> to the command inside the app and never overwrites a file that is not its
                own link. If that folder isn&apos;t in your <Code>PATH</Code>, the same panel shows the line to add to your shell
                profile. <strong>Uninstall</strong> removes the link. The panel also says whether Ladder is listening.
              </p>
            </Prose>
            <CodeBlock title="Terminal">{`ladder ls
ladder new . "Fix the failing test" --agent codex --wait
ladder wait <id>
ladder attach <id>`}</CodeBlock>
            <Prose>
              <h3>Commands</h3>
              <ul>
                <li>
                  <Code>ladder projects</Code>: the projects open in Ladder.
                </li>
                <li>
                  <Code>ladder ls [--project &lt;name|path&gt;]</Code>: chat sessions that are not archived, with agent, state and
                  where each one started from.
                </li>
                <li>
                  <Code>ladder new &lt;project&gt; &quot;&lt;prompt&gt;&quot;</Code>: start a chat session. The project is a
                  name, a folder, or <Code>.</Code> for the project that contains the current folder. Options:{" "}
                  <Code>--agent</Code>, <Code>--model</Code>, <Code>--effort</Code>, <Code>--permission</Code> (
                  <Code>plan</Code>, <Code>ask</Code>, <Code>edit</Code> or <Code>full</Code>), <Code>--worktree</Code> and{" "}
                  <Code>--wait</Code>. It prints the session id.
                </li>
                <li>
                  <Code>ladder send &lt;session&gt; &quot;&lt;message&gt;&quot;</Code>: message a session; if it is busy the
                  message waits for the end of the turn. <Code>--wait</Code> waits for the answer.
                </li>
                <li>
                  <Code>ladder wait &lt;session&gt;</Code>: wait until the work is done and print the final answer. The exit
                  code is 0 when it completed, 1 on error, 2 if interrupted, 3 if it needs you in Ladder (an approval or a
                  question) and 4 on timeout. <Code>--timeout</Code> takes seconds, 600 by default and up to 3600.
                </li>
                <li>
                  <Code>ladder attach &lt;session&gt;</Code>: follow a session live. Ctrl-C detaches and the session keeps
                  going.
                </li>
                <li>
                  <Code>ladder stop &lt;session&gt;</Code>: stop the current turn.
                </li>
              </ul>
              <p>
                A session is an id or any unique start of one, and the prompt can be <Code>-</Code> to read it from standard
                input. <Code>--json</Code> (on projects, ls, new, send and wait) gives machine-readable output. Without <Code>--agent</Code>, <Code>new</Code> uses
                the project&apos;s default agent, then the last one used there. The project&apos;s maximum permission always
                applies. The command only starts chat sessions, with no attachments, and anything you run as your user, such
                as an agent with a shell, can use it like you do.
              </p>
            </Prose>
          </Section>

          <Section id="together" title="Getting agents to work together">
            <Prose className="mt-5">
              <p>
                Each agent has its strengths, and none of them sees its own mistakes as well as another one does. A few
                habits that make the most of having several agents in the same window:
              </p>
              <ul>
                <li>
                  <strong>A second opinion before you merge.</strong> When a session has finished a change, type{" "}
                  <Code>/advisor codex is this safe to merge?</Code>. Codex reads the diff without touching it, and{" "}
                  <strong>Send to…</strong> passes what it found to the agent that wrote the code.
                </li>
                <li>
                  <strong>A committee for decisions that are hard to undo.</strong> Before choosing a library, a schema or an
                  architecture, <Code>/committee</Code> asks two to four agents on their own, so you compare independent
                  answers instead of one agent agreeing with itself.
                </li>
                <li>
                  <strong>A handoff when an agent is stuck or out of quota.</strong> <Code>/handoff codex</Code> moves the
                  work with a summary of the goal, the decisions and what is left, in the same folder. When the first agent
                  is back, hand it back and the original session resumes.
                </li>
                <li>
                  <strong>A plan for work bigger than one session.</strong> Type <Code>/plan</Code> and the goal, for
                  example <Code>/plan add CSV export to billing</Code>. Ask for a review task run by a different agent than
                  the one that implements, put <strong>Pause after</strong> on risky tasks such as migrations, and save
                  plans you repeat (a release, a dependency upgrade) as templates.
                </li>
                <li>
                  <strong>Delegation inside a turn.</strong> Tell the agent what to hand out, for example &ldquo;write the
                  feature and delegate the tests to Codex&rdquo;. List the delegates you like in{" "}
                  <Code>[[agents.delegates]]</Code>, with a note on what each is good at, and the agent will pick from them.
                </li>
                <li>
                  <strong>Cross-review on projects that matter.</strong> With <Code>cross_review</Code> set, every completed
                  turn that changes files in a session you talk to gets a read-only review from another agent, and serious
                  issues go back to the session by themselves.
                </li>
                <li>
                  <strong>Agents from your scripts.</strong> <Code>ladder new . &quot;Update the changelog&quot; --wait</Code>{" "}
                  starts a session and prints the answer, and its exit code says whether it completed or needs you.
                </li>
              </ul>
            </Prose>
          </Section>

          <Section id="limits" title="Plan limits">
            <Prose className="mt-5">
              <p>
                A button in the message box shows the usage windows of the current agent and account (the five-hour window,
                the weekly one and per model) and when each one resets. Ladder warns you as you get close to a limit, and it
                can keep the Mac awake while an agent works.
              </p>
              <p>
                When an agent reaches its limit at the end of a turn, a card in the chat proposes another agent to continue
                with: the one set as <Code>auto_switch</Code>, or the first other allowed agent that is available. Press{" "}
                <strong>Continue with</strong> and the agent&apos;s name, and Ladder hands the work over, with a summary it writes itself from the
                conversation, because the agent at its limit cannot. If you set <Code>auto_switch</Code> for the project
                (<strong>Settings → New sessions</strong>, off by default), Ladder does it by itself after a short pause in
                which you can stop it; if that agent has reached its limit too, it only proposes. When the first agent is
                available again, a card offers to go back to it.
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
