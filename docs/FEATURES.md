# Features

Everything Ladder does today, grouped by area. For a guided tour, see the [documentation](https://itsladder.dev/docs).

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
- Subagents started by the main agent (Claude's Agent/Task, Codex's `spawnAgent`) appear in an agent map with state, duration, model, tokens and tools.

**Agents working together**
- Hand a session off to another agent (`/handoff`, or "Hand off to…" in the session menu): the current agent writes a summary and the work continues in a linked session in the same folder; hand it back to resume the first one.
- `/advisor` and `/committee` ask one, or two to four, other agents for read-only advice on the work and the diff, shown as a card you can send to your agent. A plan can be opened as a document, commented line by line and implemented with any agent.
- Chat sessions get a Ladder MCP server with `list_agents`, `handoff` and `delegate` (plus the plan and session tools); `report_result` is there only when someone waits for the result (plan tasks, delegated tasks, sessions reached by a handoff). A delegation runs as a child session in the agent map; stop it, or after a restart resume or dismiss it. Preferred delegates per project in `[[agents.delegates]]`.
- When an agent reaches its plan limit, a card proposes another agent to continue with; a per-project setting can switch automatically. Optionally, another agent cross-reviews each turn with changes.

**Executable plans and the `ladder` command**
- Type `/plan <goal>` (or ask in your own words) and the agent proposes a plan (`propose_plan`) that shows as an editable card. Unlike an agent's own plan mode, Ladder runs it. After you approve it, each task runs in its own session in dependency order, with one writer at a time in the plan folder and parallel writing tasks in separate worktrees merged back.
- Stop points, review loop-backs, retry, reassign, skip and stop; plans recover after a restart and can be saved as templates.
- Agents can start, message and wait for other sessions (`ladder_list_sessions`, `ladder_start_session`, `ladder_send`, `ladder_wait`), never above their own permissions.
- The `ladder` command (`projects`, `ls`, `new`, `send`, `wait`, `attach`, `stop`) drives sessions from a terminal, over a local socket only your user can use. Install it from Settings → Data and system → Command line. Sessions started from the terminal or by another agent show where they came from.

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

**From your phone (coming soon)**
- A phone app for iPhone and Android, paired with your Mac by a QR code: approve requests, answer questions, start sessions and check plan limits; on iPhone, a Live Activity and a widget.
- Off until you turn it on. Messages travel end-to-end encrypted through a small relay ([`app/relay`](../app/relay)) that forwards them without being able to read them; you can run your own.
