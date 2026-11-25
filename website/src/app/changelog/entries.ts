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
