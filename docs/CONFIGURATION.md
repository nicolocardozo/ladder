# Project configuration

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
auto_switch = "codex"    # continue with this agent when the plan limit is reached (off if absent)
cross_review = "codex"   # this agent reviews the diff after turns with changes (off if absent)

[[agents.delegates]]
name = "reviewer"
agent = "codex"
model = "gpt-6-luna"
effort = "high"
permission = "plan"
note = "Reviews and second opinions"

[prompts]
create_pr = ".ladder/prompts/pr.md"
fix       = ".ladder/prompts/fix.md"
```

- `[[run]]` actions become buttons in the toolbar and run in the session's terminal.
- `[[agents.delegates]]` lists the agents you prefer to delegate to: `name` and `agent` are required; `model`, `effort`, `permission` (`plan` by default, never above `permissions_max`) and `note` (up to 300 characters) are optional. `auto_switch` and `cross_review` are off unless set; with a project selected, Settings → New sessions writes them to `.ladder/settings.local.toml`.
- Each folder gets a block of ports in `LADDER_PORT`: 4100 for the first project, then 4200 and so on, with a separate block for each worktree.
- Worktrees are created in `~/Developer/.ladder/worktrees/<project>/<slug>` (or `~/.ladder/worktrees` if `~/Developer` doesn't exist) on a `ladder/<slug>` branch; folder and branch prefix can be changed in Settings.
- Prompt names are `create_pr`, `fix`, `conflicts`, `comments`, `issue`, `pull_request` and `review`, as a path or as the text itself. Variables: `{{branch}}`, `{{base}}`, `{{pr}}`, `{{checks}}`, `{{conflicts}}`, `{{comments}}`, `{{ref}}`, `{{title}}`, `{{url}}` and `{{body}}`; `create_pr` also gets `{{base_arg}}`, `{{title_file}}` and `{{body_file}}` (the title and description are passed as files, never pasted into a command).
