# Ladder

A macOS workspace for working on several repositories at once with coding agents: Claude Code, Codex and any agent that speaks the Agent Client Protocol (ACP), in chat or in a terminal.

The agent chat sits in the middle, with files, diffs and a terminal at hand, and one view of who is waiting for you in which project. At any moment you can see what is happening in every project (who is working, with which agent and model, who needs you) and step in with one or two actions.

Website: [itsladder.dev](https://itsladder.dev)

> Ladder is an independent project. It is not affiliated with or endorsed by Anthropic, OpenAI, Google or the makers of the other agents it works with. Product names belong to their respective owners.

## History

Ladder has been in development since November 7, 2026. The first public release, v0.1.0, shipped on November 23, 2026. The commit history in this repository goes back to the first day.

## Status

Early and moving fast. Ladder is built and used every day by its author; expect rough edges and breaking changes between versions.

## Install

Download the latest build for Apple Silicon or Intel from [Releases](https://github.com/nicolocardozo/ladder-releases/releases). Builds are signed and notarized, and update themselves.

Ladder works with the agents' own sign-in and your own subscriptions:

- **Claude Code** through the official Claude Agent SDK, which runs the unmodified `claude` binary. You sign in with Anthropic's own flow; Ladder never reads, stores or forwards agent credentials.
- **Codex** through `codex app-server`. Ladder looks for the Codex already on your Mac first (the CLI on your `PATH`, the Codex app, or the one bundled with the Cursor and VS Code extensions).
- **ACP agents** from the official registry (via `npx`, `uvx` or a binary to download) or from a command you write.
- **Terminal sessions** for `claude`, `codex` or any other command, in a real PTY.

If Codex, the `gh` CLI or an ACP agent's binary is missing, Ladder can download it for you, only after a confirmation that shows the version, host, size and full SHA-256 checksum, which is verified before anything runs.

GitHub goes through the `gh` CLI and its own sign-in. Linear uses a personal API key, stored encrypted in the macOS Keychain; it is the only secret Ladder stores.

There is no Ladder server, no Ladder account and no telemetry. Ladder talks to the network only for what you use: the agents' own services, GitHub (including app updates from GitHub Releases), the ACP registry, Linear, and downloads you confirm.

## Features

**Projects and sessions**
- One project at a time, with its tabs, files, terminal and new chat; sessions show their state (running, waiting for approval, unread, error).
- Live, unread and draft sessions stay in the sidebar; the rest is in "All sessions", with search, filters, groups and bulk archive.
- ⌘1…⌘9 switch projects and ⌘W closes a tab; drafts, reading position and sessions are kept across restarts.
- No cap on active sessions: Ladder warns you as you get close to your plan limits instead.
- ⌘⇧N starts a session from a GitHub issue or PR, a Linear issue or a branch, with the prompt already written and the worktree on the right branch.

**Chat**
- Streaming, an activity summary, code blocks, clickable file references, files changed per turn (git checkpoints).
- Approvals and questions as cards with shortcuts, an editable message queue, stop, model, effort and four permission levels shared by every agent (Plan, Ask, Edit, Full access; ⇧Tab).
- `@` to mention project files, `@terminal` to attach terminal output, pasted or dropped images, `/` commands for each agent.
- Model and effort can change mid-session; a composer button shows the agent's usage windows and when they reset.
- Subagents started by the main agent (Claude Code's Agent/Task, Codex's `spawnAgent`) appear in an agent map with state, duration, model, tokens and tools.

**Waiting for you**
- "Waiting" collects requests from every project with their actions, then errors and replies to read. You approve or answer without leaving the session in front of you; edits over 40 lines are approved from the session, after reading them.
- ⌘⇧A jumps to the oldest request; ⌘[ takes you back with the cursor where it was.
- macOS notifications, a Dock badge, and a "while you were away" line when you come back to a project after more than 30 minutes.

**Files, diffs and terminal**
- Inspector: changes per turn, per session or uncommitted, unified or side by side, with line comments sent to the agent and restore with undo; a file tree with git state; a timeline of checkpoints, restores and commits.
- ⌘P opens a file by name, also as `path:line`; files open in a light editor tab (CodeMirror 6, ⌘S) or in Cursor or VS Code.
- An integrated terminal (xterm.js and node-pty, ⌃\`) whose shells survive project switches and restarts.

**Worktrees and merge**
- A worktree per session, with setup commands, files to copy and an archive command.
- Merge panel: branch state, PR, CI and review comments; conflicts with the base are computed without touching the folder. "Create PR", "Fix CI", "Resolve conflicts" and "Send comments" send the agent a prompt you can edit first.
- "Ask for a review from…": another agent reviews the changes read-only, and its comments land in the diff.

**Look and feel**
- Fifteen light and dark themes around the Circuit identity, Mona Sans and Monaspace Neon, keyboard shortcuts everywhere (customizable, with VS Code and Cursor presets).
- English by default, with an Italian translation (Settings → Appearance → Language).
- WCAG AA contrast checked by a script for every theme, no text under 12 px, states that don't rely on color alone, reduced motion respected.

## Project configuration

A project can carry `.ladder/settings.toml` (shared) and `.ladder/settings.local.toml` (personal, kept out of git through `.git/info/exclude`):

```toml
[worktree]
setup   = "pnpm install --frozen-lockfile"
copy    = [".env.local"]
archive = "docker compose down"

[[run]]
name    = "dev"
command = "pnpm dev --port $LADDER_PORT"
default = true

[agents]
allowed = ["claude-code", "codex"]
default = "claude-code"
permissions_max = "edit"

[prompts]
create_pr = ".ladder/prompts/pr.md"
fix       = ".ladder/prompts/fix.md"
```

- `[[run]]` actions become buttons in the toolbar and run in the session's terminal.
- Each folder gets a block of ports in `LADDER_PORT`: 4100 for the first project, then 4200 and so on, with a separate block for each worktree.
- Worktrees are created in `~/Developer/.ladder/worktrees/<project>/<slug>` (or `~/.ladder/worktrees` if `~/Developer` doesn't exist) on a `ladder/<slug>` branch; folder and branch prefix can be changed in Settings.
- Prompt names are `create_pr`, `fix`, `conflicts`, `comments`, `issue`, `pull_request` and `review`, as a path or as the text itself. Variables: `{{branch}}`, `{{base}}`, `{{pr}}`, `{{checks}}`, `{{conflicts}}`, `{{comments}}`, `{{ref}}`, `{{title}}`, `{{url}}` and `{{body}}`; `create_pr` also gets `{{base_arg}}`, `{{title_file}}` and `{{body_file}}` (the title and description are passed as files, never pasted into a command).

## Building from source

You need macOS, Node 24 and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` opens the Electron app. To try only the interface in a browser, at `http://localhost:5199/preview.html` with sample data:

```bash
pnpm --filter @ladder/desktop dev:web
```

If Electron doesn't start because its binary is missing, the app's `postinstall` script downloads it; otherwise:

```bash
node app/desktop/node_modules/electron/install.js
```

A local build to install:

```bash
pnpm --filter @ladder/desktop dist
```

It creates `app/desktop/dist/mac-arm64/Ladder.app`, signed only for this Mac: drag it to Applications.

The website (`pnpm --filter @ladder/website dev` or `build`) downloads two background components from the [React Bits](https://reactbits.dev) registry before it starts. They are used under React Bits' own license and are not part of this repository.

node-pty is the only native module: it uses the bundled N-API prebuild (no node-gyp), `postinstall` makes `spawn-helper` executable, and the build keeps it outside the asar.

### Repository layout

| Folder | Contents |
|---|---|
| `app/desktop` | The Electron app: React 19, TypeScript, Tailwind 4, shadcn/ui on Base UI |
| `app/spikes` | Phase 0 technical prototypes, standalone npm packages outside the workspace |
| `website` | The website (Next.js) |
| `brand` | Themes, logo, app icons and boards, shared by the app and the website |

`app/PRODUCT.md` and `app/DESIGN.md` describe the product rules and the visual system; they apply to every interface change.

### Architecture

- `src/main`: windows, menus, dialogs; starts the host and hands it a MessagePort per window. Notifications and the Dock badge (`attention.ts`), `ladder://` links, Linear (`linear.ts`).
- `src/host`: the session host in a `utilityProcess`, with SQLite (`node:sqlite`), git checkpoints and diffs (`git.ts`, `workspace.ts`), files (`files.ts`), terminals with node-pty and headless xterm (`terminals.ts`), worktrees and ports (`worktrees.ts`), project configuration (`project-settings.ts`), GitHub through gh (`github.ts`), search (`search.ts`) and button prompts (`prompts.ts`). Agents share an interface in `agents/common.ts`: Claude Code in `claude/`, Codex on the App Server in `codex/`, ACP agents in `acp/`, reviews in `review.ts`.
- `src/shared/protocol.ts`: types and messages between the host and the interface.
- `src/renderer`: React; state comes from the host (`store/app-store.ts`), the chat is in `components/chat`, the inspector in `components/inspector`, terminals in `components/terminal` and `lib/terminal-registry.ts`.

User-facing text is English inside `t()` and `plural()` (`src/shared/i18n.ts`); Italian translations live in `src/shared/locales/it/`, keyed by the English sentence.

### Themes

- `brand/themes.json` is the source of the theme tokens; `brand/themes.css` is the reference for the variables.
- `pnpm --filter @ladder/desktop sync-brand` regenerates the files the app uses from the JSON and the SVGs in `brand/logo/svg/`: `themes.generated.css`, `src/shared/themes.generated.ts` and the logo paths.
- `node app/desktop/scripts/check-contrast.mjs` checks every theme's contrast: 4.5:1 for text, 3:1 for focus, control borders and indicators.

### Debugging

- The page exposes `window.__ladder` (`request`, `send`, `store`, `settings`).
- `LADDER_USER_DATA=<folder>` uses a separate data folder; `LADDER_WORKTREES=<folder>` moves the worktrees.
- `LADDER_LOCALE=en|it` sets the initial language of a new profile (after that, the saved one wins).
- `LADDER_EDITOR_TRACE=<file>` and `LADDER_NOTIFY_TRACE=<file>` record editor launches and notifications instead of performing them, for automated tests.
- `LADDER_GH=<executable>` replaces gh, `LADDER_LINEAR_API=<url>` the Linear API and `LADDER_PR_POLL_MS` the PR polling interval (90 s).
- `LADDER_CODEX=<binary>` picks the Codex to use; `LADDER_ACP_REGISTRY=<url>` replaces the ACP registry (development builds only).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

Ladder is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
