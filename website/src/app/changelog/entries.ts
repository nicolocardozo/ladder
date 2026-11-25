// Changelog entries, newest first. Used by the page and by the RSS feed.
// Entries before the first public release (v0.1.0) are development milestones, with their commit dates.
export type Entry = {
  /** ISO date (yyyy-mm-dd), also used as the anchor */
  date: string
  title: string
  summary: string
  items: string[]
}

export const ENTRIES: Entry[] = [
  {
    date: "2026-11-26",
    title: "Agents that work together, executable plans and a ladder command",
    summary: "Ladder 0.1.4: hand work from one agent to another, run plans task by task, drive Ladder from the terminal, and one more agent.",
    items: [
      "Hand a session over to another agent with /handoff: the current agent writes a summary and the work continues in a linked session. Hand it back to resume the first one.",
      "Ask another agent for advice with /advisor, or two to four with /committee. They read the work read-only and answer in a card you can send to your agent.",
      "Open a plan as a document, comment on its lines and implement it with any agent.",
      "Agents can delegate a task to an agent from another provider. The delegate runs as a child session in the agent map, and you can stop it, or after a restart resume or dismiss it. Preferred delegates go in [[agents.delegates]] in .ladder/settings.toml.",
      "When an agent reaches its plan limit, a card proposes another agent to continue with. A per-project setting can switch automatically.",
      "Optional cross-review: after a turn with changes, another agent reads the diff and a serious verdict goes back to the first agent.",
      "Executable plans: an agent proposes a plan, you edit and approve it, and each task runs in its own session in dependency order. Writing tasks run in parallel in separate worktrees and are merged back. Stop points, review loops, retry, reassign, skip, recovery after a restart and saved templates.",
      "The ladder command (projects, ls, new, send, wait, attach, stop) drives sessions from the terminal, and agents can start and follow sessions the same way, within their own permissions. Install it from Settings → Data and system. Sessions started from the terminal or by another agent show where they came from.",
      "The Claude agent is now called Claude in the app. It still runs the Claude Code CLI.",
      "Grok Build joins the curated agents, with its own sign-in.",
      "The sub-agent map opens as a list, with a graph from left to right when you want to see who started whom. The group of finished agents opens by itself when all of them are done.",
      "Cmd+K clears the terminal when it has focus, and Cmd+Shift+P opens the command palette from anywhere.",
      "A notification for a waiting request now arrives unless that very session is on screen, even if another one in the same project is open.",
      "Claude and Codex keep answering in the language you write in, also when a turn starts from a background task.",
      "The bottom of the sidebar shows your linked subscriptions, and an expired sign-in turns red.",
      "Ladder is open source under the Apache License 2.0, and the app includes the licenses of the third-party software it ships with.",
    ],
  },
  {
    date: "2026-11-24",
    title: "Intel Macs, updates on their own and a branch map",
    summary: "Ladder 0.1.1 to 0.1.3: builds for every Mac that keep themselves up to date.",
    items: [
      "Builds for Intel Macs as well as Apple Silicon.",
      "Installed copies update on their own, with a notice when an update is ready.",
      "A branch map: switch branches from the top bar, and see the main checkout and the history with the same graphics.",
      "The built-in browser opens in a column next to the chat.",
      "Restart agent, for when an agent gets stuck.",
      "Shortcut labels follow your keyboard layout.",
      "Two new dark themes, Carbon and Fern.",
    ],
  },
  {
    date: "2026-11-23",
    title: "Merge with one main action, previews and calmer limits",
    summary: "The merge panel now leads with a single next step, and files you'd normally open elsewhere open in Ladder.",
    items: [
      "The session header shows the branch's git state: ahead, behind, uncommitted changes.",
      "The merge panel has one main action at a time; push and merge always ask for confirmation.",
      "Images, PDFs, audio and video open in a preview inside Ladder.",
      "No cap on active sessions: Ladder warns you as you get close to your plan limits instead.",
    ],
  },
  {
    date: "2026-11-22",
    title: "Accounts, the ACP catalog and ready-to-use worktrees",
    summary: "A big batch of the work that makes Ladder feel like home after a week of daily use.",
    items: [
      "Sign in to Claude, Codex and GitHub from inside Ladder, with more than one account per agent.",
      "A catalog of ACP agents with verified installs: checksum, download host and, where available, the Apple Developer ID.",
      "A built-in browser in tabs, and a browser the agent can drive.",
      "Commit messages, pull request titles and descriptions written by a model.",
      "Session profiles with default model, effort and permission level.",
      "A sub-agent map, with rows in the chat and a detail view.",
      "Project sections, side-by-side sessions and drag and drop in the sidebar.",
      "Customisable shortcuts, with VS Code and Cursor presets.",
      "Readability, external editor, data and system settings.",
      "Worktrees that set themselves up, and dev servers with a port of their own.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Signed builds and plan limits",
    summary: "Ladder is now built, signed and notarized for distribution.",
    items: [
      "Signed and notarized macOS build for Apple Silicon.",
      "Plan limits with refresh, shown right from the message box.",
      "Redesigned approval cards.",
    ],
  },
  {
    date: "2026-11-08",
    title: "Codex, ACP agents and many projects at once",
    summary: "Ladder stops being a Claude Code client and becomes a place for every agent.",
    items: [
      "Codex in chat through its App Server, with its own approval decisions and resumable threads.",
      "Any agent that speaks the Agent Client Protocol, from the official registry or a command of your own.",
      "The Waiting view collects approvals and questions from every project.",
      "macOS notifications, a Dock badge and Do not disturb.",
      "Merge panel with pull request, CI, review comments and conflicts.",
      "Ask a second agent to review the changes of the first.",
      "English by default, with an Italian translation.",
    ],
  },
  {
    date: "2026-11-07",
    title: "The first version",
    summary: "Sessions, chat, diffs and a terminal, in Ladder's own Circuit look.",
    items: [
      "Real projects and Claude Code sessions with your own login, with their state in the sidebar.",
      "Chat with streaming, file references, per-turn changes and checkpoints.",
      "Approvals and questions with shortcuts, an editable message queue and four permission levels.",
      "Inspector with changes, files and history; an integrated terminal.",
      "The Circuit identity and twelve light and dark themes.",
    ],
  },
]

export const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
